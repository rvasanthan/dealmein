package com.dealmein.importer;

import com.dealmein.util.Money;
import com.dealmein.util.UrlValidator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Reads a JSON snapshot (array, or an object holding an array under records/deals/offers/items/data).
 * Field names are resolved through alias lists below so the mapping can be adjusted in one place once the
 * real dataset's schema has been reviewed. Nothing is inferred: absent fields stay null.
 */
@Component
public class JsonDatasetAdapter implements ImportAdapter {
    static final Map<String, List<String>> ALIASES = new LinkedHashMap<>();
    static {
        ALIASES.put("id", List.of("id", "record_id", "recordId", "source_record_id", "offer_id", "deal_id"));
        ALIASES.put("title", List.of("title", "product_title", "product", "name", "product_name"));
        ALIASES.put("variant", List.of("variant", "variants", "variant_text", "options"));
        ALIASES.put("model", List.of("model", "model_number", "mpn", "sku"));
        ALIASES.put("condition", List.of("condition", "item_condition"));
        ALIASES.put("retailer", List.of("retailer", "store", "retailer_name", "merchant"));
        ALIASES.put("seller", List.of("seller", "sold_by"));
        ALIASES.put("category", List.of("category", "category_name", "department"));
        ALIASES.put("offerType", List.of("offer_type", "deal_type", "type"));
        ALIASES.put("sourcePrice", List.of("source_price", "reported_price", "price", "sale_price"));
        ALIASES.put("sourcePriceText", List.of("source_price_text", "price_text", "original_price_text", "price_raw"));
        ALIASES.put("listedCash", List.of("listed_cash_price", "cash_price", "listed_price"));
        ALIASES.put("conditions", List.of("conditions", "conditions_text", "terms", "notes", "price_conditions"));
        ALIASES.put("reward", List.of("reward_text", "rebate_text", "gift_card_text", "rewards"));
        ALIASES.put("rewardAmount", List.of("reward_amount", "rebate_amount", "gift_card_amount"));
        ALIASES.put("reference", List.of("reference_price", "advertised_reference_price", "original_price", "list_price", "was_price"));
        ALIASES.put("referenceText", List.of("reference_price_text"));
        ALIASES.put("start", List.of("start_date", "sale_start", "starts_on", "starts_at", "valid_from"));
        ALIASES.put("end", List.of("end_date", "sale_end", "ends_on", "ends_at", "expires", "valid_until"));
        ALIASES.put("dateText", List.of("date_text", "sale_dates", "dates", "original_date_text", "timing"));
        ALIASES.put("dateStatus", List.of("date_status"));
        ALIASES.put("collected", List.of("collected_at", "collected", "scraped_at", "captured_at"));
        ALIASES.put("verifiedAt", List.of("retailer_verified_at", "verified_at"));
        ALIASES.put("verification", List.of("verification_status", "verification", "verified"));
        ALIASES.put("flags", List.of("review_flags", "flags", "review_notes"));
        ALIASES.put("group", List.of("candidate_group", "candidate_group_id", "related_group", "group_id", "dedup_group", "duplicate_group"));
        ALIASES.put("productUrl", List.of("product_url", "retailer_url", "retailer_product_url"));
        ALIASES.put("sourceUrl", List.of("source_url", "source_link", "listing_url", "url", "link"));
        ALIASES.put("sourceName", List.of("source_name", "source", "publisher"));
        ALIASES.put("sourceRef", List.of("source_ref", "source_reference", "source_id"));
        ALIASES.put("sources", List.of("sources", "source_references"));
    }
    private static final Pattern CONTAINER_KEYS = Pattern.compile("records|deals|offers|items|data");

    private final ObjectMapper mapper;

