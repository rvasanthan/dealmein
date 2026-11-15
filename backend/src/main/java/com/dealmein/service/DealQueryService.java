package com.dealmein.service;

import com.dealmein.util.Money;
import com.dealmein.util.UrlValidator;
import com.dealmein.web.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.*;

/**
 * Read side for deals. One query path serves the public site (published only) and the
 * administrator preview/queue (any status), so browsing behaves identically in both.
 *
 * Date rule (documented in README): date-only windows are interpreted in the retailer's configured
 * timezone. A window starts at 00:00 on starts_on and ends at the first instant of the day AFTER ends_on
 * (i.e. ends_on is inclusive). Without a timezone, or with unknown/conflicting dates, timing is "unknown".
 */
@Service
public class DealQueryService {
    public static final int MAX_PAGE_SIZE = 48;

    static final String START_TS = "COALESCE(d.starts_at, CASE WHEN d.starts_on IS NOT NULL AND r.timezone IS NOT NULL "
            + "THEN (d.starts_on::timestamp AT TIME ZONE r.timezone) END)";
    static final String END_TS = "COALESCE(d.ends_at, CASE WHEN d.ends_on IS NOT NULL AND r.timezone IS NOT NULL "
            + "THEN ((d.ends_on + 1)::timestamp AT TIME ZONE r.timezone) END)";
    static final String TIMING = "CASE "
            + "WHEN d.status = 'EXPIRED' THEN 'expired' "
            + "WHEN d.date_status <> 'KNOWN' THEN 'unknown' "
            + "WHEN d.starts_at IS NULL AND d.starts_on IS NULL AND d.ends_at IS NULL AND d.ends_on IS NULL THEN 'unknown' "
            + "WHEN r.timezone IS NULL AND ((d.ends_on IS NOT NULL AND d.ends_at IS NULL) OR (d.starts_on IS NOT NULL AND d.starts_at IS NULL)) THEN 'unknown' "
            + "WHEN " + END_TS + " IS NOT NULL AND " + END_TS + " <= now() THEN 'expired' "
            + "WHEN " + START_TS + " IS NOT NULL AND " + START_TS + " > now() THEN 'upcoming' "
            + "ELSE 'active' END";

    static final String BASE = "SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug, r.timezone AS retailer_timezone, "
            + "c.name AS category_name, c.slug AS category_slug, " + TIMING + " AS timing, " + END_TS + " AS end_ts, "
            + "(SELECT count(*) FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN') AS open_reports, "
            + "(SELECT count(*) FROM deals g WHERE d.candidate_group_key IS NOT NULL AND g.candidate_group_key = d.candidate_group_key "
            + "AND g.id <> d.id AND g.status <> 'ARCHIVED') AS group_size "
            + "FROM deals d JOIN retailers r ON r.id = d.retailer_id JOIN categories c ON c.id = d.category_id";

    private static final Map<String, String> NOTICES = Map.ofEntries(
            Map.entry("PRICE_UNCLEAR", "The price in the source wasn't clear, so no price is shown."),
            Map.entry("PRICE_AMBIGUOUS", "The price in the source wasn't clear, so no price is shown."),
            Map.entry("DATES_UNCLEAR", "Sale dates weren't clear in the source."),
            Map.entry("DATES_CONFLICT", "Sources disagree about the sale dates."),
            Map.entry("CONDITIONS_APPLY", "Coupons, memberships, rebates or gift cards may be required."),
            Map.entry("MATERIAL_CHANGE", "This offer changed since it was last reviewed."),
            Map.entry("CATEGORY_UNMATCHED", "The category was assigned automatically."));

    private final JdbcClient jdbc;
    private final ObjectMapper mapper;

