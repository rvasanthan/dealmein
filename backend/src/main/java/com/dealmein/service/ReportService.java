package com.dealmein.service;

import com.dealmein.config.AppProperties;
import com.dealmein.web.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class ReportService {
    private static final Set<String> REASONS = Set.of("EXPIRED", "WRONG_PRICE", "WRONG_LINK", "OTHER");
    private final JdbcClient jdbc;
    private final AppProperties props;
    private final AuditService audit;
    private final Map<String, Deque<Instant>> hits = new ConcurrentHashMap<>();

    public ReportService(JdbcClient jdbc, AppProperties props, AuditService audit) {
        this.jdbc = jdbc;
        this.props = props;
        this.audit = audit;
    }

    /** Sliding one-hour window per client; in-memory, so per-instance (documented limitation). */
    boolean allow(String clientKey) {
        Instant now = Instant.now();
        Deque<Instant> q = hits.computeIfAbsent(clientKey, k -> new ArrayDeque<>());
        synchronized (q) {
            while (!q.isEmpty() && q.peekFirst().isBefore(now.minus(Duration.ofHours(1)))) q.pollFirst();
            if (q.size() >= props.reportsPerHour()) return false;
            q.addLast(now);
            return true;
        }
    }

    public void submit(long dealId, String reason, String message, String clientIp) {
        if (!REASONS.contains(reason)) throw ApiException.badRequest("Unknown report reason.");
        String msg = message == null ? null : message.trim();
        if (msg != null && msg.length() > 1000) throw ApiException.badRequest("Message must be 1000 characters or fewer.");
        boolean visible = jdbc.sql("SELECT count(*) FROM deals WHERE id = :id AND published_at IS NOT NULL AND status IN ('PUBLISHED','EXPIRED')")
                .param("id", dealId).query(Long.class).single() > 0;
        if (!visible) throw ApiException.notFound("Deal not found.");
        String hash = hash(clientIp);
        if (!allow(hash)) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED",
                    "You've sent several reports recently. Please try again later.");
        }
        jdbc.sql("INSERT INTO visitor_reports (deal_id, reason, message, reporter_hash) VALUES (:d,:r,:m,:h)")
                .param("d", dealId).param("r", reason).param("m", msg == null || msg.isEmpty() ? null : msg).param("h", hash).update();
    }

    static String hash(String ip) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest((ip == null ? "" : ip).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d).substring(0, 32);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public List<Map<String, Object>> list(String status) {
        String where = status == null || status.isBlank() ? "" : " WHERE vr.status = :s";
        var stmt = jdbc.sql("SELECT vr.*, d.title AS deal_title FROM visitor_reports vr JOIN deals d ON d.id = vr.deal_id"
                + where + " ORDER BY vr.created_at DESC LIMIT 200");
        if (!where.isEmpty()) stmt = stmt.param("s", status);
        return stmt.query((rs, i) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getLong("id"));
            m.put("dealId", rs.getLong("deal_id"));
            m.put("dealTitle", rs.getString("deal_title"));
            m.put("reason", rs.getString("reason"));
            m.put("message", rs.getString("message"));
            m.put("status", rs.getString("status"));
            m.put("createdAt", rs.getObject("created_at", java.time.OffsetDateTime.class));
            m.put("resolvedBy", rs.getString("resolved_by"));
            return m;
        }).list();
    }

    public void resolve(long id, String status, String actor) {
        if (!Set.of("RESOLVED", "DISMISSED").contains(status)) throw ApiException.badRequest("status must be RESOLVED or DISMISSED.");
        int n = jdbc.sql("UPDATE visitor_reports SET status = :s, resolved_by = :a, resolved_at = now() WHERE id = :id")
                .param("s", status).param("a", actor).param("id", id).update();
        if (n == 0) throw ApiException.notFound("Report not found.");
        audit.record(actor, "REPORT_" + status, "report", id, Map.of("status", status));
    }
}