    public JsonDatasetAdapter(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public String id() { return "json-snapshot"; }

    @Override
    public ParseResult parse(InputStream in) throws IOException {
        JsonNode root = mapper.readTree(in);
        JsonNode array = root;
        if (root != null && root.isObject()) {
            array = null;
            for (var it = root.fields(); it.hasNext(); ) {
                var e = it.next();
                if (CONTAINER_KEYS.matcher(e.getKey()).matches() && e.getValue().isArray()) { array = e.getValue(); break; }
            }
        }
        if (array == null || !array.isArray()) throw new IOException("Expected a JSON array of records (or an object containing one).");

        List<ImportRecord> out = new ArrayList<>();
        List<Issue> issues = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int row = 0;
        for (JsonNode n : array) {
            row++;
            if (!n.isObject()) { issues.add(Issue.error(row, null, "Row is not a JSON object.")); continue; }
            ImportRecord r = new ImportRecord();
            r.rowNumber = row;
            r.raw = n;
            r.sourceRecordId = text(n, "id");
            if (r.sourceRecordId == null) { issues.add(Issue.error(row, null, "Missing stable record id.")); continue; }
            if (!seen.add(r.sourceRecordId)) { issues.add(Issue.error(row, r.sourceRecordId, "Duplicate record id within this file.")); continue; }
            map(n, r, issues);
            if (r.title == null) { issues.add(Issue.error(row, r.sourceRecordId, "Missing product title.")); continue; }
            if (r.retailer == null) { issues.add(Issue.error(row, r.sourceRecordId, "Missing retailer.")); continue; }
            out.add(r);
        }
        return new ParseResult(out, issues, row);
    }

    private void map(JsonNode n, ImportRecord r, List<Issue> issues) {
        String id = r.sourceRecordId;
        int row = r.rowNumber;
        r.title = text(n, "title");
        r.variant = text(n, "variant");
        r.model = text(n, "model");
        r.retailer = text(n, "retailer");
        r.seller = text(n, "seller");
        r.category = text(n, "category");
        r.condition = condition(text(n, "condition"));
        String ot = text(n, "offerType");
        if (ot == null) {
            issues.add(Issue.warn(row, id, "No offer type in source; treated as a product deal."));
        } else if (ot.toLowerCase(Locale.ROOT).contains("store")) {
            r.offerType = "STOREWIDE";
        }

        r.sourcePriceText = text(n, "sourcePriceText");
        if (r.sourcePriceText == null) r.sourcePriceText = text(n, "sourcePrice");
        r.originalPriceText = r.sourcePriceText;
        r.sourcePrice = money(n, "sourcePrice", r, issues);
        r.listedCashPrice = money(n, "listedCash", r, issues);
        r.rewardAmount = money(n, "rewardAmount", r, issues);
        r.referencePrice = money(n, "reference", r, issues);
        r.referencePriceText = text(n, "referenceText");
        r.conditionsText = text(n, "conditions");
        r.rewardText = text(n, "reward");

        r.dateText = text(n, "dateText");
        parseDates(n, r, issues);
        r.collectedAt = instant(text(n, "collected"));
        r.retailerVerifiedAt = instant(text(n, "verifiedAt"));
        r.verificationStatus = text(n, "verification");
        r.candidateGroupKey = text(n, "group");

        String flags = first(n, "flags");
        JsonNode fn = node(n, "flags");
        if (fn != null && fn.isArray()) fn.forEach(x -> addFlag(r, x.asText()));
        else if (flags != null) Arrays.stream(flags.split("[;,|]")).forEach(x -> addFlag(r, x));

        String pu = text(n, "productUrl");
        if (pu != null) {
            String safe = UrlValidator.safeHttpUrl(pu);
            if (safe == null) issues.add(Issue.warn(row, id, "Product URL was not a valid http(s) link and was ignored."));
            else r.productUrl = safe;
        }

        JsonNode sn = node(n, "sources");
        if (sn != null && sn.isArray()) {
            int i = 0;
            for (JsonNode s : sn) {
                i++;
                String url = s.isTextual() ? s.asText() : textOf(s, "url", "link", "source_url");
                String name = s.isObject() ? textOf(s, "name", "source", "publisher") : null;
                String ref = s.isObject() ? textOf(s, "ref", "reference", "id") : null;
                addSource(r, name, url, ref != null ? ref : (url != null ? url : "source-" + i), r.collectedAt, issues);
            }
        }
        if (r.sources.isEmpty()) {
            String url = text(n, "sourceUrl");
            String ref = text(n, "sourceRef");
            addSource(r, text(n, "sourceName"), url, ref != null ? ref : (url != null ? url : "import:" + id), r.collectedAt, issues);
        }
    }

    private void addSource(ImportRecord r, String name, String url, String ref, OffsetDateTime at, List<Issue> issues) {
        String safe = url == null ? null : UrlValidator.safeHttpUrl(url);
        if (url != null && safe == null) issues.add(Issue.warn(r.rowNumber, r.sourceRecordId, "Source URL was not a valid http(s) link and was ignored."));
        r.sources.add(new ImportRecord.SourceRef(name, safe, ref, at));
    }

    private void addFlag(ImportRecord r, String f) {
        String s = f == null ? "" : f.trim().toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]+", "_").replaceAll("^_|_$", "");
        if (!s.isEmpty() && !r.reviewFlags.contains(s)) r.reviewFlags.add(s);
    }