    public DealQueryService(JdbcClient jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    public record Filters(String q, List<String> categories, List<String> retailers, BigDecimal minPrice,
                          BigDecimal maxPrice, List<String> timing, String type, String sort, int page, int size,
                          Boolean featured) {}

    public record AdminFilters(List<String> statuses, boolean missingLink, boolean unclearPrice, boolean staleDates,
                               boolean possibleDuplicates, boolean openReports) {}

    public static Filters parseFilters(String q, String category, String retailer, String minPrice, String maxPrice,
                                       String timing, String type, String sort, Integer page, Integer size, Boolean featured) {
        BigDecimal min = priceParam(minPrice, "minPrice");
        BigDecimal max = priceParam(maxPrice, "maxPrice");
        if (min != null && max != null && min.compareTo(max) > 0) {
            throw ApiException.badRequest("minPrice cannot be greater than maxPrice.");
        }
        List<String> timings = csv(timing).stream().map(String::toLowerCase).toList();
        for (String t : timings) {
            if (!Set.of("active", "upcoming", "expired", "unknown").contains(t)) {
                throw ApiException.badRequest("Unknown timing filter: " + t);
            }
        }
        String ty = type == null || type.isBlank() ? null : type.toUpperCase(Locale.ROOT);
        if (ty != null && !Set.of("PRODUCT", "STOREWIDE").contains(ty)) throw ApiException.badRequest("type must be PRODUCT or STOREWIDE.");
        String s = sort == null || sort.isBlank() ? (q != null && !q.isBlank() ? "relevance" : "newest") : sort;
        if (!Set.of("newest", "price_asc", "price_desc", "relevance").contains(s)) throw ApiException.badRequest("Unknown sort: " + s);
        int p = page == null ? 1 : Math.max(1, page);
        int sz = size == null ? 24 : Math.min(MAX_PAGE_SIZE, Math.max(1, size));
        String query = q == null ? null : q.trim();
        if (query != null && query.length() > 200) throw ApiException.badRequest("Search text is too long.");
        return new Filters(query == null || query.isEmpty() ? null : query, csv(category), csv(retailer), min, max,
                timings, ty, s, p, sz, featured);
    }

    private static BigDecimal priceParam(String v, String name) {
        if (v == null || v.isBlank()) return null;
        try {
            return Money.parse(v);
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(name + " must be a dollar amount like 49.99.");
        }
    }

    private static List<String> csv(String v) {
        if (v == null || v.isBlank()) return List.of();
        return Arrays.stream(v.split(",")).map(String::trim).filter(s -> !s.isEmpty()).limit(50).toList();
    }

    public Map<String, Object> search(Filters f, AdminFilters admin) {
        boolean isAdmin = admin != null;
        StringBuilder where = new StringBuilder(" WHERE 1=1");
        Map<String, Object> params = new HashMap<>();

        if (!isAdmin) {
            // Public visibility: published only (auto-expired offers stay viewable only when "expired" is requested).
            where.append(" AND x.published_at IS NOT NULL AND x.status IN ('PUBLISHED','EXPIRED')");
            if (f.timing().isEmpty()) where.append(" AND x.timing <> 'expired'");
        } else if (admin.statuses() != null && !admin.statuses().isEmpty()) {
            where.append(" AND x.status IN (:statuses)");
            params.put("statuses", admin.statuses());
        }
        if (!f.timing().isEmpty()) {
            where.append(" AND x.timing IN (:timing)");
            params.put("timing", f.timing());
        }
        if (f.q() != null) {
            where.append(" AND x.search_vector @@ websearch_to_tsquery('english', :q)");
            params.put("q", f.q());
        }
        if (!f.categories().isEmpty()) {
            where.append(" AND x.category_slug IN (:cats)");
            params.put("cats", f.categories());
        }
        if (!f.retailers().isEmpty()) {
            where.append(" AND x.retailer_slug IN (:rets)");
            params.put("rets", f.retailers());
        }
        if (f.minPrice() != null) {
            where.append(" AND x.listed_cash_price >= :minPrice");
            params.put("minPrice", f.minPrice());
        }
        if (f.maxPrice() != null) {
            where.append(" AND x.listed_cash_price <= :maxPrice");
            params.put("maxPrice", f.maxPrice());
        }
        if (f.type() != null) {
            where.append(" AND x.offer_type = :type");
            params.put("type", f.type());
        }
        if (f.featured() != null && f.featured()) where.append(" AND x.featured");
        if (isAdmin) {
            if (admin.missingLink()) where.append(" AND (x.product_url IS NULL OR NOT x.product_url_verified)");
            if (admin.unclearPrice()) where.append(" AND x.listed_cash_price IS NULL");
            if (admin.staleDates()) where.append(" AND x.status IN ('DRAFT','PUBLISHED') AND x.timing = 'expired'");
            if (admin.possibleDuplicates()) where.append(" AND x.group_size > 0");
            if (admin.openReports()) where.append(" AND x.open_reports > 0");
        }

        String order = switch (f.sort()) {
            case "price_asc" -> " ORDER BY x.listed_cash_price ASC NULLS LAST, x.id ASC";
            case "price_desc" -> " ORDER BY x.listed_cash_price DESC NULLS LAST, x.id ASC";
            case "relevance" -> f.q() != null
                    ? " ORDER BY ts_rank(x.search_vector, websearch_to_tsquery('english', :q)) DESC, x.id DESC"
                    : " ORDER BY COALESCE(x.collected_at, x.created_at) DESC, x.id DESC";
            default -> " ORDER BY COALESCE(x.collected_at, x.created_at) DESC, x.id DESC";
        };

        String from = " FROM (" + BASE + ") x";
        long total = jdbc.sql("SELECT count(*)" + from + where).params(params).query(Long.class).single();
        params.put("limit", f.size());
        params.put("offset", (long) (f.page() - 1) * f.size());
        List<Map<String, Object>> items = jdbc.sql("SELECT x.*" + from + where + order + " LIMIT :limit OFFSET :offset")
                .params(params).query((rs, i) -> toDto(rs, isAdmin)).list();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("page", f.page());
        out.put("size", f.size());
        out.put("total", total);
        out.put("totalPages", (int) Math.ceil(total / (double) f.size()));
        return out;
    }

    public Optional<Map<String, Object>> findById(long id, boolean isAdmin) {
        String vis = isAdmin ? "" : " AND x.published_at IS NOT NULL AND x.status IN ('PUBLISHED','EXPIRED')";
        Optional<Map<String, Object>> deal = jdbc.sql("SELECT x.* FROM (" + BASE + ") x WHERE x.id = :id" + vis)
                .param("id", id).query((rs, i) -> toDto(rs, isAdmin)).optional();
        deal.ifPresent(d -> {
            List<Map<String, Object>> src = sources(id, isAdmin);
            d.put("sources", src);
            d.put("listingLink", src.stream().map(x -> (String) x.get("url")).filter(Objects::nonNull).findFirst().orElse(null));
            d.put("related", related(id, isAdmin));
        });
        return deal;
    }

    List<Map<String, Object>> sources(long dealId, boolean isAdmin) {
        return jdbc.sql("SELECT * FROM deal_sources WHERE deal_id = :id ORDER BY id").param("id", dealId).query((rs, i) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", rs.getLong("id"));
            m.put("name", rs.getString("source_name"));
            m.put("url", UrlValidator.safeHttpUrl(rs.getString("source_url")));
            m.put("ref", rs.getString("source_ref"));
            m.put("collectedAt", odt(rs, "collected_at"));
            if (isAdmin) {
                m.put("originRecordId", rs.getString("origin_record_id"));
                m.put("raw", json(rs.getString("raw")));
            }
            return m;
        }).list();
    }

