package com.dealmein.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

@Service
public class AuditService {
    private final JdbcClient jdbc;
    private final ObjectMapper mapper;

    public AuditService(JdbcClient jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    public void record(String actor, String action, String entityType, Object entityId, Object details) {
        String json;
        try {
            json = mapper.writeValueAsString(details == null ? Map.of() : details);
        } catch (JsonProcessingException e) {
            json = "{}";
        }
        jdbc.sql("INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details) VALUES (:a,:ac,:et,:ei,CAST(:d AS jsonb))")
                .param("a", actor).param("ac", action).param("et", entityType)
                .param("ei", entityId == null ? null : entityId.toString()).param("d", json).update();
    }

    public List<Map<String, Object>> list(String entityType, String entityId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT id, actor, action, entity_type, entity_id, details::text AS details, created_at FROM admin_audit_events WHERE 1=1");
        var stmt = new java.util.HashMap<String, Object>();
        if (entityType != null && !entityType.isBlank()) { sql.append(" AND entity_type = :et"); stmt.put("et", entityType); }
        if (entityId != null && !entityId.isBlank()) { sql.append(" AND entity_id = :ei"); stmt.put("ei", entityId); }
        sql.append(" ORDER BY created_at DESC, id DESC LIMIT :lim");
        stmt.put("lim", Math.min(Math.max(limit, 1), 200));
        return jdbc.sql(sql.toString()).params(stmt).query((rs, i) -> {
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("id", rs.getLong("id"));
            m.put("actor", rs.getString("actor"));
            m.put("action", rs.getString("action"));
            m.put("entityType", rs.getString("entity_type"));
            m.put("entityId", rs.getString("entity_id"));
            try {
                m.put("details", mapper.readValue(rs.getString("details"), Object.class));
            } catch (Exception e) {
                m.put("details", null);
            }
            m.put("createdAt", rs.getObject("created_at", java.time.OffsetDateTime.class));
            return m;
        }).list();
    }
}