    private void parseDates(JsonNode n, ImportRecord r, List<Issue> issues) {
        String s = text(n, "start");
        String e = text(n, "end");
        boolean bad = false;
        if (s != null) {
            Object v = temporal(s);
            if (v instanceof LocalDate d) r.startsOn = d; else if (v instanceof OffsetDateTime o) r.startsAt = o; else bad = true;
        }
        if (e != null) {
            Object v = temporal(e);
            if (v instanceof LocalDate d) r.endsOn = d; else if (v instanceof OffsetDateTime o) r.endsAt = o; else bad = true;
        }
        if (bad) {
            r.startsOn = null; r.endsOn = null; r.startsAt = null; r.endsAt = null;
            addFlag(r, "DATES_UNCLEAR");
            issues.add(Issue.warn(r.rowNumber, r.sourceRecordId, "Date value(s) could not be parsed; kept original text only."));
        }
        boolean any = r.startsOn != null || r.endsOn != null || r.startsAt != null || r.endsAt != null;
        boolean conflict = (r.startsOn != null && r.endsOn != null && r.startsOn.isAfter(r.endsOn))
                || (r.startsAt != null && r.endsAt != null && r.startsAt.isAfter(r.endsAt));
        String declared = text(n, "dateStatus");
        if (conflict || (declared != null && declared.equalsIgnoreCase("conflict"))) {
            r.dateStatus = "CONFLICT";
            addFlag(r, "DATES_CONFLICT");
        } else if (any && !(declared != null && declared.equalsIgnoreCase("unknown"))) {
            r.dateStatus = "KNOWN";
        } else {
            r.dateStatus = "UNKNOWN";
        }
    }

    private static Object temporal(String s) {
        try { return LocalDate.parse(s.trim()); } catch (Exception ignored) { }
        try { return OffsetDateTime.parse(s.trim()); } catch (Exception ignored) { }
        return null;
    }

    private static OffsetDateTime instant(String s) {
        if (s == null) return null;
        Object v = temporal(s);
        return v instanceof OffsetDateTime o ? o : null;
    }

    private BigDecimal money(JsonNode n, String key, ImportRecord r, List<Issue> issues) {
        String t = text(n, key);
        if (t == null) return null;
        try {
            return Money.parse(t);
        } catch (IllegalArgumentException ex) {
            addFlag(r, "PRICE_UNCLEAR");
            issues.add(Issue.warn(r.rowNumber, r.sourceRecordId, "Price '" + t + "' (" + key + ") is not a single unambiguous amount; left blank."));
            return null;
        }
    }

    private static String condition(String c) {
        if (c == null) return "UNKNOWN";
        String s = c.toLowerCase(Locale.ROOT);
        if (s.contains("refurb") || s.contains("renewed") || s.contains("open box")) return "REFURBISHED";
        if (s.contains("used") || s.contains("pre-owned")) return "USED";
        if (s.contains("new")) return "NEW";
        return "UNKNOWN";
    }

    private JsonNode node(JsonNode n, String key) {
        for (String a : ALIASES.get(key)) {
            JsonNode v = n.get(a);
            if (v != null && !v.isNull()) return v;
        }
        return null;
    }

    private String first(JsonNode n, String key) { return text(n, key); }

    private String text(JsonNode n, String key) {
        JsonNode v = node(n, key);
        if (v == null || v.isContainerNode()) return null;
        String s = v.asText().trim();
        return s.isEmpty() ? null : s;
    }

    private static String textOf(JsonNode n, String... keys) {
        for (String k : keys) {
            JsonNode v = n.get(k);
            if (v != null && v.isValueNode() && !v.asText().isBlank()) return v.asText().trim();
        }
        return null;
    }
}
