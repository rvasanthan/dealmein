package com.dealmein.web;

import com.dealmein.config.AppProperties;
import com.dealmein.security.AdminAuthFilter;
import com.dealmein.security.AdminTokenService;
import com.dealmein.service.*;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
    private static final BCryptPasswordEncoder ENCODER = new BCryptPasswordEncoder();
    private static final int MAX_FAILED_LOGINS = 5;

    private final AppProperties props;
    private final AdminTokenService tokens;
    private final DealQueryService query;
    private final DealAdminService admin;
    private final ImportService imports;
    private final ReportService reports;
    private final AuditService audit;
    private final UploadService uploads;
    private final Map<String, Deque<Instant>> failures = new ConcurrentHashMap<>();

    public AdminController(AppProperties props, AdminTokenService tokens, DealQueryService query, DealAdminService admin,
                           ImportService imports, ReportService reports, AuditService audit, UploadService uploads) {
        this.props = props;
        this.tokens = tokens;
        this.query = query;
        this.admin = admin;
        this.imports = imports;
        this.reports = reports;
        this.audit = audit;
        this.uploads = uploads;
    }

    public record LoginRequest(@NotBlank String username, @NotBlank String password) {}

    @PostMapping("/login")
    public Map<String, Object> login(@Valid @RequestBody LoginRequest body, HttpServletRequest req) {
        String key = req.getRemoteAddr();
        Deque<Instant> q = failures.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (q) {
            while (!q.isEmpty() && q.peekFirst().isBefore(Instant.now().minus(Duration.ofMinutes(15)))) q.pollFirst();
            if (q.size() >= MAX_FAILED_LOGINS) {
                throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", "Too many failed sign-in attempts. Try again later.");
            }
        }
        String hash = props.adminPasswordHash();
        if (hash == null || hash.isBlank()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "ADMIN_NOT_CONFIGURED", "Administrator access has not been configured.");
        }
        boolean ok = ENCODER.matches(body.password(), hash) && props.adminUsername().equals(body.username());
        if (!ok) {
            synchronized (q) { q.addLast(Instant.now()); }
            throw new ApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Incorrect username or password.");
        }
        q.clear();
        audit.record(body.username(), "ADMIN_LOGIN", "session", null, Map.of());
        return Map.of("token", tokens.issue(body.username()), "username", body.username(), "expiresInMinutes", props.tokenTtlMinutes());
    }

    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest req) {
        return Map.of("username", actor(req));
    }

    @GetMapping("/stats")
    public Map<String, Object> stats() { return admin.stats(); }

    private static String actor(HttpServletRequest req) {
        return (String) req.getAttribute(AdminAuthFilter.ACTOR_ATTR);
    }

    // ----- deals -----

    @GetMapping("/deals")
    public Map<String, Object> deals(@RequestParam(required = false) String q, @RequestParam(required = false) String category,
                                     @RequestParam(required = false) String retailer, @RequestParam(required = false) String minPrice,
                                     @RequestParam(required = false) String maxPrice, @RequestParam(required = false) String timing,
                                     @RequestParam(required = false) String type, @RequestParam(required = false) String sort,
                                     @RequestParam(required = false) Integer page, @RequestParam(required = false) Integer size,
                                     @RequestParam(required = false) Boolean featured, @RequestParam(required = false) String status,
                                     @RequestParam(defaultValue = "false") boolean missingLink,
                                     @RequestParam(defaultValue = "false") boolean unclearPrice,
                                     @RequestParam(defaultValue = "false") boolean staleDates,
                                     @RequestParam(defaultValue = "false") boolean possibleDuplicates,
                                     @RequestParam(defaultValue = "false") boolean openReports) {
        var f = DealQueryService.parseFilters(q, category, retailer, minPrice, maxPrice, timing, type, sort, page, size, featured);
        return query.search(f, adminFilters(status, missingLink, unclearPrice, staleDates, possibleDuplicates, openReports));
    }

    private DealQueryService.AdminFilters adminFilters(String status, boolean missingLink, boolean unclearPrice, boolean staleDates,
                                                       boolean possibleDuplicates, boolean openReports) {
        List<String> statuses = status == null || status.isBlank() ? List.of()
                : Arrays.stream(status.split(",")).map(s -> s.trim().toUpperCase(Locale.ROOT)).toList();
        for (String s : statuses) {
            if (!Set.of("DRAFT", "PUBLISHED", "EXPIRED", "ARCHIVED").contains(s)) throw ApiException.badRequest("Unknown status: " + s);
        }
        return new DealQueryService.AdminFilters(statuses, missingLink, unclearPrice, staleDates, possibleDuplicates, openReports);
    }

    @GetMapping(value = "/deals/export.csv", produces = "text/csv")
    public ResponseEntity<byte[]> export(@RequestParam(required = false) String q, @RequestParam(required = false) String status,
                                         @RequestParam(defaultValue = "false") boolean missingLink,
                                         @RequestParam(defaultValue = "false") boolean unclearPrice,
                                         @RequestParam(defaultValue = "false") boolean staleDates,
                                         @RequestParam(defaultValue = "false") boolean possibleDuplicates,
                                         @RequestParam(defaultValue = "false") boolean openReports, HttpServletRequest req) {
        var f = DealQueryService.parseFilters(q, null, null, null, null, null, null, "newest", 1, 48, null);
        String csv = admin.exportCsv(f, adminFilters(status, missingLink, unclearPrice, staleDates, possibleDuplicates, openReports));
        audit.record(actor(req), "DEALS_EXPORTED", "deal", null, Map.of());
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"deal-me-in-deals.csv\"")
                .contentType(new MediaType("text", "csv", StandardCharsets.UTF_8)).body(csv.getBytes(StandardCharsets.UTF_8));
    }

    @GetMapping("/deals/merge-preview")
    public Map<String, Object> mergePreview(@RequestParam long primaryId, @RequestParam long secondaryId) {
        return admin.mergePreview(primaryId, secondaryId);
    }

    @PostMapping("/deals/merge")
    public Map<String, Object> merge(@RequestBody DealAdminService.MergeRequest body, HttpServletRequest req) {
        return admin.merge(body, actor(req));
    }

    @GetMapping("/deals/{id}")
    public Map<String, Object> deal(@PathVariable long id) {
        Map<String, Object> d = query.findById(id, true).orElseThrow(() -> ApiException.notFound("Deal not found."));
        d.put("audit", audit.list("deal", Long.toString(id), 50));
        return d;
    }

    @PatchMapping("/deals/{id}")
    public Map<String, Object> edit(@PathVariable long id, @RequestBody JsonNode body, HttpServletRequest req) {
        return admin.edit(id, body, actor(req));
    }

    @PostMapping("/deals/{id}/publish")
    public Map<String, Object> publish(@PathVariable long id, @RequestBody DealAdminService.PublishChecklist body, HttpServletRequest req) {
        return admin.publish(id, body, actor(req));
    }

    public record StatusRequest(@NotBlank String status, String reason) {}

    @PostMapping("/deals/{id}/status")
    public Map<String, Object> status(@PathVariable long id, @Valid @RequestBody StatusRequest body, HttpServletRequest req) {
        return admin.setStatus(id, body.status().toUpperCase(Locale.ROOT), body.reason(), actor(req));
    }

    public record FeaturedRequest(boolean featured) {}

    @PostMapping("/deals/{id}/featured")
    public Map<String, Object> featured(@PathVariable long id, @RequestBody FeaturedRequest body, HttpServletRequest req) {
        return admin.setFeatured(id, body.featured(), actor(req));
    }

    @PostMapping(value = "/deals/{id}/image", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> image(@PathVariable long id, @RequestParam("file") MultipartFile file, HttpServletRequest req) {
        String path = uploads.store(file);
        admin.attachUploadedImage(id, path, actor(req));
        return Map.of("imageUrl", path, "note", "Confirm the image is authorized before it will be shown publicly.");
    }

    // ----- imports -----

    @GetMapping("/imports")
    public List<Map<String, Object>> importHistory() { return imports.history(); }

    @GetMapping("/imports/{id}")
    public Map<String, Object> importJob(@PathVariable long id) { return imports.get(id); }

    @GetMapping("/imports/{id}/issues")
    public List<Map<String, Object>> importIssues(@PathVariable long id, @RequestParam(required = false) String severity,
                                                  @RequestParam(defaultValue = "100") int limit, @RequestParam(defaultValue = "0") int offset) {
        return imports.issues(id, severity, limit, Math.max(offset, 0));
    }

    @PostMapping(value = "/imports/preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> importPreview(@RequestParam("file") MultipartFile file, HttpServletRequest req) throws java.io.IOException {
        String name = file.getOriginalFilename() == null ? "upload.json" : file.getOriginalFilename().replaceAll("[^A-Za-z0-9._ -]", "_");
        return imports.preview(name, file.getBytes(), actor(req));
    }

    @PostMapping("/imports/{id}/commit")
    public Map<String, Object> importCommit(@PathVariable long id, HttpServletRequest req) {
        return imports.commit(id, actor(req));
    }

    // ----- reports, audit, retailers -----

    @GetMapping("/reports")
    public List<Map<String, Object>> reports(@RequestParam(required = false) String status) { return reports.list(status); }

    public record ResolveRequest(@NotBlank String status) {}

    @PostMapping("/reports/{id}/resolve")
    public Map<String, Object> resolve(@PathVariable long id, @Valid @RequestBody ResolveRequest body, HttpServletRequest req) {
        reports.resolve(id, body.status().toUpperCase(Locale.ROOT), actor(req));
        return Map.of("ok", true);
    }

    @GetMapping("/audit")
    public List<Map<String, Object>> auditLog(@RequestParam(required = false) String entityType, @RequestParam(required = false) String entityId,
                                              @RequestParam(defaultValue = "100") int limit) {
        return audit.list(entityType, entityId, limit);
    }

    @GetMapping("/retailers")
    public List<Map<String, Object>> retailers() { return admin.retailers(); }

    public record TimezoneRequest(String timezone) {}

    @PatchMapping("/retailers/{id}")
    public Map<String, Object> retailer(@PathVariable long id, @RequestBody TimezoneRequest body, HttpServletRequest req) {
        Map<String, Object> out = admin.setRetailerTimezone(id, body.timezone());
        audit.record(actor(req), "RETAILER_TIMEZONE_SET", "retailer", id, Map.of("timezone", String.valueOf(body.timezone())));
        return out;
    }
}
