package com.dealmein.service;

import com.dealmein.config.AppProperties;
import com.dealmein.importer.ImportAdapter;
import com.dealmein.importer.ImportRecord;
import com.dealmein.web.ApiException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.math.BigDecimal;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.*;

/**
 * Idempotent snapshot import. Records are keyed by source_record_id; re-importing updates in place.
 *
 * Rules:
 *  - New records are always DRAFT.
 *  - Existing records keep their status (an expired/archived offer is never revived by an import).
 *  - Fields the administrator corrected (deals.overrides) are never overwritten, but the new import
 *    snapshot is still stored for provenance.
 *  - A material change (price, conditions, rewards, dates) adds MATERIAL_CHANGE and sends a PUBLISHED offer
 *    back to DRAFT for re-review.
 */
@Service
public class ImportService {
    static final List<String> FIELDS = List.of("title", "variant", "model", "condition_type", "seller", "offer_type",
            "source_price_text", "source_price", "listed_cash_price", "original_price_text", "conditions_text",
            "reward_text", "reward_amount", "reference_price", "reference_price_text", "starts_on", "ends_on",
            "starts_at", "ends_at", "date_text", "date_status", "collected_at", "retailer_verified_at",
            "source_verification_status", "candidate_group_key", "product_url");
    static final Set<String> MATERIAL = Set.of("source_price", "source_price_text", "listed_cash_price", "conditions_text",
            "reward_text", "reward_amount", "reference_price", "starts_on", "ends_on", "starts_at", "ends_at");
    static final int MAX_STORED_ISSUES = 5000;

    private final JdbcClient jdbc;
    private final ObjectMapper mapper;
    private final AppProperties props;
    private final AuditService audit;
    private final TransactionTemplate tx;
    private final Map<String, ImportAdapter> adapters = new HashMap<>();

