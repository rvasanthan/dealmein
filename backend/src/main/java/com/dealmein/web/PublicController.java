package com.dealmein.web;

import com.dealmein.service.DealQueryService;
import com.dealmein.service.ReportService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class PublicController {
    private final DealQueryService deals;
    private final ReportService reports;
    private final JdbcClient jdbc;

    public PublicController(DealQueryService deals, ReportService reports, JdbcClient jdbc) {
        this.deals = deals;
        this.reports = reports;
        this.jdbc = jdbc;
    }

    @GetMapping("/deals")
    public Map<String, Object> list(@RequestParam(required = false) String q,
                                    @RequestParam(required = false) String category,
                                    @RequestParam(required = false) String retailer,
                                    @RequestParam(required = false) String minPrice,
                                    @RequestParam(required = false) String maxPrice,
                                    @RequestParam(required = false) String timing,
                                    @RequestParam(required = false) String type,
                                    @RequestParam(required = false) String sort,
                                    @RequestParam(required = false) Integer page,
                                    @RequestParam(required = false) Integer size,
                                    @RequestParam(required = false) Boolean featured) {
        return deals.search(DealQueryService.parseFilters(q, category, retailer, minPrice, maxPrice, timing, type, sort, page, size, featured), null);
    }

    @GetMapping("/deals/{id}")
    public Map<String, Object> detail(@PathVariable long id) {
        return deals.findById(id, false).orElseThrow(() -> ApiException.notFound("This deal isn't available."));
    }

    /** Batch lookup used by Saved Deals; missing ids come back as unavailable. */
    @GetMapping("/deals/by-ids")
    public List<Map<String, Object>> byIds(@RequestParam String ids) {
        String[] parts = ids.split(",");
        if (parts.length > 100) throw ApiException.badRequest("Too many ids.");
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (String p : parts) {
            long id;
            try {
                id = Long.parseLong(p.trim());
            } catch (NumberFormatException e) {
                continue;
            }
            Map<String, Object> m = deals.findById(id, false).map(d -> {
                d.remove("related");
                d.remove("sources");
                return d;
            }).orElseGet(() -> new java.util.LinkedHashMap<>(Map.of("id", id, "unavailable", true)));
            out.add(m);
        }
        return out;
    }

    public record ReportRequest(@NotBlank String reason, @Size(max = 1000) String message) {}

    @PostMapping("/deals/{id}/reports")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> report(@PathVariable long id, @Valid @RequestBody ReportRequest body, HttpServletRequest req) {
        reports.submit(id, body.reason(), body.message(), req.getRemoteAddr());
        return Map.of("ok", true);
    }

    @GetMapping("/categories")
    public List<Map<String, Object>> categories() {
        return jdbc.sql("SELECT c.name, c.slug, count(d.id) FILTER (WHERE d.published_at IS NOT NULL AND d.status = 'PUBLISHED') AS deal_count "
                + "FROM categories c LEFT JOIN deals d ON d.category_id = c.id GROUP BY c.id ORDER BY c.sort_order")
                .query((rs, i) -> Map.<String, Object>of("name", rs.getString("name"), "slug", rs.getString("slug"),
                        "dealCount", rs.getLong("deal_count"))).list();
    }

    @GetMapping("/retailers")
    public List<Map<String, Object>> retailers() {
        return jdbc.sql("SELECT r.name, r.slug, count(d.id) FILTER (WHERE d.published_at IS NOT NULL AND d.status = 'PUBLISHED') AS deal_count "
                + "FROM retailers r LEFT JOIN deals d ON d.retailer_id = r.id GROUP BY r.id "
                + "HAVING count(d.id) FILTER (WHERE d.published_at IS NOT NULL AND d.status = 'PUBLISHED') > 0 ORDER BY r.name")
                .query((rs, i) -> Map.<String, Object>of("name", rs.getString("name"), "slug", rs.getString("slug"),
                        "dealCount", rs.getLong("deal_count"))).list();
    }
}