    /** Candidate groups are suggestions only; we list how each candidate differs instead of implying equivalence. */
    List<Map<String, Object>> related(long id, boolean isAdmin) {
        String vis = isAdmin ? " AND x.status <> 'ARCHIVED'"
                : " AND x.published_at IS NOT NULL AND x.status IN ('PUBLISHED','EXPIRED')";
        return jdbc.sql("SELECT x.* FROM (" + BASE + ") x WHERE x.id <> :id AND x.candidate_group_key IS NOT NULL AND x.candidate_group_key = "
                        + "(SELECT candidate_group_key FROM deals WHERE id = :id)" + vis + " ORDER BY x.id LIMIT 20")
                .param("id", id).query((rs, i) -> {
                    Map<String, Object> m = toDto(rs, isAdmin);
                    return m;
                }).list();
    }

    static String json(Object o) { return o == null ? null : o.toString(); }

    private Object json(String s) {
        if (s == null) return null;
        try {
            JsonNode n = mapper.readTree(s);
            return mapper.convertValue(n, Object.class);
        } catch (Exception e) {
            return null;
        }
    }

    static OffsetDateTime odt(ResultSet rs, String col) throws SQLException {
        return rs.getObject(col, OffsetDateTime.class);
    }

    private static BigDecimal dec(ResultSet rs, String col) throws SQLException {
        return rs.getBigDecimal(col);
    }

