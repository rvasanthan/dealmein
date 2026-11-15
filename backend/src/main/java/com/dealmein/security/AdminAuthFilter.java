package com.dealmein.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Optional;

/** Rejects every /api/admin/** request (except login and CORS preflight) without a valid bearer token. */
@Component
public class AdminAuthFilter extends OncePerRequestFilter {
    public static final String ACTOR_ATTR = "adminActor";
    private final AdminTokenService tokens;

    public AdminAuthFilter(AdminTokenService tokens) {
        this.tokens = tokens;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String path = req.getRequestURI();
        if (HttpMethod.OPTIONS.matches(req.getMethod()) || path.equals("/api/admin/login")) {
            chain.doFilter(req, res);
            return;
        }
        String header = req.getHeader("Authorization");
        Optional<String> actor = header != null && header.startsWith("Bearer ")
                ? tokens.verify(header.substring(7)) : Optional.empty();
        if (actor.isEmpty()) {
            res.setStatus(401);
            res.setContentType("application/json");
            res.getWriter().write("{\"status\":401,\"code\":\"UNAUTHORIZED\",\"message\":\"Administrator sign-in required.\"}");
            return;
        }
        req.setAttribute(ACTOR_ATTR, actor.get());
        chain.doFilter(req, res);
    }
}
