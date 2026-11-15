-- Deal Me In initial schema.
-- Imported source values live in the deal columns plus deals.imported_snapshot;
-- administrator corrections are tracked in deals.overrides so re-imports never clobber them.

CREATE TABLE retailers (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    -- IANA zone used to interpret date-only sale windows. NULL = unknown, so no auto-expiry.
    timezone    TEXT,
    website_url TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    sort_order INT NOT NULL DEFAULT 0
);

INSERT INTO categories (name, slug, sort_order) VALUES
    ('Electronics', 'electronics', 1),
    ('Clothing', 'clothing', 2),
    ('Shoes', 'shoes', 3),
    ('Home', 'home', 4),
    ('Kitchen', 'kitchen', 5),
    ('Appliances', 'appliances', 6),
    ('Beauty', 'beauty', 7),
    ('Toys', 'toys', 8),
    ('Sports', 'sports', 9),
    ('Tools', 'tools', 10),
    ('Groceries', 'groceries', 11),
    ('Other', 'other', 99);

CREATE TABLE deals (
    id                        BIGSERIAL PRIMARY KEY,
    source_record_id          TEXT NOT NULL UNIQUE,
    title                     TEXT NOT NULL,
    variant                   TEXT,
    model                     TEXT,
    condition_type            TEXT NOT NULL DEFAULT 'UNKNOWN'
                              CHECK (condition_type IN ('NEW','USED','REFURBISHED','UNKNOWN')),
    retailer_id               BIGINT NOT NULL REFERENCES retailers(id),
    seller                    TEXT,
    category_id               BIGINT NOT NULL REFERENCES categories(id),
    offer_type                TEXT NOT NULL DEFAULT 'PRODUCT' CHECK (offer_type IN ('PRODUCT','STOREWIDE')),

    -- Money: all USD, NULL means unknown (never zero).
    source_price_text         TEXT,
    source_price              NUMERIC(12,2),
    listed_cash_price         NUMERIC(12,2) CHECK (listed_cash_price IS NULL OR listed_cash_price >= 0),
    original_price_text       TEXT,
    conditions_text           TEXT,
    reward_text               TEXT,
    reward_amount             NUMERIC(12,2),
    shipping_cost             NUMERIC(12,2),
    tax_note                  TEXT,
    reference_price           NUMERIC(12,2),
    reference_price_text      TEXT,

    -- Timing. Date-only values stay date-only; instants are only set when the source gave exact times.
    starts_on                 DATE,
    ends_on                   DATE,
    starts_at                 TIMESTAMPTZ,
    ends_at                   TIMESTAMPTZ,
    date_text                 TEXT,
    date_status               TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (date_status IN ('KNOWN','UNKNOWN','CONFLICT')),

    collected_at              TIMESTAMPTZ,
    retailer_verified_at      TIMESTAMPTZ,
    source_verification_status TEXT,
    review_flags              TEXT[] NOT NULL DEFAULT '{}',
    candidate_group_key       TEXT,

    product_url               TEXT,
    product_url_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    image_url                 TEXT,
    image_authorized          BOOLEAN NOT NULL DEFAULT FALSE,

    status                    TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','EXPIRED','ARCHIVED')),
    archive_reason            TEXT,
    merged_into_id            BIGINT REFERENCES deals(id),
    featured                  BOOLEAN NOT NULL DEFAULT FALSE,
    published_at              TIMESTAMPTZ,
    reviewed_at               TIMESTAMPTZ,
    reviewed_by               TEXT,

    imported_snapshot         JSONB,
    overrides                 JSONB NOT NULL DEFAULT '{}'::jsonb,

    search_vector             TSVECTOR,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deals_search ON deals USING GIN (search_vector);
CREATE INDEX idx_deals_status ON deals (status);
CREATE INDEX idx_deals_status_category ON deals (status, category_id);
CREATE INDEX idx_deals_status_retailer ON deals (status, retailer_id);
CREATE INDEX idx_deals_price ON deals (listed_cash_price, id);
CREATE INDEX idx_deals_collected ON deals (collected_at DESC, id DESC);
CREATE INDEX idx_deals_featured ON deals (featured) WHERE featured;
CREATE INDEX idx_deals_group ON deals (candidate_group_key) WHERE candidate_group_key IS NOT NULL;
CREATE INDEX idx_deals_ends_on ON deals (ends_on);

CREATE FUNCTION deals_search_vector_update() RETURNS trigger AS $$
DECLARE
    retailer_name TEXT;
    category_name TEXT;
BEGIN
    SELECT name INTO retailer_name FROM retailers WHERE id = NEW.retailer_id;
    SELECT name INTO category_name FROM categories WHERE id = NEW.category_id;
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.model, '') || ' ' || coalesce(NEW.variant, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(retailer_name, '') || ' ' || coalesce(NEW.seller, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(category_name, '')), 'C') ||
        setweight(to_tsvector('english',
            coalesce(NEW.source_price_text, '') || ' ' || coalesce(NEW.original_price_text, '') || ' ' ||
            coalesce(NEW.conditions_text, '') || ' ' || coalesce(NEW.reward_text, '')), 'D');
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER deals_search_vector_trg
    BEFORE INSERT OR UPDATE ON deals
    FOR EACH ROW EXECUTE FUNCTION deals_search_vector_update();

CREATE TABLE import_jobs (
    id            BIGSERIAL PRIMARY KEY,
    filename      TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    adapter       TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('PREVIEW','COMPLETED','FAILED')),
    total_rows    INT NOT NULL DEFAULT 0,
    created_count INT NOT NULL DEFAULT 0,
    updated_count INT NOT NULL DEFAULT 0,
    unchanged_count INT NOT NULL DEFAULT 0,
    failed_count  INT NOT NULL DEFAULT 0,
    warning_count INT NOT NULL DEFAULT 0,
    payload       BYTEA,
    created_by    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ
);

CREATE TABLE import_row_issues (
    id               BIGSERIAL PRIMARY KEY,
    import_job_id    BIGINT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
    row_number       INT NOT NULL,
    source_record_id TEXT,
    severity         TEXT NOT NULL CHECK (severity IN ('ERROR','WARNING')),
    message          TEXT NOT NULL
);
CREATE INDEX idx_import_issues_job ON import_row_issues (import_job_id, row_number);

CREATE TABLE deal_sources (
    id            BIGSERIAL PRIMARY KEY,
    deal_id       BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    source_name   TEXT,
    source_url    TEXT,
    source_ref    TEXT NOT NULL,
    collected_at  TIMESTAMPTZ,
    import_job_id BIGINT REFERENCES import_jobs(id),
    raw           JSONB,
    origin_record_id TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (deal_id, source_ref)
);
CREATE INDEX idx_deal_sources_deal ON deal_sources (deal_id);

CREATE TABLE visitor_reports (
    id         BIGSERIAL PRIMARY KEY,
    deal_id    BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    reason     TEXT NOT NULL CHECK (reason IN ('EXPIRED','WRONG_PRICE','WRONG_LINK','OTHER')),
    message    TEXT,
    status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
    reporter_hash TEXT,
    resolved_by TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reports_status ON visitor_reports (status, created_at DESC);
CREATE INDEX idx_reports_deal ON visitor_reports (deal_id);

CREATE TABLE admin_audit_events (
    id          BIGSERIAL PRIMARY KEY,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT,
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON admin_audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_created ON admin_audit_events (created_at DESC);