    public ImportService(JdbcClient jdbc, ObjectMapper mapper, AppProperties props, AuditService audit,
                         TransactionTemplate tx, List<ImportAdapter> adapterList) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.props = props;
        this.audit = audit;
        this.tx = tx;
        adapterList.forEach(a -> adapters.put(a.id(), a));
    }

    record Outcome(int created, int updated, int unchanged) {}

    public Map<String, Object> preview(String filename, byte[] bytes, String actor) {
        if (bytes.length == 0) throw ApiException.badRequest("The uploaded file is empty.");
        if (bytes.length > props.maxImportBytes()) throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "FILE_TOO_LARGE", "Import file is too large.");
        ImportAdapter adapter = adapters.get("json-snapshot");
        ImportAdapter.ParseResult parsed;
        try {
            parsed = adapter.parse(new ByteArrayInputStream(bytes));
        } catch (Exception e) {
            throw ApiException.badRequest("Could not read the file as JSON: " + safeMsg(e));
        }
        Outcome o = classify(parsed.records());
        long jobId = tx.execute(s -> {
            long id = jdbc.sql("INSERT INTO import_jobs (filename, sha256, adapter, status, total_rows, created_count, updated_count, "
                            + "unchanged_count, failed_count, warning_count, payload, created_by) VALUES (:f,:h,:a,'PREVIEW',:t,:c,:u,:n,:fail,:w,:p,:by) RETURNING id")
                    .param("f", filename).param("h", sha256(bytes)).param("a", adapter.id()).param("t", parsed.totalRows())
                    .param("c", o.created).param("u", o.updated).param("n", o.unchanged)
                    .param("fail", count(parsed, "ERROR")).param("w", count(parsed, "WARNING"))
                    .param("p", bytes).param("by", actor).query(Long.class).single();
            storeIssues(id, parsed.issues());
            return id;
        });
        return get(jobId);
    }

    public Map<String, Object> commit(long jobId, String actor) {
        Map<String, Object> job = jdbc.sql("SELECT status, payload, adapter, filename FROM import_jobs WHERE id = :id")
                .param("id", jobId).query((rs, i) -> {
                    Map<String, Object> m = new HashMap<>();
                    m.put("status", rs.getString("status"));
                    m.put("payload", rs.getBytes("payload"));
                    m.put("adapter", rs.getString("adapter"));
                    m.put("filename", rs.getString("filename"));
                    return m;
                }).optional().orElseThrow(() -> ApiException.notFound("Import not found."));
        if (!"PREVIEW".equals(job.get("status"))) throw ApiException.conflict("This import has already been applied.");
        ImportAdapter adapter = adapters.get((String) job.get("adapter"));
        try {
            ImportAdapter.ParseResult parsed = adapter.parse(new ByteArrayInputStream((byte[]) job.get("payload")));
            Outcome o = tx.execute(s -> {
                int c = 0, u = 0, n = 0;
                for (ImportRecord r : parsed.records()) {
                    switch (apply(r, jobId)) {
                        case "created" -> c++;
                        case "updated" -> u++;
                        default -> n++;
                    }
                }
                return new Outcome(c, u, n);
            });
            jdbc.sql("UPDATE import_jobs SET status='COMPLETED', created_count=:c, updated_count=:u, unchanged_count=:n, "
                            + "completed_at=now(), payload=NULL WHERE id=:id")
                    .param("c", o.created).param("u", o.updated).param("n", o.unchanged).param("id", jobId).update();
            audit.record(actor, "IMPORT_COMMITTED", "import", jobId,
                    Map.of("created", o.created, "updated", o.updated, "unchanged", o.unchanged, "file", job.get("filename")));
        } catch (RuntimeException | java.io.IOException e) {
            jdbc.sql("UPDATE import_jobs SET status='FAILED', completed_at=now() WHERE id=:id").param("id", jobId).update();
            jdbc.sql("INSERT INTO import_row_issues (import_job_id,row_number,severity,message) VALUES (:j,0,'ERROR',:m)")
                    .param("j", jobId).param("m", "Import failed and was rolled back: " + safeMsg(e)).update();
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "IMPORT_FAILED", "The import failed and no records were changed.");
        }
        return get(jobId);
    }

    /** Applies one normalized record. Returns created | updated | unchanged. Package-visible for future adapters/tests. */
    String apply(ImportRecord r, long jobId) {
        long retailerId = retailerId(r.retailer);
        String[] cat = category(r);
        long categoryId = Long.parseLong(cat[0]);
        List<String> flags = new ArrayList<>(r.reviewFlags);
        if (cat[1] != null && !flags.contains(cat[1])) flags.add(cat[1]);

        Map<String, Object> cols = columns(r);
        Map<String, String> snapshot = snapshotOf(r, cols);

        Optional<Map<String, Object>> existing = jdbc.sql("SELECT id, status, overrides::text AS overrides, imported_snapshot::text AS snap, review_flags FROM deals WHERE source_record_id = :id")
                .param("id", r.sourceRecordId).query((rs, i) -> {
                    Map<String, Object> m = new HashMap<>();
                    m.put("id", rs.getLong("id"));
                    m.put("status", rs.getString("status"));
                    m.put("overrides", rs.getString("overrides"));
                    m.put("snap", rs.getString("snap"));
                    try {
                        m.put("flags", new ArrayList<>(Arrays.asList((String[]) rs.getArray("review_flags").getArray())));
                    } catch (java.sql.SQLException e) {
                        throw new IllegalStateException(e);
                    }
                    return m;
                }).optional();

        String snapJson = toJson(Map.of("normalized", snapshot, "raw", r.raw));
        String result;
        long dealId;
        if (existing.isEmpty()) {
            StringBuilder cn = new StringBuilder("source_record_id, retailer_id, category_id, review_flags, imported_snapshot, status");
            StringBuilder vn = new StringBuilder(":srid, :retailer, :category, CAST(:flags AS text[]), CAST(:snap AS jsonb), 'DRAFT'");
            Map<String, Object> p = new HashMap<>(cols);
            for (String f : FIELDS) { cn.append(", ").append(f); vn.append(", :").append(f); }
            p.put("srid", r.sourceRecordId); p.put("retailer", retailerId); p.put("category", categoryId);
            p.put("flags", pgArray(flags)); p.put("snap", snapJson);
            dealId = jdbc.sql("INSERT INTO deals (" + cn + ") VALUES (" + vn + ") RETURNING id").params(p).query(Long.class).single();
            result = "created";
        } else {
            Map<String, Object> ex = existing.get();
            dealId = (Long) ex.get("id");
            Map<String, Object> overrides = parse(ex.get("overrides"));
            Map<String, Object> prev = prevNormalized((String) ex.get("snap"));
            boolean same = prev != null && prev.equals(new HashMap<>(snapshot));
            if (same) {
                result = "unchanged";
            } else {
                boolean material = prev != null && MATERIAL.stream().anyMatch(f -> !Objects.equals(prev.get(f), snapshot.get(f)));
                Map<String, Object> p = new HashMap<>();
                StringBuilder set = new StringBuilder("imported_snapshot = CAST(:snap AS jsonb), updated_at = now()");
                p.put("snap", snapJson);
                for (String f : FIELDS) {
                    if (overrides.containsKey(f)) continue;
                    set.append(", ").append(f).append(" = :").append(f);
                    p.put(f, cols.get(f));
                }
                if (!overrides.containsKey("retailer_id")) { set.append(", retailer_id = :retailer"); p.put("retailer", retailerId); }
                if (!overrides.containsKey("category_id")) { set.append(", category_id = :category"); p.put("category", categoryId); }
                if (!overrides.containsKey("review_flags")) {
                    @SuppressWarnings("unchecked") List<String> old = (List<String>) ex.get("flags");
                    List<String> merged = new ArrayList<>(flags);
                    if (old.contains("MATERIAL_CHANGE") && !merged.contains("MATERIAL_CHANGE")) merged.add("MATERIAL_CHANGE");
                    if (material && !merged.contains("MATERIAL_CHANGE")) merged.add("MATERIAL_CHANGE");
                    set.append(", review_flags = CAST(:flags AS text[])");
                    p.put("flags", pgArray(merged));
                } else if (material) {
                    set.append(", review_flags = array_append(array_remove(review_flags, 'MATERIAL_CHANGE'), 'MATERIAL_CHANGE')");
                }
                if (material && "PUBLISHED".equals(ex.get("status"))) set.append(", status = 'DRAFT', published_at = NULL");
                p.put("id", dealId);
                jdbc.sql("UPDATE deals SET " + set + " WHERE id = :id").params(p).update();
                result = "updated";
            }
        }
        for (ImportRecord.SourceRef s : r.sources) {
            jdbc.sql("INSERT INTO deal_sources (deal_id, source_name, source_url, source_ref, collected_at, import_job_id, raw, origin_record_id) "
                            + "VALUES (:d,:n,:u,:r,:c,:j,CAST(:raw AS jsonb),:o) ON CONFLICT (deal_id, source_ref) DO UPDATE SET "
                            + "source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url, collected_at = EXCLUDED.collected_at, "
                            + "import_job_id = EXCLUDED.import_job_id, raw = EXCLUDED.raw")
                    .param("d", dealId).param("n", s.name()).param("u", s.url()).param("r", s.ref()).param("c", s.collectedAt())
                    .param("j", jobId).param("raw", toJson(r.raw)).param("o", r.sourceRecordId).update();
        }
        return result;
    }

    private Map<String, Object> columns(ImportRecord r) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("title", r.title); c.put("variant", r.variant); c.put("model", r.model);
        c.put("condition_type", r.condition); c.put("seller", r.seller); c.put("offer_type", r.offerType);
        c.put("source_price_text", r.sourcePriceText); c.put("source_price", r.sourcePrice);
        c.put("listed_cash_price", r.listedCashPrice); c.put("original_price_text", r.originalPriceText);
        c.put("conditions_text", r.conditionsText); c.put("reward_text", r.rewardText);
        c.put("reward_amount", r.rewardAmount); c.put("reference_price", r.referencePrice);
        c.put("reference_price_text", r.referencePriceText);
        c.put("starts_on", r.startsOn); c.put("ends_on", r.endsOn); c.put("starts_at", r.startsAt); c.put("ends_at", r.endsAt);
        c.put("date_text", r.dateText); c.put("date_status", r.dateStatus);
        c.put("collected_at", r.collectedAt); c.put("retailer_verified_at", r.retailerVerifiedAt);
        c.put("source_verification_status", r.verificationStatus); c.put("candidate_group_key", r.candidateGroupKey);
        c.put("product_url", r.productUrl);
        return c;
    }

    /** Null values are omitted so the stored JSON and a fresh snapshot compare equal. */
    private static Map<String, String> snapshotOf(ImportRecord r, Map<String, Object> cols) {
        Map<String, String> s = new TreeMap<>();
        cols.forEach((k, v) -> { if (v != null) s.put(k, v.toString()); });
        if (r.retailer != null) s.put("retailer", r.retailer);
        if (r.category != null) s.put("category", r.category);
        if (!r.reviewFlags.isEmpty()) s.put("review_flags", String.join(",", r.reviewFlags));
        return s;
    }

    private Outcome classify(List<ImportRecord> records) {
        int c = 0, u = 0, n = 0;
        for (ImportRecord r : records) {
            Optional<String> snap = jdbc.sql("SELECT imported_snapshot::text FROM deals WHERE source_record_id = :id")
                    .param("id", r.sourceRecordId).query(String.class).optional();
            if (snap.isEmpty()) { c++; continue; }
            Map<String, Object> cols = columns(r);
            Map<String, String> s = snapshotOf(r, cols);
            Map<String, Object> prev = prevNormalized(snap.get());
            if (prev != null && prev.equals(new HashMap<String, Object>(s))) n++; else u++;
        }
        return new Outcome(c, u, n);
    }

    private Map<String, Object> prevNormalized(String snapJson) {
        if (snapJson == null) return null;
        Map<String, Object> m = parse(snapJson);
        Object n = m.get("normalized");
        @SuppressWarnings("unchecked") Map<String, Object> out = n instanceof Map ? new HashMap<>((Map<String, Object>) n) : null;
        return out;
    }

    private Map<String, Object> parse(Object json) {
        try {
            return mapper.readValue(json == null ? "{}" : json.toString(), new TypeReference<>() {});
        } catch (Exception e) {
            return new HashMap<>();
        }
    }

    private String toJson(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String pgArray(List<String> flags) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (String f : flags) {
            if (!f.matches("[A-Z0-9_]+")) continue;
            if (!first) sb.append(',');
            sb.append(f);
            first = false;
        }
        return sb.append('}').toString();
    }

    long retailerId(String name) {
        String slug = slug(name);
        return jdbc.sql("INSERT INTO retailers (name, slug, timezone) VALUES (:n,:s,:tz) "
                        + "ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id")
                .param("n", name).param("s", slug).param("tz", props.defaultRetailerTimezone()).query(Long.class).single();
    }

    /** Returns {categoryId, flagOrNull}. Unmatched categories fall back to Other with a review flag. */
    private String[] category(ImportRecord r) {
        if (r.category != null) {
            Optional<Long> id = jdbc.sql("SELECT id FROM categories WHERE lower(name) = lower(:c) OR slug = :s")
                    .param("c", r.category).param("s", slug(r.category)).query(Long.class).optional();
            if (id.isPresent()) return new String[]{id.get().toString(), null};
        }
        long other = jdbc.sql("SELECT id FROM categories WHERE slug = 'other'").query(Long.class).single();
        return new String[]{Long.toString(other), "CATEGORY_UNMATCHED"};
    }

    static String slug(String s) {
        String n = Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}", "").toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-").replaceAll("^-|-$", "");
        return n.isEmpty() ? "unknown" : n;
    }

    private void storeIssues(long jobId, List<ImportAdapter.Issue> issues) {
        int i = 0;
        for (ImportAdapter.Issue is : issues) {
            if (i++ >= MAX_STORED_ISSUES) break;
            jdbc.sql("INSERT INTO import_row_issues (import_job_id,row_number,source_record_id,severity,message) VALUES (:j,:r,:s,:sev,:m)")
                    .param("j", jobId).param("r", is.row()).param("s", is.sourceRecordId()).param("sev", is.severity()).param("m", is.message()).update();
        }
    }

    private static int count(ImportAdapter.ParseResult p, String sev) {
        return (int) p.issues().stream().filter(i -> i.severity().equals(sev)).count();
    }

    private static String sha256(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String safeMsg(Exception e) {
        String m = e.getMessage();
        if (m == null) return e.getClass().getSimpleName();
        return m.length() > 200 ? m.substring(0, 200) : m;
    }

    public Map<String, Object> get(long id) {
        return jdbc.sql("SELECT id, filename, sha256, adapter, status, total_rows, created_count, updated_count, unchanged_count, failed_count, "
                        + "warning_count, created_by, created_at, completed_at FROM import_jobs WHERE id = :id").param("id", id)
                .query((rs, i) -> job(rs)).optional().orElseThrow(() -> ApiException.notFound("Import not found."));
    }

    public List<Map<String, Object>> history() {
        return jdbc.sql("SELECT id, filename, sha256, adapter, status, total_rows, created_count, updated_count, unchanged_count, failed_count, "
                + "warning_count, created_by, created_at, completed_at FROM import_jobs ORDER BY id DESC LIMIT 100").query((rs, i) -> job(rs)).list();
    }

    private Map<String, Object> job(java.sql.ResultSet rs) throws java.sql.SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getLong("id"));
        m.put("filename", rs.getString("filename"));
        m.put("sha256", rs.getString("sha256"));
        m.put("adapter", rs.getString("adapter"));
        m.put("status", rs.getString("status"));
        m.put("totalRows", rs.getInt("total_rows"));
        m.put("created", rs.getInt("created_count"));
        m.put("updated", rs.getInt("updated_count"));
        m.put("unchanged", rs.getInt("unchanged_count"));
        m.put("failed", rs.getInt("failed_count"));
        m.put("warnings", rs.getInt("warning_count"));
        m.put("createdBy", rs.getString("created_by"));
        m.put("createdAt", rs.getObject("created_at", java.time.OffsetDateTime.class));
        m.put("completedAt", rs.getObject("completed_at", java.time.OffsetDateTime.class));
        return m;
    }

    public List<Map<String, Object>> issues(long jobId, String severity, int limit, int offset) {
        String where = severity == null || severity.isBlank() ? "" : " AND severity = :sev";
        var st = jdbc.sql("SELECT row_number, source_record_id, severity, message FROM import_row_issues WHERE import_job_id = :j" + where
                + " ORDER BY row_number, id LIMIT :l OFFSET :o").param("j", jobId).param("l", Math.min(limit, 500)).param("o", offset);
        if (!where.isEmpty()) st = st.param("sev", severity);
        return st.query((rs, i) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("row", rs.getInt("row_number"));
            m.put("sourceRecordId", rs.getString("source_record_id"));
            m.put("severity", rs.getString("severity"));
            m.put("message", rs.getString("message"));
            return m;
        }).list();
    }
}
