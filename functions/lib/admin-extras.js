"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdminExtras = registerAdminExtras;
const image_routes_js_1 = require("./image-routes.js");
const public_api_js_1 = require("./public-api.js");
const EDITABLE = {
    title: { column: 'title', kind: 'string', max: 300, tracked: true },
    variant: { column: 'variant', kind: 'string', max: 300, tracked: true },
    model: { column: 'model', kind: 'string', max: 120, tracked: true },
    seller: { column: 'seller', kind: 'string', max: 200, tracked: true },
    condition: { column: 'condition_type', kind: 'enum', values: ['NEW', 'USED', 'REFURBISHED', 'UNKNOWN'], tracked: true },
    offerType: { column: 'offer_type', kind: 'enum', values: ['PRODUCT', 'STOREWIDE'], tracked: true },
    category: { column: 'category_id', kind: 'category', tracked: true },
    sourcePriceText: { column: 'source_price_text', kind: 'string', max: 500, tracked: true },
    originalPriceText: { column: 'original_price_text', kind: 'string', max: 500, tracked: true },
    conditionsText: { column: 'conditions_text', kind: 'string', max: 2000, tracked: true },
    rewardText: { column: 'reward_text', kind: 'string', max: 1000, tracked: true },
    taxNote: { column: 'tax_note', kind: 'string', max: 500 },
    referencePriceText: { column: 'reference_price_text', kind: 'string', max: 500, tracked: true },
    dateText: { column: 'date_text', kind: 'string', max: 500, tracked: true },
    listedCashPrice: { column: 'listed_cash_price', kind: 'money', tracked: true },
    sourcePrice: { column: 'source_price', kind: 'money', tracked: true },
    rewardAmount: { column: 'reward_amount', kind: 'money', tracked: true },
    shippingCost: { column: 'shipping_cost', kind: 'money' },
    referencePrice: { column: 'reference_price', kind: 'money', tracked: true },
    startsOn: { column: 'starts_on', kind: 'date', tracked: true },
    endsOn: { column: 'ends_on', kind: 'date', tracked: true },
    startsAt: { column: 'starts_at', kind: 'instant', tracked: true },
    endsAt: { column: 'ends_at', kind: 'instant', tracked: true },
    dateStatus: { column: 'date_status', kind: 'enum', values: ['KNOWN', 'UNKNOWN', 'CONFLICT'], tracked: true },
    productUrl: { column: 'product_url', kind: 'url', tracked: true },
    imageUrl: { column: 'image_url', kind: 'url' },
};
const MATERIAL = new Set(['listedCashPrice', 'sourcePrice', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice', 'startsOn', 'endsOn', 'startsAt', 'endsAt', 'productUrl']);
const REPORT_STATUSES = new Set(['OPEN', 'RESOLVED', 'DISMISSED']);
function registerAdminExtras(app, getPool) {
    (0, image_routes_js_1.registerImageRoutes)(app, getPool);
    app.patch('/api/admin/deals/:id', async (req, res, next) => {
        let client;
        try {
            const id = parseId(req.params.id);
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length)
                throw apiError('No changes supplied.');
            client = await (await getPool()).connect();
            await client.query('BEGIN');
            const found = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [id]);
            const before = found.rows[0];
            if (!before)
                throw apiError('Deal not found.', 404);
            const assignments = ['updated_at = now()'];
            const params = [];
            const tracked = {};
            const changes = {};
            const errors = {};
            const setValue = (column, value) => {
                params.push(value);
                assignments.push(`${column} = $${params.length}`);
            };
            for (const [field, raw] of Object.entries(body)) {
                if (field === 'imageAuthorized' || field === 'productUrlVerified')
                    continue;
                const spec = EDITABLE[field];
                if (!spec) {
                    errors[field] = "This field can't be edited.";
                    continue;
                }
                try {
                    let value = coerce(field, raw, spec);
                    if (spec.kind === 'category') {
                        const category = await client.query('SELECT id FROM categories WHERE slug = $1', [value]);
                        if (!category.rows[0])
                            throw new Error('Unknown category.');
                        value = category.rows[0].id;
                    }
                    setValue(spec.column, value);
                    if (spec.tracked)
                        tracked[spec.column] = true;
                    changes[field] = { from: String(before[spec.column] ?? ''), to: String(value ?? '') };
                }
                catch (error) {
                    errors[field] = error.message;
                }
            }
            if ('productUrl' in body || 'productUrlVerified' in body) {
                const verified = body.productUrlVerified === true;
                const url = 'productUrl' in body ? coerce('productUrl', body.productUrl, EDITABLE.productUrl) : before.product_url;
                if (verified && !url)
                    errors.productUrlVerified = 'Enter a product URL before marking it verified.';
                setValue('product_url_verified', Boolean(verified && url));
                changes.productUrlVerified = { to: Boolean(verified && url) };
            }
            if ('imageUrl' in body || 'imageAuthorized' in body) {
                const authorized = body.imageAuthorized === true;
                const url = 'imageUrl' in body ? coerce('imageUrl', body.imageUrl, EDITABLE.imageUrl) : before.image_url;
                if (authorized && !url)
                    errors.imageAuthorized = 'Add an image before confirming it is authorized.';
                setValue('image_authorized', Boolean(authorized && url));
                changes.imageAuthorized = { to: Boolean(authorized && url) };
            }
            if (Object.keys(errors).length)
                throw Object.assign(new Error('Some fields are invalid.'), { status: 400, code: 'VALIDATION_FAILED', details: errors });
            const startsOn = 'startsOn' in body ? String(body.startsOn || '') : String(before.starts_on ?? '');
            const endsOn = 'endsOn' in body ? String(body.endsOn || '') : String(before.ends_on ?? '');
            if (startsOn && endsOn && startsOn > endsOn)
                throw apiError('The start date is after the end date.');
            if (Object.keys(tracked).length) {
                params.push(JSON.stringify(tracked));
                assignments.push(`overrides = overrides || $${params.length}::jsonb`);
            }
            if (before.status === 'PUBLISHED' && Object.keys(changes).some((field) => MATERIAL.has(field))) {
                assignments.push("status = 'DRAFT'", 'published_at = NULL', 'featured = false');
                changes.status = { from: 'PUBLISHED', to: 'DRAFT' };
            }
            params.push(id);
            await client.query(`UPDATE deals SET ${assignments.join(', ')} WHERE id = $${params.length}`, params);
            await writeAudit(client, res.locals.actor, 'DEAL_EDITED', 'deal', id, { changes });
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
    app.get('/api/admin/reports', async (req, res, next) => {
        try {
            const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
            if (status && !REPORT_STATUSES.has(status))
                throw apiError('Unknown report status.');
            const pool = await getPool();
            const result = await pool.query(`SELECT vr.id, vr.deal_id, d.title AS deal_title, vr.reason, vr.message,
        vr.status, vr.created_at, vr.resolved_by FROM visitor_reports vr JOIN deals d ON d.id = vr.deal_id
        ${status ? 'WHERE vr.status = $1' : ''} ORDER BY vr.created_at DESC LIMIT 200`, status ? [status] : []);
            res.json(result.rows.map((row) => ({ id: Number(row.id), dealId: Number(row.deal_id), dealTitle: row.deal_title,
                reason: row.reason, message: row.message, status: row.status, createdAt: row.created_at, resolvedBy: row.resolved_by })));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/reports/:id/resolve', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const status = typeof req.body?.status === 'string' ? req.body.status.toUpperCase() : '';
            if (!['RESOLVED', 'DISMISSED'].includes(status))
                throw apiError('status must be RESOLVED or DISMISSED.');
            const pool = await getPool();
            const result = await pool.query(`UPDATE visitor_reports SET status = $2, resolved_by = $3, resolved_at = now()
        WHERE id = $1 RETURNING id`, [id, status, res.locals.actor]);
            if (!result.rowCount)
                throw apiError('Report not found.', 404);
            await pool.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
        VALUES ($1, $2, 'report', $3, $4::jsonb)`, [res.locals.actor, `REPORT_${status}`, String(id), JSON.stringify({ status })]);
            res.json({ ok: true });
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/audit', async (req, res, next) => {
        try {
            const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit ?? '100'), 10) || 100));
            const params = [];
            const clauses = [];
            if (typeof req.query.entityType === 'string' && req.query.entityType) {
                params.push(req.query.entityType);
                clauses.push(`entity_type = $${params.length}`);
            }
            if (typeof req.query.entityId === 'string' && req.query.entityId) {
                params.push(req.query.entityId);
                clauses.push(`entity_id = $${params.length}`);
            }
            params.push(limit);
            const result = await (await getPool()).query(`SELECT id, actor, action, entity_type, entity_id, details, created_at
        FROM admin_audit_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
            res.json(result.rows.map((row) => ({ id: Number(row.id), actor: row.actor, action: row.action,
                entityType: row.entity_type, entityId: row.entity_id, details: row.details, createdAt: row.created_at })));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/retailers', async (_req, res, next) => {
        try {
            const result = await (await getPool()).query(`SELECT r.id, r.name, r.slug, r.timezone,
        (SELECT count(*)::int FROM deals d WHERE d.retailer_id = r.id) AS deals FROM retailers r ORDER BY r.name`);
            res.json(result.rows.map((row) => ({ id: Number(row.id), name: row.name, slug: row.slug, timezone: row.timezone, deals: Number(row.deals) })));
        }
        catch (error) {
            next(error);
        }
    });
    app.patch('/api/admin/retailers/:id', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const timezone = typeof req.body?.timezone === 'string' && req.body.timezone.trim() ? req.body.timezone.trim() : null;
            if (timezone) {
                try {
                    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
                }
                catch {
                    throw apiError('Unknown timezone. Use an IANA name such as America/New_York.');
                }
            }
            const pool = await getPool();
            const result = await pool.query('UPDATE retailers SET timezone = $2 WHERE id = $1 RETURNING id, timezone', [id, timezone]);
            if (!result.rows[0])
                throw apiError('Retailer not found.', 404);
            await pool.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
        VALUES ($1, 'RETAILER_TIMEZONE_SET', 'retailer', $2, $3::jsonb)`, [res.locals.actor, String(id), JSON.stringify({ timezone })]);
            res.json({ id, timezone });
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/deals/export.csv', async (req, res, next) => {
        try {
            const params = [];
            const bind = (value) => { params.push(value); return `$${params.length}`; };
            const clauses = [];
            const status = typeof req.query.status === 'string' ? req.query.status.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean) : [];
            if (status.some((item) => !['DRAFT', 'PUBLISHED', 'EXPIRED', 'ARCHIVED'].includes(item)))
                throw apiError('Unknown deal status.');
            if (status.length)
                clauses.push(`d.status = ANY(${bind(status)}::text[])`);
            const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
            if (q)
                clauses.push(`d.search_vector @@ websearch_to_tsquery('english', ${bind(q)})`);
            if (String(req.query.missingLink) === 'true')
                clauses.push('(d.product_url IS NULL OR NOT d.product_url_verified)');
            if (String(req.query.unclearPrice) === 'true')
                clauses.push('d.listed_cash_price IS NULL');
            if (String(req.query.openReports) === 'true')
                clauses.push(`EXISTS (SELECT 1 FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN')`);
            if (String(req.query.possibleDuplicates) === 'true')
                clauses.push('d.candidate_group_key IS NOT NULL');
            if (String(req.query.staleDates) === 'true')
                clauses.push(`d.status IN ('DRAFT','PUBLISHED') AND ${public_api_js_1.TIMING} = 'expired'`);
            const result = await (await getPool()).query(`SELECT d.id, d.source_record_id, d.title, r.name AS retailer,
        c.name AS category, d.offer_type, d.status, d.listed_cash_price, d.source_price_text, d.product_url,
        d.product_url_verified, d.starts_on, d.ends_on, d.starts_at, d.ends_at, d.review_flags
        FROM deals d JOIN retailers r ON r.id = d.retailer_id JOIN categories c ON c.id = d.category_id
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY COALESCE(d.collected_at, d.created_at) DESC, d.id DESC LIMIT 10000`, params);
            const columns = ['id', 'sourceRecordId', 'title', 'retailer', 'category', 'offerType', 'status', 'listedCashPrice',
                'sourcePriceText', 'productUrl', 'productUrlVerified', 'startsOn', 'endsOn', 'startsAt', 'endsAt', 'reviewFlags'];
            const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
            const lines = [columns.map(csvCell).join(',')];
            for (const row of result.rows) {
                lines.push([row.id, row.source_record_id, row.title, row.retailer, row.category, row.offer_type, row.status,
                    row.listed_cash_price, row.source_price_text, row.product_url, row.product_url_verified, row.starts_on,
                    row.ends_on, row.starts_at, row.ends_at, (row.review_flags ?? []).join('|')].map(csvCell).join(','));
            }
            const pool = await getPool();
            await pool.query(`INSERT INTO admin_audit_events (actor, action, entity_type, details)
        VALUES ($1, 'DEALS_EXPORTED', 'deal', '{}'::jsonb)`, [res.locals.actor]);
            res.status(200).set('Content-Type', 'text/csv; charset=utf-8')
                .set('Content-Disposition', 'attachment; filename="deal-me-in-deals.csv"').send(lines.join('\r\n'));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/deals/merge-preview', async (req, res, next) => {
        try {
            const primaryId = parseId(String(req.query.primaryId ?? ''));
            const secondaryId = parseId(String(req.query.secondaryId ?? ''));
            if (primaryId === secondaryId)
                throw apiError('Choose two different offers.');
            res.json(await mergePreview(await getPool(), primaryId, secondaryId));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/deals/merge', async (req, res, next) => {
        let client;
        try {
            const primaryId = parseId(String(req.body?.primaryId ?? ''));
            const secondaryId = parseId(String(req.body?.secondaryId ?? ''));
            if (primaryId === secondaryId)
                throw apiError('Choose two different offers.');
            const preview = await mergePreview(await getPool(), primaryId, secondaryId);
            const resolutions = req.body?.resolutions && typeof req.body.resolutions === 'object' ? req.body.resolutions : {};
            for (const diff of preview.differences) {
                if (diff.requiresChoice && !resolutions[diff.field]) {
                    throw Object.assign(new Error(`Choose which value to keep for '${diff.field}'. Conflicting prices and conditions are never resolved automatically.`), {
                        status: 409, code: 'RESOLUTION_REQUIRED',
                    });
                }
            }
            if (preview.warnings.length && req.body?.acknowledgeWarnings !== true) {
                throw Object.assign(new Error('Acknowledge the merge warnings to continue.'), { status: 409, code: 'WARNINGS_NOT_ACKNOWLEDGED', details: { warnings: preview.warnings } });
            }
            if (Object.values(resolutions).some((value) => !['primary', 'secondary'].includes(value)))
                throw apiError("Resolution must be 'primary' or 'secondary'.");
            client = await (await getPool()).connect();
            await client.query('BEGIN');
            const secondary = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [secondaryId]);
            if (!secondary.rows[0])
                throw apiError('Secondary deal not found.', 404);
            const fields = {
                title: 'title', variant: 'variant', model: 'model', seller: 'seller', condition: 'condition_type', offerType: 'offer_type',
                listedCashPrice: 'listed_cash_price', sourcePrice: 'source_price', sourcePriceText: 'source_price_text',
                conditionsText: 'conditions_text', rewardText: 'reward_text', rewardAmount: 'reward_amount', referencePrice: 'reference_price',
                startsOn: 'starts_on', endsOn: 'ends_on', dateText: 'date_text', productUrl: 'product_url',
            };
            const sets = ['updated_at = now()'];
            const params = [];
            const overrides = {};
            for (const [field, selection] of Object.entries(resolutions)) {
                const column = fields[field];
                if (!column || selection !== 'secondary')
                    continue;
                params.push(secondary.rows[0][column]);
                sets.push(`${column} = $${params.length}`);
                overrides[column] = true;
            }
            if (Object.keys(overrides).length) {
                params.push(JSON.stringify(overrides));
                sets.push(`overrides = overrides || $${params.length}::jsonb`);
            }
            params.push(primaryId);
            await client.query(`UPDATE deals SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
            await client.query(`UPDATE deal_sources s SET deal_id = $1,
        source_ref = CASE WHEN EXISTS (SELECT 1 FROM deal_sources x WHERE x.deal_id = $1 AND x.source_ref = s.source_ref)
          THEN s.source_ref || ' [merged from deal ' || $2 || ']' ELSE s.source_ref END WHERE s.deal_id = $2`, [primaryId, secondaryId]);
            await client.query('UPDATE visitor_reports SET deal_id = $1 WHERE deal_id = $2', [primaryId, secondaryId]);
            await client.query(`UPDATE deals SET status = 'ARCHIVED', archive_reason = 'MERGED', merged_into_id = $1,
        featured = false, published_at = NULL, updated_at = now() WHERE id = $2`, [primaryId, secondaryId]);
            await writeAudit(client, res.locals.actor, 'DEALS_MERGED', 'deal', primaryId, {
                secondaryId, resolutions, differences: preview.differences, warningsAcknowledged: preview.warnings,
            });
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
}
async function mergePreview(pool, primaryId, secondaryId) {
    const [primary, secondary] = await Promise.all([
        getAdminDeal(pool, primaryId),
        getAdminDeal(pool, secondaryId),
    ]);
    if (!primary)
        throw apiError('Primary deal not found.', 404);
    if (!secondary)
        throw apiError('Secondary deal not found.', 404);
    const compare = ['title', 'variant', 'model', 'seller', 'condition', 'offerType', 'category', 'retailer',
        'listedCashPrice', 'sourcePrice', 'sourcePriceText', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice',
        'startsOn', 'endsOn', 'dateText', 'productUrl'];
    const conflictFields = new Set(['listedCashPrice', 'sourcePrice', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice']);
    const differences = compare.flatMap((field) => {
        const first = flattenField(primary[field]);
        const second = flattenField(secondary[field]);
        return first === second ? [] : [{ field, primary: first, secondary: second, requiresChoice: conflictFields.has(field) }];
    });
    const fields = new Set(differences.map((item) => item.field));
    const warnings = [];
    if (fields.has('retailer'))
        warnings.push('These offers are from different retailers and should normally stay separate.');
    if (fields.has('variant') || fields.has('model'))
        warnings.push('Variant or model differs (size, width, color, capacity or pack quantity).');
    if (fields.has('condition'))
        warnings.push('New, used and refurbished items should stay separate.');
    if (fields.has('startsOn') || fields.has('endsOn'))
        warnings.push('The sale periods differ.');
    if (fields.has('conditionsText') || fields.has('rewardText') || fields.has('rewardAmount'))
        warnings.push('Coupon, membership, gift-card or rebate conditions differ.');
    return { primary, secondary, differences, warnings, sourcesToMove: secondary.sources };
}
async function getAdminDeal(pool, id) {
    const result = await pool.query(`SELECT d.*, r.name AS retailer_name, r.slug AS retailer_slug,
    r.timezone AS retailer_timezone, c.name AS category_name, c.slug AS category_slug,
    ${public_api_js_1.TIMING} AS timing, (SELECT count(*)::int FROM visitor_reports vr WHERE vr.deal_id = d.id AND vr.status = 'OPEN') AS open_reports,
    related.related_count ${public_api_js_1.BASE_FROM} WHERE d.id = $1`, [id]);
    const row = result.rows[0];
    if (!row)
        return null;
    const sources = await pool.query(`SELECT id, source_name, source_url, source_ref, collected_at, origin_record_id, raw
    FROM deal_sources WHERE deal_id = $1 ORDER BY id`, [id]);
    return {
        ...(0, public_api_js_1.toDeal)(row),
        sourceRecordId: row.source_record_id,
        reviewFlags: row.review_flags,
        candidateGroupKey: row.candidate_group_key,
        productUrl: (0, public_api_js_1.safeHttpUrl)(row.product_url),
        productUrlVerified: row.product_url_verified,
        sources: sources.rows.map((source) => ({ id: Number(source.id), name: source.source_name, url: (0, public_api_js_1.safeHttpUrl)(source.source_url),
            ref: source.source_ref, collectedAt: source.collected_at, originRecordId: source.origin_record_id, raw: source.raw })),
    };
}
function flattenField(value) {
    if (value && typeof value === 'object' && !Array.isArray(value))
        return value.slug;
    return value;
}
function parseId(raw) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1)
        throw apiError('Record not found.', 404);
    return id;
}
function apiError(message, status = 400) {
    return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' });
}
function coerce(field, raw, spec) {
    if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim()))
        return null;
    if (typeof raw !== 'string' && typeof raw !== 'number')
        throw new Error('Invalid value.');
    const value = String(raw).trim();
    if (spec.kind === 'string') {
        if (value.length > (spec.max ?? 0))
            throw new Error(`Must be ${spec.max} characters or fewer.`);
        return value;
    }
    if (spec.kind === 'money') {
        if (!/^\d{1,10}(\.\d{1,2})?$/.test(value))
            throw new Error('Use a dollar amount like 49.99.');
        return Number(value);
    }
    if (spec.kind === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
            throw new Error('Use YYYY-MM-DD.');
        return value;
    }
    if (spec.kind === 'instant') {
        if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value) || Number.isNaN(Date.parse(value))) {
            throw new Error('Use an ISO timestamp with offset.');
        }
        return value;
    }
    if (spec.kind === 'url') {
        if (field === 'imageUrl' && value.startsWith('/uploads/') && !value.includes('..'))
            return value;
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            throw new Error('Enter a full http:// or https:// address.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol))
            throw new Error('Enter a full http:// or https:// address.');
        return value;
    }
    if (spec.kind === 'enum') {
        const upper = value.toUpperCase();
        if (!spec.values?.includes(upper))
            throw new Error(`Must be one of ${spec.values?.join(', ')}.`);
        return upper;
    }
    return value;
}
async function writeAudit(client, actor, action, entityType, entityId, details) {
    await client.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)`, [actor, action, entityType, String(entityId), JSON.stringify(details)]);
}
