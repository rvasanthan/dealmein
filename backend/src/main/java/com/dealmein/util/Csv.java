package com.dealmein.util;

import java.util.Collection;
import java.util.stream.Collectors;

public final class Csv {
    private Csv() {}

    /** Neutralizes spreadsheet formula injection and quotes the cell. */
    public static String cell(Object value) {
        if (value == null) return "";
        String s = value.toString();
        if (!s.isEmpty()) {
            char c = s.charAt(0);
            if (c == '=' || c == '+' || c == '-' || c == '@' || c == '\t' || c == '\r') {
                s = "'" + s;
            }
        }
        return "\"" + s.replace("\"", "\"\"") + "\"";
    }

    public static String row(Collection<?> values) {
        return values.stream().map(Csv::cell).collect(Collectors.joining(",")) + "\r\n";
    }
}
