package com.dealmein.service;

import com.dealmein.util.Csv;
import com.dealmein.util.Money;
import com.dealmein.util.UrlValidator;
import com.dealmein.web.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.*;

@Service
public class DealAdminService {
    private static final Logger log = LoggerFactory.getLogger(DealAdminService.class);

    enum Type { STRING, MONEY, DATE, INSTANT, URL, ENUM, CATEGORY }

    record Field(String column, Type type, int max, Set<String> values, boolean tracked) {}

    /** Whitelist of administrator-editable fields. "tracked" fields are protected from later re-imports. */
    private static final Map<String, Field> EDITABLE = new LinkedHashMap<>();
    static {
        str("title", "title", 300, true); str("variant", "variant", 300, true); str("model", "model", 120, true);
        str("seller", "seller", 200, true);
        EDITABLE.put("condition", new Field("condition_type", Type.ENUM, 0, Set.of("NEW", "USED", "REFURBISHED", "UNKNOWN"), true));
        EDITABLE.put("offerType", new Field("offer_type", Type.ENUM, 0, Set.of("PRODUCT", "STOREWIDE"), true));
        EDITABLE.put("category", new Field("category_id", Type.CATEGORY, 0, null, true));
        str("sourcePriceText", "source_price_text", 500, true); str("originalPriceText", "original_price_text", 500, true);
        str("conditionsText", "conditions_text", 2000, true); str("rewardText", "reward_text", 1000, true);
        str("taxNote", "tax_note", 500, false); str("referencePriceText", "reference_price_text", 500, true);
        str("dateText", "date_text", 500, true);
        money("listedCashPrice", "listed_cash_price", true); money("rewardAmount", "reward_amount", true);
        money("shippingCost", "shipping_cost", false); money("referencePrice", "reference_price", true);
        money("sourcePrice", "source_price", true);
        EDITABLE.put("startsOn", new Field("starts_on", Type.DATE, 0, null, true));
        EDITABLE.put("endsOn", new Field("ends_on", Type.DATE, 0, null, true));
        EDITABLE.put("startsAt", new Field("starts_at", Type.INSTANT, 0, null, true));
        EDITABLE.put("endsAt", new Field("ends_at", Type.INSTANT, 0, null, true));
        EDITABLE.put("dateStatus", new Field("date_status", Type.ENUM, 0, Set.of("KNOWN", "UNKNOWN", "CONFLICT"), true));
        EDITABLE.put("productUrl", new Field("product_url", Type.URL, 0, null, true));
        EDITABLE.put("imageUrl", new Field("image_url", Type.URL, 0, null, false));
    }

    private static void str(String k, String c, int max, boolean t) { EDITABLE.put(k, new Field(c, Type.STRING, max, null, t)); }
    private static void money(String k, String c, boolean t) { EDITABLE.put(k, new Field(c, Type.MONEY, 0, null, t)); }

    static final List<String> PRICE_FIELDS = List.of("listedCashPrice", "sourcePrice", "conditionsText", "rewardText", "rewardAmount", "referencePrice");
    static final List<String> COMPARE = List.of("title", "variant", "model", "seller", "condition", "offerType", "category", "retailer",
            "listedCashPrice", "sourcePrice", "sourcePriceText", "conditionsText", "rewardText", "rewardAmount", "referencePrice",
            "startsOn", "endsOn", "dateText", "productUrl");

    private final JdbcClient jdbc;
    private final DealQueryService query;
    private final AuditService audit;
    private final ObjectMapper mapper;
    private final TransactionTemplate tx;

    public DealAdminService(JdbcClient jdbc, DealQueryService query, AuditService audit, ObjectMapper mapper, TransactionTemplate tx) {
        this.jdbc = jdbc;
        this.query = query;
        this.audit = audit;
        this.mapper = mapper;
        this.tx = tx;
    }

    // ---------- edits ----------