    private Map<String, Object> toDto(ResultSet rs, boolean isAdmin) throws SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", rs.getLong("id"));
        m.put("title", rs.getString("title"));
        m.put("variant", rs.getString("variant"));
        m.put("model", rs.getString("model"));
        m.put("condition", rs.getString("condition_type"));
        m.put("retailer", Map.of("name", rs.getString("retailer_name"), "slug", rs.getString("retailer_slug")));
        m.put("seller", rs.getString("seller"));
        m.put("category", Map.of("name", rs.getString("category_name"), "slug", rs.getString("category_slug")));
        m.put("offerType", rs.getString("offer_type"));

        BigDecimal price = dec(rs, "listed_cash_price");
        BigDecimal reference = dec(rs, "reference_price");
        m.put("listedCashPrice", price);
        m.put("sourcePriceText", rs.getString("source_price_text"));
        m.put("originalPriceText", rs.getString("original_price_text"));
        m.put("conditionsText", rs.getString("conditions_text"));
        m.put("rewardText", rs.getString("reward_text"));
        m.put("rewardAmount", dec(rs, "reward_amount"));
        m.put("shippingCost", dec(rs, "shipping_cost"));
        m.put("taxNote", rs.getString("tax_note"));
        m.put("referencePrice", reference);
        m.put("referencePriceText", rs.getString("reference_price_text"));
        m.put("discountPercent", Money.discountPercent(reference, price));

        m.put("startsOn", rs.getObject("starts_on", LocalDate.class));
        m.put("endsOn", rs.getObject("ends_on", LocalDate.class));
        m.put("startsAt", odt(rs, "starts_at"));
        m.put("endsAt", odt(rs, "ends_at"));
        m.put("dateText", rs.getString("date_text"));
        m.put("dateStatus", rs.getString("date_status"));
        m.put("timing", rs.getString("timing"));
        m.put("retailerTimezone", rs.getString("retailer_timezone"));

        m.put("collectedAt", odt(rs, "collected_at"));
        m.put("retailerVerifiedAt", odt(rs, "retailer_verified_at"));
        m.put("reviewedAt", odt(rs, "reviewed_at"));
        m.put("sourceVerificationStatus", rs.getString("source_verification_status"));

        String[] flags = (String[]) rs.getArray("review_flags").getArray();
        List<String> notices = new ArrayList<>();
        for (String f : flags) {
            String n = NOTICES.get(f);
            if (n != null && !notices.contains(n)) notices.add(n);
        }
        m.put("reviewNotices", notices);

        // Link rules: "Go to retailer" only for an administrator-verified product URL; otherwise fall back
        // to the publisher listing, which must never be presented as a retailer purchase link.
        String productUrl = UrlValidator.safeHttpUrl(rs.getString("product_url"));
        boolean verified = rs.getBoolean("product_url_verified");
        m.put("retailerLink", verified ? productUrl : null);
        String imageUrl = rs.getBoolean("image_authorized") ? safeImage(rs.getString("image_url")) : null;
        m.put("imageUrl", imageUrl);
        m.put("featured", rs.getBoolean("featured"));
        m.put("status", rs.getString("status"));
        m.put("relatedCount", rs.getLong("group_size"));

        if (isAdmin) {
            m.put("sourceRecordId", rs.getString("source_record_id"));
            m.put("reviewFlags", Arrays.asList(flags));
            m.put("candidateGroupKey", rs.getString("candidate_group_key"));
            m.put("productUrl", productUrl);
            m.put("productUrlVerified", verified);
            m.put("imageUrlRaw", rs.getString("image_url"));
            m.put("imageAuthorized", rs.getBoolean("image_authorized"));
            m.put("archiveReason", rs.getString("archive_reason"));
            m.put("mergedIntoId", rs.getObject("merged_into_id"));
            m.put("overrides", json(rs.getString("overrides")));
            m.put("importedSnapshot", json(rs.getString("imported_snapshot")));
            m.put("openReports", rs.getLong("open_reports"));
            m.put("publishedAt", odt(rs, "published_at"));
            m.put("reviewedBy", rs.getString("reviewed_by"));
            m.put("updatedAt", odt(rs, "updated_at"));
        }
        return m;
    }

    private static String safeImage(String url) {
        if (url == null) return null;
        if (url.startsWith("/uploads/") && !url.contains("..")) return url;
        return UrlValidator.safeHttpUrl(url);
    }
}
