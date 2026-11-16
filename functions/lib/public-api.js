"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_FROM = exports.TIMING = void 0;
exports.toDeal = toDeal;
exports.safeHttpUrl = safeHttpUrl;
exports.registerPublicApi = registerPublicApi;
const node_crypto_1 = require("node:crypto");
const START_TS = `COALESCE(d.starts_at, CASE WHEN d.starts_on IS NOT NULL AND r.timezone IS NOT NULL
  THEN (d.starts_on::timestamp AT TIME ZONE r.timezone) END)`;
const END_TS = `COALESCE(d.ends_at, CASE WHEN d.ends_on IS NOT NULL AND r.timezone IS NOT NULL
  THEN ((d.ends_on + 1)::timestamp AT TIME ZONE r.timezone) END)`;
exports.TIMING = `CASE
  WHEN d.status = 'EXPIRED' THEN 'expired'
  WHEN d.date_status <> 'KNOWN' THEN 'unknown'
  WHEN d.starts_at IS NULL AND d.starts_on IS NULL AND d.ends_at IS NULL AND d.ends_on IS NULL THEN 'unknown'
  WHEN r.timezone IS NULL AND ((d.ends_on IS NOT NULL AND d.ends_at IS NULL) OR (d.starts_on IS NOT NULL AND d.starts_at IS NULL)) THEN 'unknown'
  WHEN ${END_TS} IS NOT NULL AND ${END_TS} <= now() THEN 'expired'
  WHEN ${START_TS} IS NOT NULL AND ${START_TS} > now() THEN 'upcoming'
  ELSE 'active' END`;
exports.BASE_FROM = `FROM deals d
  JOIN retailers r ON r.id = d.retailer_id
  JOIN categories c ON c.id = d.category_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS related_count FROM deals g
    WHERE d.candidate_group_key IS NOT NULL AND g.candidate_group_key = d.candidate_group_key
      AND g.id <> d.id AND g.status <> 'ARCHIVED'
  ) related ON true`;