    public Map<String, Object> edit(long id, JsonNode body, String actor) {
        if (body == null || !body.isObject() || body.isEmpty()) throw ApiException.badRequest("No changes supplied.");
        Map<String, Object> before = row(id);
        Map<String, Object> params = new HashMap<>();
        StringBuilder set = new StringBuilder("updated_at = now()");
        Map<String, Object> overrideMarks = new LinkedHashMap<>();
        Map<String, Object> changes = new LinkedHashMap<>();
        Map<String, String> errors = new LinkedHashMap<>();

        for (var it = body.fields(); it.hasNext(); ) {
            var e = it.next();
            String key = e.getKey();
            JsonNode v = e.getValue();
            if (key.equals("imageAuthorized") || key.equals("productUrlVerified")) continue;
            Field f = EDITABLE.get(key);
            if (f == null) { errors.put(key, "This field can't be edited."); continue; }
            try {
                Object val = coerce(f, v);
                params.put(f.column(), val);
                set.append(", ").append(f.column()).append(" = :").append(f.column());
                if (f.tracked()) overrideMarks.put(f.column(), true);
                changes.put(key, Map.of("from", String.valueOf(before.get(f.column())), "to", String.valueOf(val)));
            } catch (IllegalArgumentException ex) {
                errors.put(key, ex.getMessage());
            }
        }
        // Verification flags are explicit: changing a URL never silently verifies it.
        if (body.has("productUrl") || body.has("productUrlVerified")) {
            boolean verified = body.path("productUrlVerified").asBoolean(false);
            Object url = params.containsKey("product_url") ? params.get("product_url") : before.get("product_url");
            if (verified && url == null) errors.put("productUrlVerified", "Enter a product URL before marking it verified.");
            set.append(", product_url_verified = :puv");
            params.put("puv", verified && url != null);
            changes.put("productUrlVerified", Map.of("to", verified && url != null));
        }
        if (body.has("imageUrl") || body.has("imageAuthorized")) {
            boolean authorized = body.path("imageAuthorized").asBoolean(false);
            Object url = params.containsKey("image_url") ? params.get("image_url") : before.get("image_url");
            if (authorized && url == null) errors.put("imageAuthorized", "Add an image before confirming it is authorized.");
            set.append(", image_authorized = :ia");
            params.put("ia", authorized && url != null);
            changes.put("imageAuthorized", Map.of("to", authorized && url != null));
        }
        if (!errors.isEmpty()) {
            throw new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "VALIDATION_FAILED", "Some fields are invalid.", new LinkedHashMap<>(errors));
        }
        validateDates(before, params);
        if (!overrideMarks.isEmpty()) {
            set.append(", overrides = overrides || CAST(:ov AS jsonb)");
            params.put("ov", json(overrideMarks));
        }
        params.put("id", id);
        // Material edits to a published offer send it back for re-review.
        String stat = (String) before.get("status");
        if ("PUBLISHED".equals(stat) && changes.keySet().stream().anyMatch(k -> PRICE_FIELDS.contains(k) || k.equals("startsOn")
                || k.equals("endsOn") || k.equals("startsAt") || k.equals("endsAt") || k.equals("productUrl"))) {
            set.append(", status = 'DRAFT', published_at = NULL, featured = false");
            changes.put("status", Map.of("from", "PUBLISHED", "to", "DRAFT"));
        }
        jdbc.sql("UPDATE deals SET " + set + " WHERE id = :id").params(params).update();
        audit.record(actor, "DEAL_EDITED", "deal", id, Map.of("changes", changes));
        return query.findById(id, true).orElseThrow();
    }

    private void validateDates(Map<String, Object> before, Map<String, Object> params) {
        LocalDate s = (LocalDate) (params.containsKey("starts_on") ? params.get("starts_on") : toLocal(before.get("starts_on")));
        LocalDate e = (LocalDate) (params.containsKey("ends_on") ? params.get("ends_on") : toLocal(before.get("ends_on")));
        if (s != null && e != null && s.isAfter(e)) throw ApiException.badRequest("The start date is after the end date.");
    }

    private static LocalDate toLocal(Object o) { return o instanceof java.sql.Date d ? d.toLocalDate() : (LocalDate) o; }

    private Object coerce(Field f, JsonNode v) {
        boolean isNull = v == null || v.isNull() || (v.isTextual() && v.asText().isBlank());
        switch (f.type()) {
            case STRING -> {
                if (isNull) return null;
                String s = v.asText().trim();
                if (s.length() > f.max()) throw new IllegalArgumentException("Must be " + f.max() + " characters or fewer.");
                return s;
            }
            case MONEY -> {
                if (isNull) return null;
                BigDecimal b = Money.parse(v.asText());
                if (b.signum() < 0) throw new IllegalArgumentException("Must not be negative.");
                return b;
            }
            case DATE -> {
                if (isNull) return null;
                try { return LocalDate.parse(v.asText().trim()); } catch (Exception e) { throw new IllegalArgumentException("Use YYYY-MM-DD."); }
            }
            case INSTANT -> {
                if (isNull) return null;
                try { return OffsetDateTime.parse(v.asText().trim()); } catch (Exception e) { throw new IllegalArgumentException("Use an ISO timestamp with offset."); }
            }
            case URL -> {
                if (isNull) return null;
                String raw = v.asText().trim();
                if (raw.startsWith("/uploads/") && !raw.contains("..")) return raw;
                String u = UrlValidator.safeHttpUrl(raw);
                if (u == null) throw new IllegalArgumentException("Enter a full http:// or https:// address.");
                return u;
            }
            case ENUM -> {
                String s = isNull ? "" : v.asText().trim().toUpperCase(Locale.ROOT);
                if (!f.values().contains(s)) throw new IllegalArgumentException("Must be one of " + f.values());
                return s;
            }
            case CATEGORY -> {
                return jdbc.sql("SELECT id FROM categories WHERE slug = :s").param("s", v.asText()).query(Long.class).optional()
                        .orElseThrow(() -> new IllegalArgumentException("Unknown category."));
            }
        }
        throw new IllegalStateException();
    }

    // ---------- state changes ----------

    public record PublishChecklist(boolean identity, boolean link, boolean price, boolean conditions, boolean timing) {
        boolean complete() { return identity && link && price && conditions && timing; }
    }

    public Map<String, Object> publish(long id, PublishChecklist c, String actor) {
        if (c == null || !c.complete()) {
            throw ApiException.badRequest("Confirm that product identity, retailer link, price, conditions and timing have all been checked.");
        }
        Map<String, Object> d = query.findById(id, true).orElseThrow(() -> ApiException.notFound("Deal not found."));
        String status = (String) d.get("status");
        if (!"DRAFT".equals(status)) throw ApiException.conflict("Only draft offers can be published (current status: " + status + ").");
        if ("expired".equals(d.get("timing"))) throw ApiException.conflict("This offer's sale period has already ended. Correct the dates or archive it.");
        jdbc.sql("UPDATE deals SET status='PUBLISHED', published_at=now(), reviewed_at=now(), reviewed_by=:a, updated_at=now(), "
                        + "review_flags = array_remove(review_flags, 'MATERIAL_CHANGE') WHERE id=:id")
                .param("a", actor).param("id", id).update();
        audit.record(actor, "DEAL_PUBLISHED", "deal", id, Map.of("checklist", Map.of("identity", true, "link", true, "price", true,
                "conditions", true, "timing", true), "hadVerifiedProductLink", d.get("retailerLink") != null));
        return query.findById(id, true).orElseThrow();
    }

    public Map<String, Object> setStatus(long id, String target, String reason, String actor) {
        if (!Set.of("DRAFT", "EXPIRED", "ARCHIVED").contains(target)) {
            throw ApiException.badRequest("status must be DRAFT, EXPIRED or ARCHIVED. Use the publish action to publish.");
        }
        Map<String, Object> before = row(id);
        String from = (String) before.get("status");
        if (from.equals(target)) throw ApiException.conflict("The deal is already " + target + ".");
        if ("ARCHIVED".equals(from) && before.get("merged_into_id") != null && "DRAFT".equals(target)) {
            throw ApiException.conflict("Merged offers can't be restored.");
        }
        String archiveReason = "ARCHIVED".equals(target) ? (reason == null || reason.isBlank() ? "ARCHIVED" : reason.trim()) : null;
        if (archiveReason != null && archiveReason.length() > 200) throw ApiException.badRequest("Reason is too long.");
        jdbc.sql("UPDATE deals SET status=:s, archive_reason=:r, featured=false, published_at = CASE WHEN :s = 'EXPIRED' THEN published_at ELSE NULL END, updated_at=now() WHERE id=:id")
                .param("s", target).param("r", archiveReason).param("id", id).update();
        audit.record(actor, "DEAL_STATUS_CHANGED", "deal", id, Map.of("from", from, "to", target, "reason", String.valueOf(reason)));
        return query.findById(id, true).orElseThrow();
    }

    public Map<String, Object> setFeatured(long id, boolean featured, String actor) {
        Map<String, Object> before = row(id);
        if (featured && !"PUBLISHED".equals(before.get("status"))) throw ApiException.conflict("Only published offers can be featured.");
        jdbc.sql("UPDATE deals SET featured=:f, updated_at=now() WHERE id=:id").param("f", featured).param("id", id).update();
        audit.record(actor, featured ? "DEAL_FEATURED" : "DEAL_UNFEATURED", "deal", id, Map.of());
        return query.findById(id, true).orElseThrow();
    }

    public void attachUploadedImage(long id, String path, String actor) {
        row(id);
        jdbc.sql("UPDATE deals SET image_url=:u, image_authorized=false, updated_at=now() WHERE id=:id").param("u", path).param("id", id).update();
        audit.record(actor, "DEAL_IMAGE_UPLOADED", "deal", id, Map.of("path", path));
    }

    /** Runs every minute. Date-only windows use the retailer timezone; no timezone or unknown dates never auto-expire. */
    @Scheduled(fixedDelay = 60_000, initialDelay = 15_000)
    public void expireDue() {
        try {
            expireDueNow();
        } catch (RuntimeException e) {
            log.warn("Expiry sweep failed", e);
        }
    }

    public int expireDueNow() {
        List<Long> ids = jdbc.sql("UPDATE deals d SET status='EXPIRED', featured=false, updated_at=now() FROM retailers r "
                + "WHERE r.id = d.retailer_id AND d.status='PUBLISHED' AND d.date_status='KNOWN' AND "
                + DealQueryService.END_TS + " IS NOT NULL AND " + DealQueryService.END_TS + " <= now() RETURNING d.id").query(Long.class).list();
        ids.forEach(i -> audit.record("system", "DEAL_AUTO_EXPIRED", "deal", i, Map.of()));
        return ids.size();
    }

    // ---------- retailers ----------

    public Map<String, Object> setRetailerTimezone(long id, String tz) {
        String zone = null;
        if (tz != null && !tz.isBlank()) {
            try { zone = ZoneId.of(tz.trim()).getId(); } catch (Exception e) { throw ApiException.badRequest("Unknown timezone. Use an IANA name such as America/New_York."); }
        }
        int n = jdbc.sql("UPDATE retailers SET timezone=:z WHERE id=:id").param("z", zone).param("id", id).update();
        if (n == 0) throw ApiException.notFound("Retailer not found.");
        return Map.of("id", id, "timezone", String.valueOf(zone));
    }

    public List<Map<String, Object>> retailers() {
        return jdbc.sql("SELECT r.id, r.name, r.slug, r.timezone, (SELECT count(*) FROM deals d WHERE d.retailer_id = r.id) AS deals FROM retailers r ORDER BY r.name")
                .query((rs, i) -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("id", rs.getLong("id")); m.put("name", rs.getString("name")); m.put("slug", rs.getString("slug"));
                    m.put("timezone", rs.getString("timezone")); m.put("deals", rs.getLong("deals"));
                    return m;
                }).list();
    }

    public Map<String, Object> stats() {
        Map<String, Object> m = new LinkedHashMap<>();
        for (String s : List.of("DRAFT", "PUBLISHED", "EXPIRED", "ARCHIVED")) {
            m.put(s.toLowerCase(), jdbc.sql("SELECT count(*) FROM deals WHERE status = :s").param("s", s).query(Long.class).single());
        }
        m.put("openReports", jdbc.sql("SELECT count(*) FROM visitor_reports WHERE status = 'OPEN'").query(Long.class).single());
        return m;
    }

    // ---------- merge ----------

    public Map<String, Object> mergePreview(long primaryId, long secondaryId) {
        if (primaryId == secondaryId) throw ApiException.badRequest("Choose two different offers.");
        Map<String, Object> a = query.findById(primaryId, true).orElseThrow(() -> ApiException.notFound("Primary deal not found."));
        Map<String, Object> b = query.findById(secondaryId, true).orElseThrow(() -> ApiException.notFound("Secondary deal not found."));
        List<Map<String, Object>> diffs = new ArrayList<>();
        for (String f : COMPARE) {
            Object x = flat(a.get(f)), y = flat(b.get(f));
            if (!Objects.equals(x, y)) {
                diffs.add(Map.of("field", f, "primary", String.valueOf(x), "secondary", String.valueOf(y), "requiresChoice", PRICE_FIELDS.contains(f)));
            }
        }
        List<String> warnings = new ArrayList<>();
        Set<String> diffFields = new HashSet<>();
        diffs.forEach(d -> diffFields.add((String) d.get("field")));
        if (diffFields.contains("retailer")) warnings.add("These offers are from different retailers and should normally stay separate.");
        if (diffFields.contains("variant") || diffFields.contains("model")) warnings.add("Variant or model differs (size, width, color, capacity or pack quantity).");
        if (diffFields.contains("condition")) warnings.add("New, used and refurbished items should stay separate.");
        if (diffFields.contains("startsOn") || diffFields.contains("endsOn")) warnings.add("The sale periods differ.");
        if (diffFields.contains("conditionsText") || diffFields.contains("rewardText") || diffFields.contains("rewardAmount")) {
            warnings.add("Coupon, membership, gift-card or rebate conditions differ.");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("primary", a); out.put("secondary", b); out.put("differences", diffs); out.put("warnings", warnings);
        out.put("sourcesToMove", b.get("sources"));
        return out;
    }

    private static Object flat(Object o) {
        if (o instanceof Map<?, ?> m) return m.get("slug");
        return o;
    }

    public record MergeRequest(long primaryId, long secondaryId, Map<String, String> resolutions, boolean acknowledgeWarnings) {}

    public Map<String, Object> merge(MergeRequest req, String actor) {
        Map<String, Object> preview = mergePreview(req.primaryId(), req.secondaryId());
        @SuppressWarnings("unchecked") List<Map<String, Object>> diffs = (List<Map<String, Object>>) preview.get("differences");
        @SuppressWarnings("unchecked") List<String> warnings = (List<String>) preview.get("warnings");
        Map<String, String> res = req.resolutions() == null ? Map.of() : req.resolutions();
        for (Map<String, Object> d : diffs) {
            if (Boolean.TRUE.equals(d.get("requiresChoice")) && !res.containsKey(d.get("field"))) {
                throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "RESOLUTION_REQUIRED",
                        "Choose which value to keep for '" + d.get("field") + "'. Conflicting prices and conditions are never resolved automatically.");
            }
        }
        if (!warnings.isEmpty() && !req.acknowledgeWarnings()) {
            throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "WARNINGS_NOT_ACKNOWLEDGED",
                    "Acknowledge the merge warnings to continue.", Map.of("warnings", warnings));
        }
        for (var e : res.entrySet()) {
            if (!Set.of("primary", "secondary").contains(e.getValue())) throw ApiException.badRequest("Resolution must be 'primary' or 'secondary'.");
        }
        tx.executeWithoutResult(s -> {
            Map<String, Object> sec = row(req.secondaryId());
            Map<String, Object> set = new HashMap<>();
            StringBuilder sql = new StringBuilder("updated_at = now()");
            Map<String, Object> marks = new LinkedHashMap<>();
            for (var e : res.entrySet()) {
                Field f = EDITABLE.get(e.getKey());
                if (f == null || f.type() == Type.CATEGORY || !e.getValue().equals("secondary")) continue;
                sql.append(", ").append(f.column()).append(" = :").append(f.column());
                set.put(f.column(), sec.get(f.column()));
                marks.put(f.column(), true);
            }
            if (!marks.isEmpty()) {
                sql.append(", overrides = overrides || CAST(:ov AS jsonb)");
                set.put("ov", json(marks));
            }
            set.put("id", req.primaryId());
            jdbc.sql("UPDATE deals SET " + sql + " WHERE id = :id").params(set).update();
            jdbc.sql("UPDATE deal_sources SET deal_id = :p, source_ref = CASE WHEN EXISTS (SELECT 1 FROM deal_sources x WHERE x.deal_id = :p "
                            + "AND x.source_ref = deal_sources.source_ref) THEN source_ref || ' [merged from deal ' || :s || ']' ELSE source_ref END "
                            + "WHERE deal_id = :s").param("p", req.primaryId()).param("s", req.secondaryId()).update();
            jdbc.sql("UPDATE visitor_reports SET deal_id = :p WHERE deal_id = :s").param("p", req.primaryId()).param("s", req.secondaryId()).update();
            jdbc.sql("UPDATE deals SET status='ARCHIVED', archive_reason='MERGED', merged_into_id=:p, featured=false, published_at=NULL, updated_at=now() WHERE id=:s")
                    .param("p", req.primaryId()).param("s", req.secondaryId()).update();
            audit.record(actor, "DEALS_MERGED", "deal", req.primaryId(), Map.of("secondaryId", req.secondaryId(), "resolutions", res,
                    "differences", diffs, "warningsAcknowledged", warnings));
        });
        return query.findById(req.primaryId(), true).orElseThrow();
    }

    // ---------- export ----------

    public String exportCsv(DealQueryService.Filters base, DealQueryService.AdminFilters admin) {
        StringBuilder sb = new StringBuilder();
        sb.append(Csv.row(List.of("id", "source_record_id", "title", "variant", "retailer", "category", "status", "listed_cash_price",
                "source_price_text", "conditions", "dates", "timing", "product_url", "product_url_verified", "review_flags")));
        for (int page = 1; page <= 200; page++) {
            var f = new DealQueryService.Filters(base.q(), base.categories(), base.retailers(), base.minPrice(), base.maxPrice(),
                    base.timing(), base.type(), base.sort(), page, DealQueryService.MAX_PAGE_SIZE, base.featured());
            @SuppressWarnings("unchecked") List<Map<String, Object>> items = (List<Map<String, Object>>) query.search(f, admin).get("items");
            if (items.isEmpty()) break;
            for (Map<String, Object> d : items) {
                sb.append(Csv.row(Arrays.asList(d.get("id"), d.get("sourceRecordId"), d.get("title"), d.get("variant"),
                        ((Map<?, ?>) d.get("retailer")).get("name"), ((Map<?, ?>) d.get("category")).get("name"), d.get("status"),
                        d.get("listedCashPrice"), d.get("sourcePriceText"), d.get("conditionsText"), d.get("dateText"), d.get("timing"),
                        d.get("productUrl"), d.get("productUrlVerified"), String.join(";", (List<String>) d.get("reviewFlags")))));
            }
            if (items.size() < DealQueryService.MAX_PAGE_SIZE) break;
        }
        return sb.toString();
    }

    // ---------- helpers ----------

    private Map<String, Object> row(long id) {
        return jdbc.sql("SELECT d.*, r.name AS retailer_name FROM deals d JOIN retailers r ON r.id = d.retailer_id WHERE d.id = :id").param("id", id)
                .query().listOfRows().stream().findFirst().orElseThrow(() -> ApiException.notFound("Deal not found."));
    }

    private String json(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
