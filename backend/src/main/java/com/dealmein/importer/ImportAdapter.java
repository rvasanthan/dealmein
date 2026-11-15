package com.dealmein.importer;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;

/**
 * Pluggable source of offers. The bundled implementation reads an uploaded JSON snapshot. Future authorized
 * affiliate feeds or retailer promotional APIs implement this same interface and return normalized records;
 * ImportService then applies them with the same idempotency, provenance and administrator-override rules.
 * No remote connectors ship in the MVP.
 */
public interface ImportAdapter {
    String id();

    ParseResult parse(InputStream in) throws IOException;

    record Issue(int row, String sourceRecordId, String severity, String message) {
        public static Issue error(int row, String id, String m) { return new Issue(row, id, "ERROR", m); }
        public static Issue warn(int row, String id, String m) { return new Issue(row, id, "WARNING", m); }
    }

    record ParseResult(List<ImportRecord> records, List<Issue> issues, int totalRows) {}
}
