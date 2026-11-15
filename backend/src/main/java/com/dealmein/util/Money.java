package com.dealmein.util;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Decimal-safe USD helpers. Unknown stays null; nothing here ever returns zero for "unknown". */
public final class Money {
    private static final Pattern PLAIN = Pattern.compile("^\\$?\\s*(\\d{1,3}(,\\d{3})+|\\d+)(\\.\\d{1,2})?$");

    private Money() {}

    /** Parses "$1,299.99", "49.5", or a JSON number. Returns null when blank; throws on ambiguous text. */
    public static BigDecimal parse(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String s = raw.trim();
        Matcher m = PLAIN.matcher(s);
        if (!m.matches()) throw new IllegalArgumentException("Not an unambiguous USD amount: " + raw);
        return new BigDecimal(s.replace("$", "").replace(",", "").trim()).setScale(2, RoundingMode.UNNECESSARY);
    }

    /** Whole-percent discount only when both prices exist and the reference is strictly higher. */
    public static Integer discountPercent(BigDecimal reference, BigDecimal price) {
        if (reference == null || price == null || reference.signum() <= 0 || price.compareTo(reference) >= 0) return null;
        return reference.subtract(price).multiply(BigDecimal.valueOf(100))
                .divide(reference, 0, RoundingMode.DOWN).intValueExact();
    }
}