const NOTICES = {
    PRICE_UNCLEAR: "The price in the source wasn't clear, so no price is shown.",
    PRICE_AMBIGUOUS: "The price in the source wasn't clear, so no price is shown.",
    DATES_UNCLEAR: "Sale dates weren't clear in the source.",
    DATES_CONFLICT: 'Sources disagree about the sale dates.',
    CONDITIONS_APPLY: 'Coupons, memberships, rebates or gift cards may be required.',
    MATERIAL_CHANGE: 'This offer changed since it was last reviewed.',
    CATEGORY_UNMATCHED: 'The category was assigned automatically.',
};
const reportHits = new Map();
function value(req, key) {
    const raw = req.query[key];
    return typeof raw === 'string' ? raw : undefined;
}
function csv(raw) {
    return raw?.split(',').map((part) => part.trim()).filter(Boolean).slice(0, 50) ?? [];
}
function parsePrice(raw, field) {
    if (!raw?.trim())
        return undefined;
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw.trim())) {
        throw Object.assign(new Error(`${field} must be a dollar amount like 49.99.`), { status: 400, code: 'BAD_REQUEST' });
    }
    return Number(raw);
}
function apiError(message, status = 400) {
    return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' });
}
function toDeal(row) {
    const price = row.listed_cash_price === null ? null : Number(row.listed_cash_price);
    const reference = row.reference_price === null ? null : Number(row.reference_price);
    const image = row.image_authorized ? safeImage(row.image_url) : null;
    return {
        id: Number(row.id),
        title: row.title,
        variant: row.variant,
        model: row.model,
        condition: row.condition_type,
        retailer: { name: row.retailer_name, slug: row.retailer_slug },
        seller: row.seller,
        category: { name: row.category_name, slug: row.category_slug },
        offerType: row.offer_type,
        listedCashPrice: price,
        sourcePriceText: row.source_price_text,
        originalPriceText: row.original_price_text,
        conditionsText: row.conditions_text,
        rewardText: row.reward_text,
        rewardAmount: row.reward_amount === null ? null : Number(row.reward_amount),
        shippingCost: row.shipping_cost === null ? null : Number(row.shipping_cost),
        taxNote: row.tax_note,
        referencePrice: reference,
        referencePriceText: row.reference_price_text,
        discountPercent: reference !== null && price !== null && reference > 0
            ? Math.round((1 - price / reference) * 100)
            : null,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        dateText: row.date_text,
        dateStatus: row.date_status,
        timing: row.timing,
        retailerTimezone: row.retailer_timezone,
        collectedAt: row.collected_at,
        retailerVerifiedAt: row.retailer_verified_at,
        reviewedAt: row.reviewed_at,
        sourceVerificationStatus: row.source_verification_status,
        reviewNotices: [...new Set(row.review_flags.map((flag) => NOTICES[flag]).filter(Boolean))],
        retailerLink: row.product_url_verified ? safeHttpUrl(row.product_url) : null,
        imageUrl: image,
        featured: row.featured,
        status: row.status,
        relatedCount: Number(row.related_count),
    };
}
function safeHttpUrl(url) {
    if (!url)
        return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
    }
    catch {
        return null;
    }
}
function safeImage(url) {
    if (url?.startsWith('/uploads/') && !url.includes('..'))
        return url;
    return safeHttpUrl(url);
}
function registerPublicApi(app, getPool) {
    app.get('/api/categories', async (_req, res, next) => {
        try {
            const pool = await getPool();
            const result = await pool.query(`SELECT c.name, c.slug,
        count(d.id) FILTER (WHERE d.published_at IS NOT NULL AND d.status = 'PUBLISHED')::int AS deal_count
        FROM categories c LEFT JOIN deals d ON d.category_id = c.id
        GROUP BY c.id ORDER BY c.sort_order`);
            res.json(result.rows.map((row) => ({ name: row.name, slug: row.slug, dealCount: row.deal_count })));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/retailers', async (_req, res, next) => {
        try {
            const pool = await getPool();
            const result = await pool.query(`SELECT r.name, r.slug,
        count(d.id) FILTER (WHERE d.published_at IS NOT NULL AND d.status = 'PUBLISHED')::int AS deal_count
        FROM retailers r LEFT JOIN deals d ON d.retailer_id = r.id
        GROUP BY r.id HAVING count(d.id) FILTER (WHERE d.published_at IS NOT NULL AND d.status = 'PUBLISHED') > 0
        ORDER BY r.name`);
            res.json(result.rows.map((row) => ({ name: row.name, slug: row.slug, dealCount: row.deal_count })));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/deals', async (req, res, next) => {
        try {
            const pool = await getPool();
            const q = value(req, 'q')?.trim() || undefined;
            if (q && q.length > 200)
                throw apiError('Search text is too long.');
            const categories = csv(value(req, 'category'));
            const retailers = csv(value(req, 'retailer'));
            const timings = csv(value(req, 'timing')).map((item) => item.toLowerCase());
            if (timings.some((item) => !['active', 'upcoming', 'expired', 'unknown'].includes(item))) {
                throw apiError('Unknown timing filter.');
            }
            const minPrice = parsePrice(value(req, 'minPrice'), 'minPrice');
            const maxPrice = parsePrice(value(req, 'maxPrice'), 'maxPrice');
            if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
                throw apiError('minPrice cannot be greater than maxPrice.');
            }
            const type = value(req, 'type')?.toUpperCase();
            if (type && !['PRODUCT', 'STOREWIDE'].includes(type))
                throw apiError('type must be PRODUCT or STOREWIDE.');
            const requestedSort = value(req, 'sort');
            const sort = requestedSort || (q ? 'relevance' : 'newest');
            if (!['newest', 'price_asc', 'price_desc', 'relevance'].includes(sort))
                throw apiError('Unknown sort.');
            const page = Math.max(1, Number.parseInt(value(req, 'page') ?? '1', 10) || 1);
            const size = Math.min(48, Math.max(1, Number.parseInt(value(req, 'size') ?? '24', 10) || 24));
            const clauses = ["d.published_at IS NOT NULL", "d.status IN ('PUBLISHED','EXPIRED')"];
            const params = [];
            const bind = (v) => { params.push(v); return `$${params.length}`; };
            if (!timings.length)
                clauses.push(`(${exports.TIMING}) <> 'expired'`);
            else
                clauses.push(`${exports.TIMING} = ANY(${bind(timings)}::text[])`);
            if (q)
                clauses.push(`d.search_vector @@ websearch_to_tsquery('english', ${bind(q)})`);
            if (categories.length)
                clauses.push(`c.slug = ANY(${bind(categories)}::text[])`);
            if (retailers.length)
                clauses.push(`r.slug = ANY(${bind(retailers)}::text[])`);
            if (minPrice !== undefined)
                clauses.push(`d.listed_cash_price >= ${bind(minPrice)}`);
            if (maxPrice !== undefined)
                clauses.push(`d.listed_cash_price <= ${bind(maxPrice)}`);
            if (type)
                clauses.push(`d.offer_type = ${bind(type)}`);
            const where = `WHERE ${clauses.join(' AND ')}`;
            const from = `${exports.BASE_FROM} ${where}`;
            const count = await pool.query(`SELECT count(*)::int AS total ${from}`, params);
            const orderBy = sort === 'price_asc'
                ? 'd.listed_cash_price ASC NULLS LAST, d.id ASC'
                : sort === 'price_desc'
                    ? 'd.listed_cash_price DESC NULLS LAST, d.id ASC'
                    : sort === 'relevance' && q
                        ? `ts_rank(d.search_vector, websearch_to_tsquery('english', $${params.indexOf(q) + 1})) DESC, d.id DESC`
                        : 'COALESCE(d.collected_at, d.created_at) DESC, d.id DESC';
            const limitArg = bind(size);
            const offsetArg = bind((page - 1) * size);
            const result = await pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
        r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
        ${exports.TIMING} AS timing, (SELECT count(*) FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN')::int AS open_reports,
        related.related_count
        ${from}
        ORDER BY ${orderBy} LIMIT ${limitArg} OFFSET ${offsetArg}`, params);
            const total = Number(count.rows[0].total);
            res.json({
                items: result.rows.map(toDeal),
                page,
                size,
                total,
                totalPages: Math.ceil(total / size),
            });
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/deals/by-ids', async (req, res, next) => {
        try {
            const pool = await getPool();
            const rawIds = value(req, 'ids') ?? '';
            const parts = rawIds.split(',');
            if (parts.length > 100)
                throw apiError('Too many ids.');
            const ids = [...new Set(parts.map((part) => Number.parseInt(part.trim(), 10)).filter(Number.isSafeInteger))];
            if (!ids.length)
                return res.json([]);
            const result = await pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
        r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
        ${exports.TIMING} AS timing, (SELECT count(*) FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN')::int AS open_reports,
        related.related_count
        ${exports.BASE_FROM}
        WHERE d.id = ANY($1::bigint[]) AND d.published_at IS NOT NULL AND d.status IN ('PUBLISHED','EXPIRED')
        ORDER BY array_position($1::bigint[], d.id)`, [ids]);
            const found = new Map(result.rows.map((row) => [Number(row.id), toDeal(row)]));
            res.json(ids.map((id) => found.get(id) ?? { id, unavailable: true }));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/deals/:id', async (req, res, next) => {
        try {
            const pool = await getPool();
            const id = Number.parseInt(req.params.id, 10);
            if (!Number.isSafeInteger(id) || id < 1)
                throw apiError("This deal isn't available.", 404);
            const result = await pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
        r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
        ${exports.TIMING} AS timing, (SELECT count(*) FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN')::int AS open_reports,
        related.related_count
        ${exports.BASE_FROM}
        WHERE d.id = $1 AND d.published_at IS NOT NULL AND d.status IN ('PUBLISHED','EXPIRED')`, [id]);
            const deal = result.rows[0];
            if (!deal)
                throw apiError("This deal isn't available.", 404);
            const [sources, relatedResult] = await Promise.all([
                pool.query(`SELECT id, source_name, source_url, source_ref, collected_at
          FROM deal_sources WHERE deal_id = $1 ORDER BY id`, [id]),
                pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
          r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
          ${exports.TIMING} AS timing, (SELECT count(*) FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN')::int AS open_reports,
          related.related_count
          ${exports.BASE_FROM}
          WHERE d.id <> $1 AND d.candidate_group_key = $2 AND d.published_at IS NOT NULL
            AND d.status IN ('PUBLISHED','EXPIRED') ORDER BY d.id LIMIT 20`, [id, deal.candidate_group_key]),
            ]);
            const sourceDtos = sources.rows.map((source) => ({
                id: Number(source.id),
                name: source.source_name,
                url: safeHttpUrl(source.source_url),
                ref: source.source_ref,
                collectedAt: source.collected_at,
            }));
            res.json({
                ...toDeal(deal),
                sources: sourceDtos,
                listingLink: sourceDtos.find((source) => source.url)?.url ?? null,
                related: relatedResult.rows.map(toDeal),
            });
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/deals/:id/reports', async (req, res, next) => {
        try {
            const pool = await getPool();
            const id = Number.parseInt(req.params.id, 10);
            if (!Number.isSafeInteger(id) || id < 1)
                throw apiError('Deal not found.', 404);
            const reason = req.body?.reason;
            const message = typeof req.body?.message === 'string' ? req.body.message.trim() : null;
            if (!['EXPIRED', 'WRONG_PRICE', 'WRONG_LINK', 'OTHER'].includes(reason)) {
                throw apiError('Unknown report reason.');
            }
            if (message && message.length > 1000)
                throw apiError('Message must be 1000 characters or fewer.');
            const visible = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND published_at IS NOT NULL
        AND status IN ('PUBLISHED','EXPIRED')`, [id]);
            if (!visible.rowCount)
                throw apiError('Deal not found.', 404);
            const clientKey = (0, node_crypto_1.createHash)('sha256').update(req.ip ?? '').digest('hex').slice(0, 32);
            const now = Date.now();
            const recentHits = (reportHits.get(clientKey) ?? []).filter((hit) => hit > now - 60 * 60 * 1000);
            if (recentHits.length >= 5) {
                throw Object.assign(new Error("You've sent several reports recently. Please try again later."), {
                    status: 429,
                    code: 'RATE_LIMITED',
                });
            }
            recentHits.push(now);
            reportHits.set(clientKey, recentHits);
            await pool.query(`INSERT INTO visitor_reports (deal_id, reason, message, reporter_hash)
        VALUES ($1, $2, $3, $4)`, [id, reason, message || null, clientKey]);
            res.status(201).json({ ok: true });
        }
        catch (error) {
            next(error);
        }
    });
    app.use((error, _req, res, _next) => {
        const apiError = error;
        const status = apiError.status ?? 500;
        if (status >= 500)
            console.error('Public API request failed', error);
        res.status(status).json({
            status,
            code: apiError.code ?? 'INTERNAL',
            message: status >= 500 ? 'Something went wrong. Please try again.' : apiError.message,
            ...(apiError.details ? { details: apiError.details } : {}),
        });
    });
}
