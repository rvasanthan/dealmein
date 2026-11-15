package com.dealmein.importer;

import com.fasterxml.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

/** Normalized offer produced by any import adapter. Unknown values are null, never defaulted. */
public class ImportRecord {
    public int rowNumber;
    public String sourceRecordId;
    public String title;
    public String variant;
    public String model;
    public String condition = "UNKNOWN";
    public String retailer;
    public String seller;
    public String category;
    public String offerType = "PRODUCT";
    public String sourcePriceText;
    public BigDecimal sourcePrice;
    public BigDecimal listedCashPrice;
    public String originalPriceText;
    public String conditionsText;
    public String rewardText;
    public BigDecimal rewardAmount;
    public BigDecimal referencePrice;
    public String referencePriceText;
    public LocalDate startsOn;
    public LocalDate endsOn;
    public OffsetDateTime startsAt;
    public OffsetDateTime endsAt;
    public String dateText;
    public String dateStatus = "UNKNOWN";
    public OffsetDateTime collectedAt;
    public OffsetDateTime retailerVerifiedAt;
    public String verificationStatus;
    public List<String> reviewFlags = new ArrayList<>();
    public String candidateGroupKey;
    public String productUrl;
    public List<SourceRef> sources = new ArrayList<>();
    public JsonNode raw;

    public record SourceRef(String name, String url, String ref, OffsetDateTime collectedAt) {}
}
