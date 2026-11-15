package com.dealmein.security;

import com.dealmein.config.AppProperties;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Base64;
import java.util.Optional;

/** Minimal HMAC-signed bearer token: base64url(username|expiryEpoch).base64url(hmac). */
@Component
public class AdminTokenService {
    private final AppProperties props;

    public AdminTokenService(AppProperties props) {
        if (props.jwtSecret() == null || props.jwtSecret().length() < 32) {
            throw new IllegalStateException("APP_JWT_SECRET must be at least 32 characters");
        }
        this.props = props;
    }

    public String issue(String username) {
        long exp = Instant.now().plusSeconds(props.tokenTtlMinutes() * 60).getEpochSecond();
        String body = b64(username + "|" + exp);
        return body + "." + sign(body);
    }

    public Optional<String> verify(String token) {
        if (token == null) return Optional.empty();
        int dot = token.indexOf('.');
        if (dot < 1) return Optional.empty();
        String body = token.substring(0, dot);
        String sig = token.substring(dot + 1);
        if (!MessageDigest.isEqual(sign(body).getBytes(StandardCharsets.UTF_8), sig.getBytes(StandardCharsets.UTF_8))) {
            return Optional.empty();
        }
        try {
            String decoded = new String(Base64.getUrlDecoder().decode(body), StandardCharsets.UTF_8);
            int bar = decoded.lastIndexOf('|');
            long exp = Long.parseLong(decoded.substring(bar + 1));
            if (Instant.now().getEpochSecond() > exp) return Optional.empty();
            return Optional.of(decoded.substring(0, bar));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    private String sign(String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(props.jwtSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String b64(String s) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }
}
