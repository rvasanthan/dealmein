package com.dealmein;

import com.dealmein.service.DealAdminService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Runs against a real PostgreSQL (see README: TEST_DATABASE_URL). Uses a synthetic fixture, not the real dataset. */
@SpringBootTest
@AutoConfigureMockMvc
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ApiIntegrationTest {
    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/dealmein_test"));
        r.add("app.admin-password-hash", () -> new BCryptPasswordEncoder().encode("test-pass"));
        r.add("app.jwt-secret", () -> "0123456789abcdef0123456789abcdef-test");
        r.add("app.upload-dir", () -> System.getProperty("java.io.tmpdir") + "/dmi-test-uploads");
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper om;
    @Autowired JdbcTemplate jdbc;
    @Autowired DealAdminService adminService;
    static String token;
    static String fixture;

    @BeforeAll
    static void load() throws Exception {
        fixture = new String(new ClassPathResource("synthetic-fixture.json").getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    JsonNode json(MvcResult r) throws Exception { return om.readTree(r.getResponse().getContentAsString()); }

    JsonNode fetch(String url, boolean admin) throws Exception {
        var rb = MockMvcRequestBuilders.get(url);
        if (admin) rb.header("Authorization", "Bearer " + token);
        MvcResult r = mvc.perform(rb).andReturn();
        assertEquals(200, r.getResponse().getStatus(), url + " -> " + r.getResponse().getContentAsString());
        return json(r);
    }

    JsonNode send(org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder b, String body, int expected) throws Exception {
        b.header("Authorization", "Bearer " + token).contentType("application/json").content(body);
        MvcResult r = mvc.perform(b).andReturn();
        assertEquals(expected, r.getResponse().getStatus(), r.getResponse().getContentAsString());
        return json(r);
    }

    JsonNode importFile(String content) throws Exception {
        MvcResult p = mvc.perform(multipart("/api/admin/imports/preview")
                .file(new MockMultipartFile("file", "synthetic.json", "application/json", content.getBytes(StandardCharsets.UTF_8)))
                .header("Authorization", "Bearer " + token)).andReturn();
        assertEquals(200, p.getResponse().getStatus(), p.getResponse().getContentAsString());
        JsonNode preview = json(p);
        MvcResult c = mvc.perform(post("/api/admin/imports/" + preview.get("id").asLong() + "/commit").header("Authorization", "Bearer " + token)).andReturn();
        assertEquals(200, c.getResponse().getStatus(), c.getResponse().getContentAsString());
        return preview;
    }

    long idOf(String sourceId) { return jdbc.queryForObject("SELECT id FROM deals WHERE source_record_id = ?", Long.class, sourceId); }

    JsonNode publicList(String qs) throws Exception { return fetch("/api/deals" + qs, false); }

    List<String> titles(JsonNode page) {
        List<String> out = new ArrayList<>();
        page.get("items").forEach(i -> out.add(i.get("title").asText() + "|" + i.get("retailer").get("name").asText()));
        return out;
    }

    void publish(String sourceId) throws Exception {
        send(post("/api/admin/deals/" + idOf(sourceId) + "/publish"),
                "{\"identity\":true,\"link\":true,\"price\":true,\"conditions\":true,\"timing\":true}", 200);
    }

    @Test @Order(0)
    void setup() throws Exception {
        jdbc.execute("TRUNCATE deals, import_jobs, admin_audit_events, visitor_reports, retailers RESTART IDENTITY CASCADE");
        MvcResult r = mvc.perform(post("/api/admin/login").contentType("application/json")
                .content("{\"username\":\"admin\",\"password\":\"test-pass\"}")).andReturn();
        assertEquals(200, r.getResponse().getStatus());
        token = json(r).get("token").asText();
    }

    @Test @Order(1)
    void adminEndpointsRejectUnauthorizedRequests() throws Exception {
        for (String url : List.of("/api/admin/deals", "/api/admin/imports", "/api/admin/reports", "/api/admin/audit", "/api/admin/stats")) {
            mvc.perform(get(url)).andExpect(status().isUnauthorized());
            mvc.perform(get(url).header("Authorization", "Bearer garbage")).andExpect(status().isUnauthorized());
        }
        mvc.perform(post("/api/admin/deals/1/publish").contentType("application/json").content("{}")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/admin/login").contentType("application/json").content("{\"username\":\"admin\",\"password\":\"nope\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test @Order(2)
    void importCountsReconcileAndReimportDoesNotDuplicate() throws Exception {
        JsonNode first = importFile(fixture);
        assertEquals(11, first.get("totalRows").asInt());
        assertEquals(3, first.get("failed").asInt());
        assertEquals(8, first.get("created").asInt());
        assertEquals(8, (int) jdbc.queryForObject("SELECT count(*) FROM deals", Integer.class));
        assertEquals(8, (int) jdbc.queryForObject("SELECT count(*) FROM deals WHERE status='DRAFT'", Integer.class));

        JsonNode second = importFile(fixture);
        assertEquals(0, second.get("created").asInt());
        assertEquals(8, second.get("unchanged").asInt());
        assertEquals(8, (int) jdbc.queryForObject("SELECT count(*) FROM deals", Integer.class));
        // Source references are retained, one per source ref, not multiplied by re-imports.
        assertEquals(8, (int) jdbc.queryForObject("SELECT count(*) FROM deal_sources", Integer.class));

        JsonNode issues = fetch("/api/admin/imports/" + first.get("id").asLong() + "/issues?severity=ERROR", true);
        assertEquals(3, issues.size());
        assertEquals(2, fetch("/api/admin/imports", true).size());
    }

    @Test @Order(3)
    void draftsStayPrivateAndAdminPreviewShowsThem() throws Exception {
        assertEquals(0, publicList("").get("total").asInt());
        mvc.perform(get("/api/deals/" + idOf("T-001"))).andExpect(status().isNotFound());
        assertEquals(8, fetch("/api/admin/deals", true).get("total").asInt());
        assertEquals(8, fetch("/api/admin/deals?status=DRAFT", true).get("total").asInt());
        assertEquals(0, fetch("/api/admin/deals?status=PUBLISHED", true).get("total").asInt());
    }

    @Test @Order(4)
    void publishingRequiresAllConfirmationsAndNonExpiredDates() throws Exception {
        send(post("/api/admin/deals/" + idOf("T-001") + "/publish"), "{\"identity\":true,\"link\":true,\"price\":true,\"conditions\":true,\"timing\":false}", 400);
        send(post("/api/admin/deals/" + idOf("T-001") + "/publish"), "{}", 400);
        send(post("/api/admin/deals/" + idOf("T-004") + "/publish"),
                "{\"identity\":true,\"link\":true,\"price\":true,\"conditions\":true,\"timing\":true}", 409);
        for (String s : List.of("T-001", "T-002", "T-003", "T-005", "T-006", "T-007", "T-011")) publish(s);
        send(post("/api/admin/deals/" + idOf("T-001") + "/publish"),
                "{\"identity\":true,\"link\":true,\"price\":true,\"conditions\":true,\"timing\":true}", 409);
        assertNotNull(jdbc.queryForObject("SELECT reviewed_by FROM deals WHERE source_record_id='T-001'", String.class));
    }

    @Test @Order(5)
    void searchFiltersSortingAndPaginationCombineCorrectly() throws Exception {
        assertEquals(List.of("Test TV 55 inch|Best Buy", "Test TV 55 inch|Walmart").stream().sorted().toList(),
                titles(publicList("?q=tv")).stream().sorted().toList());
        assertEquals(List.of("Test TV 55 inch|Walmart"), titles(publicList("?q=tv&retailer=walmart")));
        assertEquals(List.of("Test TV 55 inch|Best Buy"), titles(publicList("?q=tv&minPrice=480")));
        assertEquals(0, publicList("?q=tv&category=shoes").get("total").asInt());
        // Searches relevant offer text, not only titles.
        assertEquals(1, publicList("?q=gift+card").get("total").asInt());

        // Unambiguous price filters exclude offers without a listed cash price.
        JsonNode priced = publicList("?minPrice=0");
        priced.get("items").forEach(i -> assertFalse(i.get("listedCashPrice").isNull(), i.get("title").asText()));
        assertEquals(0, publicList("?minPrice=0&q=sneakers").get("total").asInt());

        // Price sorting places unknown prices last and is stable.
        JsonNode asc = publicList("?sort=price_asc&timing=active,upcoming,unknown");
        List<String> ids = new ArrayList<>();
        boolean seenNull = false;
        for (JsonNode i : asc.get("items")) {
            boolean isNull = i.get("listedCashPrice").isNull();
            if (seenNull) assertTrue(isNull, "non-null price after null");
            seenNull |= isNull;
            ids.add(i.get("id").asText());
        }
        assertEquals(12.00, asc.get("items").get(0).get("listedCashPrice").asDouble(), 0.001);
        JsonNode desc = publicList("?sort=price_desc");
        assertEquals(499.99, desc.get("items").get(0).get("listedCashPrice").asDouble(), 0.001);
        assertEquals(asc.get("total").asInt(), ids.size());

        // Pagination is stable and exhaustive.
        List<String> paged = new ArrayList<>();
        for (int p = 1; p <= 4; p++) publicList("?sort=price_asc&size=2&page=" + p + "&timing=active,upcoming,unknown")
                .get("items").forEach(i -> paged.add(i.get("id").asText()));
        assertEquals(ids, paged);

        // Product deals vs storewide.
        assertEquals(1, publicList("?type=STOREWIDE").get("total").asInt());
        assertEquals(6, publicList("?type=PRODUCT&timing=active,upcoming,unknown").get("total").asInt());
        mvc.perform(get("/api/deals?minPrice=abc")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/deals?minPrice=10&maxPrice=5")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/deals?sort=bogus")).andExpect(status().isBadRequest());
    }

    @Test @Order(6)
    void timingFiltersFollowDocumentedRules() throws Exception {
        assertEquals(List.of("Future Drill|Home Depot"), titles(publicList("?timing=upcoming")));
        List<String> unknown = titles(publicList("?timing=unknown"));
        assertTrue(unknown.contains("Mystery Gadget|Best Buy"));
        assertTrue(unknown.contains("Conflicting Dates Toy|Target"), "conflicting dates are never active");
        assertTrue(unknown.contains("Storewide 20% off|Target"));
        List<String> active = titles(publicList("?timing=active"));
        assertTrue(active.contains("Test TV 55 inch|Best Buy"));
        assertFalse(active.contains("Mystery Gadget|Best Buy"));
        // Date-only end dates are inclusive in the retailer timezone: ends_on + 1 day at 00:00 local.
        Boolean boundary = jdbc.queryForObject("SELECT ((DATE '2025-11-28' + 1)::timestamp AT TIME ZONE 'America/New_York') = TIMESTAMPTZ '2025-11-29T05:00:00Z'", Boolean.class);
        assertTrue(boundary);
    }

    @Test @Order(7)
    void missingAndConditionalPricesAreNotInvented() throws Exception {
        JsonNode d = fetch("/api/deals/" + idOf("T-002"), false);
        assertTrue(d.get("listedCashPrice").isNull());
        assertEquals("$59.99 after $10 gift card", d.get("sourcePriceText").asText());
        assertTrue(d.get("reviewNotices").toString().contains("price"));
        assertTrue(d.get("discountPercent").isNull());
        assertFalse(d.has("reviewFlags"), "internal flags stay private");
        assertFalse(d.has("importedSnapshot"));
    }

    @Test @Order(8)
    void productLinksAreDistinguishedFromPublisherListings() throws Exception {
        JsonNode tv = fetch("/api/deals/" + idOf("T-001"), false);
        assertTrue(tv.get("retailerLink").isNull());
        assertEquals("https://publisher.example/tv", tv.get("listingLink").asText());

        JsonNode wm = fetch("/api/deals/" + idOf("T-011"), false);
        assertTrue(wm.get("retailerLink").isNull(), "an imported, unverified product URL is not shown as retailer link");
        assertTrue(wm.get("listingLink").isNull(), "javascript: source URL was dropped");

        send(patch("/api/admin/deals/" + idOf("T-011")), "{\"productUrl\":\"javascript:alert(1)\"}", 400);
        send(patch("/api/admin/deals/" + idOf("T-011")), "{\"productUrlVerified\":true}", 200); // existing imported URL gets verified
        wm = fetch("/api/admin/deals/" + idOf("T-011"), true);
        assertTrue(wm.get("productUrlVerified").asBoolean());
        assertEquals("https://walmart.example/tv55", wm.get("retailerLink").asText());
        assertEquals("PUBLISHED", wm.get("status").asText());
    }

    @Test @Order(9)
    void reimportPreservesAdminCorrectionsFlagsMaterialChangesAndNeverRevives() throws Exception {
        long tv = idOf("T-001");
        send(patch("/api/admin/deals/" + tv), "{\"title\":\"Corrected TV Title\",\"category\":\"home\"}", 200);
        long gadget = idOf("T-005");
        send(post("/api/admin/deals/" + gadget + "/status"), "{\"status\":\"ARCHIVED\",\"reason\":\"REJECTED\"}", 200);

        String changed = fixture.replace("\"price\":\"499.99\",\"listed_cash_price\":\"499.99\"", "\"price\":\"450.00\",\"listed_cash_price\":\"450.00\"")
                .replace("\"title\":\"Mystery Gadget\"", "\"title\":\"Mystery Gadget v2\"");
        JsonNode r = importFile(changed);
        assertEquals(2, r.get("updated").asInt());
        assertEquals(6, r.get("unchanged").asInt());

        JsonNode d = fetch("/api/admin/deals/" + tv, true);
        assertEquals("Corrected TV Title", d.get("title").asText(), "administrator correction survives re-import");
        assertEquals("home", d.get("category").get("slug").asText());
        assertEquals(450.00, d.get("listedCashPrice").asDouble(), 0.001, "non-overridden fields refresh");
        assertEquals("DRAFT", d.get("status").asText(), "published offer with a price change returns to review");
        assertTrue(d.get("reviewFlags").toString().contains("MATERIAL_CHANGE"));
        assertTrue(d.get("importedSnapshot").get("normalized").get("title").asText().equals("Test TV 55 inch"), "import snapshot preserved separately");
        assertTrue(d.get("audit").size() > 0);

        assertEquals("ARCHIVED", fetch("/api/admin/deals/" + gadget, true).get("status").asText(), "archived offers are not revived");
        mvc.perform(get("/api/deals/" + gadget)).andExpect(status().isNotFound());
    }

    @Test @Order(10)
    void mergeNeverResolvesConflictingPricesSilently() throws Exception {
        long a = idOf("T-001"), b = idOf("T-011");
        JsonNode prev = fetch("/api/admin/deals/merge-preview?primaryId=" + a + "&secondaryId=" + b, true);
        assertTrue(prev.get("differences").toString().contains("listedCashPrice"));
        assertTrue(prev.get("warnings").toString().contains("different retailers"));
        send(post("/api/admin/deals/merge"), "{\"primaryId\":" + a + ",\"secondaryId\":" + b + "}", 409);
        send(post("/api/admin/deals/merge"), "{\"primaryId\":" + a + ",\"secondaryId\":" + b
                + ",\"resolutions\":{\"listedCashPrice\":\"primary\",\"sourcePrice\":\"primary\",\"conditionsText\":\"primary\",\"rewardText\":\"primary\",\"rewardAmount\":\"primary\",\"referencePrice\":\"primary\"}}", 409);
        long sourcesBefore = jdbc.queryForObject("SELECT count(*) FROM deal_sources WHERE deal_id IN (?,?)", Long.class, a, b);
        send(post("/api/admin/deals/merge"), "{\"primaryId\":" + a + ",\"secondaryId\":" + b
                + ",\"acknowledgeWarnings\":true,\"resolutions\":{\"listedCashPrice\":\"primary\",\"sourcePrice\":\"primary\",\"conditionsText\":\"primary\",\"rewardText\":\"primary\",\"rewardAmount\":\"primary\",\"referencePrice\":\"primary\"}}", 200);
        assertEquals(sourcesBefore, jdbc.queryForObject("SELECT count(*) FROM deal_sources WHERE deal_id = ?", Long.class, a), "all sources kept");
        assertEquals("ARCHIVED", jdbc.queryForObject("SELECT status FROM deals WHERE id = ?", String.class, b));
        assertTrue(fetch("/api/admin/audit?entityType=deal", true).toString().contains("DEALS_MERGED"));
    }

    @Test @Order(11)
    void expirationAndFeaturing() throws Exception {
        long drill = idOf("T-006");
        send(post("/api/admin/deals/" + drill + "/featured"), "{\"featured\":true}", 200);
        assertEquals(1, publicList("?featured=true&timing=upcoming").get("total").asInt());
        long toy = idOf("T-007");
        send(post("/api/admin/deals/" + toy + "/featured"), "{\"featured\":true}", 200);

        // Known dates in the past expire automatically; unknown/conflicting never do.
        jdbc.update("UPDATE deals SET starts_on = DATE '2020-01-01', ends_on = DATE '2020-01-02' WHERE id = ?", drill);
        assertEquals(1, adminService.expireDueNow());
        assertEquals("EXPIRED", jdbc.queryForObject("SELECT status FROM deals WHERE id = ?", String.class, drill));
        assertEquals("PUBLISHED", jdbc.queryForObject("SELECT status FROM deals WHERE id = ?", String.class, toy));
        assertFalse(titles(publicList("")).contains("Future Drill|Home Depot"));
        assertTrue(titles(publicList("?timing=expired")).contains("Future Drill|Home Depot"));

        // No retailer timezone => date-only offers stay "unknown" and never auto-expire.
        jdbc.update("UPDATE retailers SET timezone = NULL WHERE slug = 'target'");
        jdbc.update("UPDATE deals SET date_status='KNOWN', starts_on=DATE '2020-01-01', ends_on=DATE '2020-01-02' WHERE id = ?", toy);
        assertEquals(0, adminService.expireDueNow());
        assertTrue(titles(publicList("?timing=unknown")).contains("Conflicting Dates Toy|Target"));
    }

    @Test @Order(12)
    void visitorReportsAreValidatedAndRateLimited() throws Exception {
        long id = idOf("T-002");
        mvc.perform(post("/api/deals/" + idOf("T-004") + "/reports").contentType("application/json").content("{\"reason\":\"EXPIRED\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(post("/api/deals/" + id + "/reports").contentType("application/json").content("{\"reason\":\"NOPE\"}"))
                .andExpect(status().isBadRequest());
        for (int i = 0; i < 5; i++) {
            mvc.perform(post("/api/deals/" + id + "/reports").contentType("application/json").content("{\"reason\":\"EXPIRED\",\"message\":\"ended\"}"))
                    .andExpect(status().isCreated());
        }
        MvcResult limited = mvc.perform(post("/api/deals/" + id + "/reports").contentType("application/json").content("{\"reason\":\"EXPIRED\"}")).andReturn();
        assertEquals(429, limited.getResponse().getStatus());
        assertEquals("RATE_LIMITED", json(limited).get("code").asText());
        JsonNode list = fetch("/api/admin/reports?status=OPEN", true);
        assertEquals(5, list.size());
        send(post("/api/admin/reports/" + list.get(0).get("id").asLong() + "/resolve"), "{\"status\":\"RESOLVED\"}", 200);
    }

    @Test @Order(13)
    void uploadsAreTypeAndSizeLimitedAndImagesNeedAuthorization() throws Exception {
        long id = idOf("T-002");
        MvcResult bad = mvc.perform(multipart("/api/admin/deals/" + id + "/image")
                .file(new MockMultipartFile("file", "x.png", "image/png", "<svg onload=alert(1)>".getBytes()))
                .header("Authorization", "Bearer " + token)).andReturn();
        assertEquals(415, bad.getResponse().getStatus());
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0};
        MvcResult ok = mvc.perform(multipart("/api/admin/deals/" + id + "/image").file(new MockMultipartFile("file", "x.png", "image/png", png))
                .header("Authorization", "Bearer " + token)).andReturn();
        assertEquals(200, ok.getResponse().getStatus());
        assertTrue(fetch("/api/deals/" + id, false).get("imageUrl") == null || fetch("/api/deals/" + id, false).get("imageUrl").isNull(), "unauthorized image hidden");
        send(patch("/api/admin/deals/" + id), "{\"imageAuthorized\":true}", 200);
        assertTrue(fetch("/api/deals/" + id, false).get("imageUrl").asText().startsWith("/uploads/"));
        MvcResult big = mvc.perform(multipart("/api/admin/deals/" + id + "/image")
                .file(new MockMultipartFile("file", "x.png", "image/png", new byte[3 * 1024 * 1024]))
                .header("Authorization", "Bearer " + token)).andReturn();
        assertEquals(413, big.getResponse().getStatus());
    }

    @Test @Order(14)
    void exportNeutralizesFormulas() throws Exception {
        long id = idOf("T-003");
        send(patch("/api/admin/deals/" + id), "{\"title\":\"=HYPERLINK(\\\"http://evil\\\")\"}", 200);
        MvcResult r = mvc.perform(get("/api/admin/deals/export.csv").header("Authorization", "Bearer " + token)).andReturn();
        String csv = r.getResponse().getContentAsString();
        assertTrue(csv.contains("\"'=HYPERLINK("), csv);
        mvc.perform(get("/api/admin/deals/export.csv")).andExpect(status().isUnauthorized());
    }

    @Test @Order(15)
    void errorsUseConsistentShape() throws Exception {
        MvcResult r = mvc.perform(get("/api/deals/999999")).andReturn();
        JsonNode e = json(r);
        assertEquals(404, e.get("status").asInt());
        assertEquals("NOT_FOUND", e.get("code").asText());
        assertTrue(e.has("message"));
    }
}
