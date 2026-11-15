package com.dealmein.util;

import java.net.URI;
import java.util.Locale;

public final class UrlValidator {
    private UrlValidator() {}

    /** Returns the normalized URL if it is an absolute http(s) URL with a host, else null. Never fetches it. */
    public static String safeHttpUrl(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || s.length() > 2048) return null;
        try {
            URI u = new URI(s);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (!(scheme.equals("http") || scheme.equals("https"))) return null;
            if (u.getHost() == null || u.getHost().isBlank() || u.getUserInfo() != null) return null;
            return u.toString();
        } catch (Exception e) {
            return null;
        }
    }
}
