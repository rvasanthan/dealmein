"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdminApi = registerAdminApi;
const node_crypto_1 = require("node:crypto");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const admin_extras_js_1 = require("./admin-extras.js");
const import_api_js_1 = require("./import-api.js");
const public_api_js_1 = require("./public-api.js");
const loginFailures = new Map();
function issueToken(username, secret, ttlMinutes) {
    const body = Buffer.from(`${username}|${Math.floor(Date.now() / 1000) + ttlMinutes * 60}`).toString('base64url');
    const signature = (0, node_crypto_1.createHmac)('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
}
function verifyToken(token, secret) {
    const separator = token.indexOf('.');
    if (separator < 1)
        return null;
    const body = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = (0, node_crypto_1.createHmac)('sha256', secret).update(body).digest();
    let actual;
    try {
        actual = Buffer.from(signature, 'base64url');
    }
    catch {
        return null;
    }
    if (actual.length !== expected.length || !(0, node_crypto_1.timingSafeEqual)(actual, expected))
        return null;
    try {
        const decoded = Buffer.from(body, 'base64url').toString('utf8');
        const delimiter = decoded.lastIndexOf('|');
        const expiry = Number(decoded.slice(delimiter + 1));
        if (delimiter < 1 || !Number.isSafeInteger(expiry) || Math.floor(Date.now() / 1000) > expiry)
            return null;
        return decoded.slice(0, delimiter);
    }
    catch {
        return null;
    }
}
function auth(req, res, next) {
    const secret = process.env.APP_JWT_SECRET ?? '';
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const actor = secret.length >= 32 ? verifyToken(token, secret) : null;
    if (!actor) {
        res.status(401).json({ status: 401, code: 'UNAUTHORIZED', message: 'Administrator sign-in required.' });
        return;
    }
    res.locals.actor = actor;
    next();
}
function registerAdminApi(app, getPool) {
    app.post('/api/admin/login', async (req, res, next) => {
        try {
            const username = req.body?.username;
            const password = req.body?.password;
            const key = req.ip ?? 'unknown';
            const now = Date.now();
            const failures = (loginFailures.get(key) ?? []).filter((hit) => hit > now - 15 * 60 * 1000);
            if (failures.length >= 5) {
                res.status(429).json({ status: 429, code: 'RATE_LIMITED', message: 'Too many failed sign-in attempts. Try again later.' });
                return;
            }
            const configuredUsername = process.env.APP_ADMIN_USERNAME ?? '';
            const passwordHash = process.env.APP_ADMIN_PASSWORD_HASH ?? '';
            const secret = process.env.APP_JWT_SECRET ?? '';
            if (!configuredUsername || !passwordHash || secret.length < 32) {
                res.status(503).json({ status: 503, code: 'ADMIN_NOT_CONFIGURED', message: 'Administrator access has not been configured.' });
                return;
            }
            const valid = typeof username === 'string' && typeof password === 'string'
                && username === configuredUsername && await bcryptjs_1.default.compare(password, passwordHash);
            if (!valid) {
                failures.push(now);
                loginFailures.set(key, failures);
                res.status(401).json({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Incorrect username or password.' });
                return;
            }
            loginFailures.delete(key);
            const pool = await getPool();
            await pool.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
        VALUES ($1, 'ADMIN_LOGIN', 'session', NULL, '{}'::jsonb)`, [username]);
            const ttlMinutes = Math.max(1, Number.parseInt(process.env.APP_TOKEN_TTL_MINUTES ?? '480', 10) || 480);
            res.json({ token: issueToken(username, secret, ttlMinutes), username, expiresInMinutes: ttlMinutes });
        }
        catch (error) {
            next(error);
        }
    });
    app.use('/api/admin', auth);
    (0, admin_extras_js_1.registerAdminExtras)(app, getPool);
    (0, import_api_js_1.registerImportApi)(app, getPool);
    app.get('/api/admin/me', (_req, res) => res.json({ username: res.locals.actor }));
    app.get('/api/admin/stats', async (_req, res, next) => {
        try {
            const pool = await getPool();
            const counts = await pool.query(`SELECT status, count(*)::int AS count FROM deals GROUP BY status`);
            const stats = { draft: 0, published: 0, expired: 0, archived: 0, openReports: 0 };
            for (const row of counts.rows)
                stats[String(row.status).toLowerCase()] = Number(row.count);
            const reports = await pool.query(`SELECT count(*)::int AS count FROM visitor_reports WHERE status = 'OPEN'`);
            stats.openReports = Number(reports.rows[0].count);
            res.json(stats);
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/deals', async (req, res, next) => {
        try {
            const pool = await getPool();
            const params = [];
            const bind = (value) => { params.push(value); return `$${params.length}`; };
            const clauses = [];
            const statuses = String(req.query.status ?? '').split(',').map((status) => status.trim().toUpperCase()).filter(Boolean);
            if (statuses.some((status) => !['DRAFT', 'PUBLISHED', 'EXPIRED', 'ARCHIVED'].includes(status))) {
                throw Object.assign(new Error('Unknown deal status.'), { status: 400, code: 'BAD_REQUEST' });
            }
            if (statuses.length)
                clauses.push(`d.status = ANY(${bind(statuses)}::text[])`);
            const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
            if (query.length > 200)
                throw Object.assign(new Error('Search text is too long.'), { status: 400, code: 'BAD_REQUEST' });
            if (query)
                clauses.push(`d.search_vector @@ websearch_to_tsquery('english', ${bind(query)})`);
            const categories = String(req.query.category ?? '').split(',').filter(Boolean);
            const retailers = String(req.query.retailer ?? '').split(',').filter(Boolean);
            if (categories.length)
                clauses.push(`c.slug = ANY(${bind(categories)}::text[])`);
            if (retailers.length)
                clauses.push(`r.slug = ANY(${bind(retailers)}::text[])`);
            const type = typeof req.query.type === 'string' ? req.query.type.toUpperCase() : '';
            if (type && !['PRODUCT', 'STOREWIDE'].includes(type))
                throw Object.assign(new Error('Unknown offer type.'), { status: 400, code: 'BAD_REQUEST' });
            if (type)
                clauses.push(`d.offer_type = ${bind(type)}`);
            const timing = String(req.query.timing ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
            if (timing.some((item) => !['active', 'upcoming', 'expired', 'unknown'].includes(item))) {
                throw Object.assign(new Error('Unknown timing filter.'), { status: 400, code: 'BAD_REQUEST' });
            }
            if (timing.length)
                clauses.push(`${public_api_js_1.TIMING} = ANY(${bind(timing)}::text[])`);
            if (req.query.minPrice !== undefined && String(req.query.minPrice).trim()) {
                const price = Number(req.query.minPrice);
                if (!Number.isFinite(price) || price < 0)
                    throw Object.assign(new Error('minPrice must be a non-negative dollar amount.'), { status: 400, code: 'BAD_REQUEST' });
                clauses.push(`d.listed_cash_price >= ${bind(price)}`);
            }
            if (req.query.maxPrice !== undefined && String(req.query.maxPrice).trim()) {
                const price = Number(req.query.maxPrice);
                if (!Number.isFinite(price) || price < 0)
                    throw Object.assign(new Error('maxPrice must be a non-negative dollar amount.'), { status: 400, code: 'BAD_REQUEST' });
                clauses.push(`d.listed_cash_price <= ${bind(price)}`);
            }
            if (String(req.query.featured) === 'true')
                clauses.push('d.featured');
            if (String(req.query.missingLink) === 'true')
                clauses.push('(d.product_url IS NULL OR NOT d.product_url_verified)');
            if (String(req.query.unclearPrice) === 'true')
                clauses.push('d.listed_cash_price IS NULL');
            if (String(req.query.staleDates) === 'true')
                clauses.push(`d.status IN ('DRAFT','PUBLISHED') AND ${public_api_js_1.TIMING} = 'expired'`);
            if (String(req.query.possibleDuplicates) === 'true')
                clauses.push('related.related_count > 0');
            if (String(req.query.openReports) === 'true')
                clauses.push('report_counts.open_reports > 0');
            const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
            const from = `${public_api_js_1.BASE_FROM} ${where}`;
            const count = await pool.query(`SELECT count(*)::int AS total
        FROM deals d JOIN retailers r ON r.id = d.retailer_id JOIN categories c ON c.id = d.category_id
        LEFT JOIN LATERAL (SELECT count(*)::int AS related_count FROM deals g WHERE d.candidate_group_key IS NOT NULL
          AND g.candidate_group_key = d.candidate_group_key AND g.id <> d.id AND g.status <> 'ARCHIVED') related ON true
        LEFT JOIN LATERAL (SELECT count(*)::int AS open_reports FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN') report_counts ON true
        ${where}`, params);
            const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
            const size = Math.min(48, Math.max(1, Number.parseInt(String(req.query.size ?? '24'), 10) || 24));
            const sort = String(req.query.sort ?? '');
            if (sort && !['newest', 'price_asc', 'price_desc', 'relevance'].includes(sort))
                throw apiError('Unknown sort.');
            const orderBy = sort === 'price_asc' ? 'd.listed_cash_price ASC NULLS LAST, d.id ASC'
                : sort === 'price_desc' ? 'd.listed_cash_price DESC NULLS LAST, d.id ASC'
                    : sort === 'relevance' && query ? `ts_rank(d.search_vector, websearch_to_tsquery('english', $${params.indexOf(query) + 1})) DESC, d.id DESC`
                        : 'COALESCE(d.collected_at, d.created_at) DESC, d.id DESC';
            const limitArg = bind(size);
            const offsetArg = bind((page - 1) * size);
            const result = await pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
        r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
        ${public_api_js_1.TIMING} AS timing, report_counts.open_reports, related.related_count
        FROM deals d JOIN retailers r ON r.id = d.retailer_id JOIN categories c ON c.id = d.category_id
        LEFT JOIN LATERAL (SELECT count(*)::int AS related_count FROM deals g WHERE d.candidate_group_key IS NOT NULL
          AND g.candidate_group_key = d.candidate_group_key AND g.id <> d.id AND g.status <> 'ARCHIVED') related ON true
        LEFT JOIN LATERAL (SELECT count(*)::int AS open_reports FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN') report_counts ON true
        ${where} ORDER BY ${orderBy} LIMIT ${limitArg} OFFSET ${offsetArg}`, params);
            const total = Number(count.rows[0].total);
            res.json({ items: result.rows.map((row) => ({
                    ...(0, public_api_js_1.toDeal)(row),
                    sourceRecordId: row.source_record_id,
                    reviewFlags: row.review_flags,
                    candidateGroupKey: row.candidate_group_key,
                    productUrl: row.product_url,
                    productUrlVerified: row.product_url_verified,
                    imageUrlRaw: row.image_url,
                    imageAuthorized: row.image_authorized,
                    archiveReason: row.archive_reason,
                    mergedIntoId: row.merged_into_id,
                    overrides: row.overrides,
                    importedSnapshot: row.imported_snapshot,
                    openReports: Number(row.open_reports),
                    publishedAt: row.published_at,
                    reviewedBy: row.reviewed_by,
                    updatedAt: row.updated_at,
                })), page, size, total, totalPages: Math.ceil(total / size) });
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/deals/:id', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const pool = await getPool();
            const result = await pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
        r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
        ${public_api_js_1.TIMING} AS timing,
        (SELECT count(*)::int FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN') AS open_reports,
        related.related_count
        ${public_api_js_1.BASE_FROM}
        WHERE d.id = $1`, [id]);
            const row = result.rows[0];
            if (!row)
                throw apiError('Deal not found.', 404);
            const [sources, audit, related] = await Promise.all([
                pool.query(`SELECT id, source_name, source_url, source_ref, collected_at, origin_record_id, raw
          FROM deal_sources WHERE deal_id = $1 ORDER BY id`, [id]),
                pool.query(`SELECT id, actor, action, entity_type, entity_id, details, created_at
          FROM admin_audit_events WHERE entity_type = 'deal' AND entity_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 50`, [String(id)]),
                pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
          r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
          ${public_api_js_1.TIMING} AS timing,
          (SELECT count(*)::int FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN') AS open_reports,
          related.related_count
          ${public_api_js_1.BASE_FROM}
          WHERE d.id <> $1 AND d.candidate_group_key = $2 AND d.status <> 'ARCHIVED' ORDER BY d.id LIMIT 20`, [id, row.candidate_group_key]),
            ]);
            const sourceDtos = sources.rows.map((source) => ({
                id: Number(source.id),
                name: source.source_name,
                url: (0, public_api_js_1.safeHttpUrl)(source.source_url),
                ref: source.source_ref,
                collectedAt: source.collected_at,
                originRecordId: source.origin_record_id,
                raw: source.raw,
            }));
            res.json({
                ...(0, public_api_js_1.toDeal)(row),
                sourceRecordId: row.source_record_id,
                reviewFlags: row.review_flags,
                candidateGroupKey: row.candidate_group_key,
                productUrl: (0, public_api_js_1.safeHttpUrl)(row.product_url),
                productUrlVerified: row.product_url_verified,
                imageUrlRaw: row.image_url,
                imageAuthorized: row.image_authorized,
                archiveReason: row.archive_reason,
                mergedIntoId: row.merged_into_id,
                overrides: row.overrides,
                importedSnapshot: row.imported_snapshot,
                openReports: Number(row.open_reports),
                publishedAt: row.published_at,
                reviewedBy: row.reviewed_by,
                updatedAt: row.updated_at,
                sources: sourceDtos,
                listingLink: sourceDtos.find((source) => source.url)?.url ?? null,
                related: related.rows.map((item) => (0, public_api_js_1.toDeal)(item)),
                audit: audit.rows.map((event) => ({
                    id: Number(event.id),
                    actor: event.actor,
                    action: event.action,
                    entityType: event.entity_type,
                    entityId: event.entity_id,
                    details: event.details,
                    createdAt: event.created_at,
                })),
            });
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/deals/:id/publish', async (req, res, next) => {
        let client;
        try {
            client = await (await getPool()).connect();
            const id = parseId(req.params.id);
            const checks = ['identity', 'link', 'price', 'conditions', 'timing'];
            if (!checks.every((field) => req.body?.[field] === true)) {
                throw apiError('Confirm that product identity, retailer link, price, conditions and timing have all been checked.');
            }
            await client.query('BEGIN');
            const result = await client.query(`SELECT d.status, d.date_status, d.starts_at, d.starts_on, d.ends_at, d.ends_on,
        r.timezone,
        CASE WHEN d.status = 'EXPIRED' THEN 'expired'
          WHEN d.date_status <> 'KNOWN' THEN 'unknown'
          WHEN d.starts_at IS NULL AND d.starts_on IS NULL AND d.ends_at IS NULL AND d.ends_on IS NULL THEN 'unknown'
          WHEN r.timezone IS NULL AND ((d.ends_on IS NOT NULL AND d.ends_at IS NULL) OR (d.starts_on IS NOT NULL AND d.starts_at IS NULL)) THEN 'unknown'
          WHEN ${`COALESCE(d.ends_at, CASE WHEN d.ends_on IS NOT NULL AND r.timezone IS NOT NULL THEN ((d.ends_on + 1)::timestamp AT TIME ZONE r.timezone) END)`} <= now() THEN 'expired'
          ELSE 'active' END AS timing
        FROM deals d JOIN retailers r ON r.id = d.retailer_id WHERE d.id = $1 FOR UPDATE`, [id]);
            const deal = result.rows[0];
            if (!deal)
                throw apiError('Deal not found.', 404);
            if (deal.status !== 'DRAFT')
                throw Object.assign(new Error(`Only draft offers can be published (current status: ${deal.status}).`), { status: 409, code: 'CONFLICT' });
            if (deal.timing === 'expired')
                throw Object.assign(new Error("This offer's sale period has already ended. Correct the dates or archive it."), { status: 409, code: 'CONFLICT' });
            await client.query(`UPDATE deals SET status = 'PUBLISHED', published_at = now(), reviewed_at = now(),
        reviewed_by = $2, updated_at = now(), review_flags = array_remove(review_flags, 'MATERIAL_CHANGE') WHERE id = $1`, [id, res.locals.actor]);
            await writeAudit(client, res.locals.actor, 'DEAL_PUBLISHED', 'deal', id, { checklist: { identity: true, link: true, price: true, conditions: true, timing: true } });
            await client.query('COMMIT');
            res.json({ ok: true });
        }
        catch (error) {
            if (client)
                await client.query('ROLLBACK').catch(() => { });
            next(error);
        }
        finally {
            client?.release();
        }
    });
    app.post('/api/admin/deals/:id/status', async (req, res, next) => {
        let client;
        try {
            client = await (await getPool()).connect();
            const id = parseId(req.params.id);
            const target = typeof req.body?.status === 'string' ? req.body.status.toUpperCase() : '';
            const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
            if (!['DRAFT', 'EXPIRED', 'ARCHIVED'].includes(target))
                throw apiError('status must be DRAFT, EXPIRED or ARCHIVED. Use the publish action to publish.');
            if (target === 'ARCHIVED' && reason.length > 200)
                throw apiError('Reason is too long.');
            await client.query('BEGIN');
            const result = await client.query('SELECT status, merged_into_id FROM deals WHERE id = $1 FOR UPDATE', [id]);
            const deal = result.rows[0];
            if (!deal)
                throw apiError('Deal not found.', 404);
            if (deal.status === target)
                throw Object.assign(new Error(`The deal is already ${target}.`), { status: 409, code: 'CONFLICT' });
            if (deal.status === 'ARCHIVED' && deal.merged_into_id !== null && target === 'DRAFT') {
                throw Object.assign(new Error("Merged offers can't be restored."), { status: 409, code: 'CONFLICT' });
            }
            await client.query(`UPDATE deals SET status = $2, archive_reason = $3, featured = false,
        published_at = CASE WHEN $2 = 'EXPIRED' THEN published_at ELSE NULL END, updated_at = now() WHERE id = $1`, [id, target, target === 'ARCHIVED' ? reason || 'ARCHIVED' : null]);
            await writeAudit(client, res.locals.actor, 'DEAL_STATUS_CHANGED', 'deal', id, { from: deal.status, to: target, reason: reason || null });
            await client.query('COMMIT');
            res.json({ ok: true });
        }
        catch (error) {
            if (client)
                await client.query('ROLLBACK').catch(() => { });
            next(error);
        }
        finally {
            client?.release();
        }
    });
    app.post('/api/admin/deals/:id/featured', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const featured = req.body?.featured === true;
            const pool = await getPool();
            const result = await pool.query('SELECT status FROM deals WHERE id = $1', [id]);
            if (!result.rows[0])
                throw apiError('Deal not found.', 404);
            if (featured && result.rows[0].status !== 'PUBLISHED') {
                throw Object.assign(new Error('Only published offers can be featured.'), { status: 409, code: 'CONFLICT' });
            }
            await pool.query('UPDATE deals SET featured = $2, updated_at = now() WHERE id = $1', [id, featured]);
            await pool.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
        VALUES ($1, $2, 'deal', $3, '{}'::jsonb)`, [res.locals.actor, featured ? 'DEAL_FEATURED' : 'DEAL_UNFEATURED', String(id)]);
            res.json({ ok: true });
        }
        catch (error) {
            next(error);
        }
    });
}
function parseId(raw) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1)
        throw apiError('Deal not found.', 404);
    return id;
}
function apiError(message, status = 400) {
    return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' });
}
async function writeAudit(client, actor, action, entityType, entityId, details) {
    await client.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)`, [actor, action, entityType, String(entityId), JSON.stringify(details)]);
}
