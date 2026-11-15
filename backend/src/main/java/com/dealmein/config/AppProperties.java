package com.dealmein.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

@ConfigurationProperties(prefix = "app")
public record AppProperties(
        String adminUsername,
        String adminPasswordHash,
        String jwtSecret,
        long tokenTtlMinutes,
        List<String> corsAllowedOrigins,
        String uploadDir,
        long maxUploadBytes,
        String defaultRetailerTimezone,
        int reportsPerHour,
        long maxImportBytes) {
}
