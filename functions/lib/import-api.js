"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerImportApi = registerImportApi;
const node_crypto_1 = require("node:crypto");
const multer_1 = __importDefault(require("multer"));
const public_api_js_1 = require("./public-api.js");
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ISSUES = 5000;
const FIELDS = [
    'title', 'variant', 'model', 'condition_type', 'seller', 'offer_type', 'source_price_text', 'source_price',
    'listed_cash_price', 'original_price_text', 'conditions_text', 'reward_text', 'reward_amount', 'reference_price',
    'reference_price_text', 'starts_on', 'ends_on', 'starts_at', 'ends_at', 'date_text', 'date_status',
    'collected_at', 'retailer_verified_at', 'source_verification_status', 'candidate_group_key', 'product_url',
];
const MATERIAL = new Set(['source_price', 'source_price_text', 'listed_cash_price', 'conditions_text', 'reward_text',
    'reward_amount', 'reference_price', 'starts_on', 'ends_on', 'starts_at', 'ends_at']);
const ALIASES = {
    id: ['id', 'record_id', 'recordId', 'source_record_id', 'offer_id', 'deal_id'],
    title: ['title', 'product_title', 'product', 'name', 'product_name'],
    variant: ['variant', 'variants', 'variant_text', 'options'],
    model: ['model', 'model_number', 'mpn', 'sku'],
    condition: ['condition', 'item_condition'],
    retailer: ['retailer', 'store', 'retailer_name', 'merchant'],
    seller: ['seller', 'sold_by'],
    category: ['category', 'category_name', 'department'],
    offerType: ['offer_type', 'deal_type', 'type'],
    sourcePrice: ['source_price', 'reported_price', 'price', 'sale_price'],
    sourcePriceText: ['source_price_text', 'price_text', 'original_price_text', 'price_raw'],
    listedCash: ['listed_cash_price', 'cash_price', 'listed_price'],
    conditions: ['conditions', 'conditions_text', 'terms', 'notes', 'price_conditions'],
    reward: ['reward_text', 'rebate_text', 'gift_card_text', 'rewards'],
    rewardAmount: ['reward_amount', 'rebate_amount', 'gift_card_amount'],
    reference: ['reference_price', 'advertised_reference_price', 'original_price', 'list_price', 'was_price'],
    referenceText: ['reference_price_text'],
    start: ['start_date', 'sale_start', 'starts_on', 'starts_at', 'valid_from'],
    end: ['end_date', 'sale_end', 'ends_on', 'ends_at', 'expires', 'valid_until'],
    dateText: ['date_text', 'sale_dates', 'dates', 'original_date_text', 'timing'],
    dateStatus: ['date_status'],
    collected: ['collected_at', 'collected', 'scraped_at', 'captured_at'],
    verifiedAt: ['retailer_verified_at', 'verified_at'],
    verification: ['verification_status', 'verification', 'verified'],
    flags: ['review_flags', 'flags', 'review_notes'],
    group: ['candidate_group', 'candidate_group_id', 'related_group', 'group_id', 'dedup_group', 'duplicate_group'],
    productUrl: ['product_url', 'retailer_url', 'retailer_product_url'],
    sourceUrl: ['source_url', 'source_link', 'listing_url', 'url', 'link'],
    sourceName: ['source_name', 'source', 'publisher'],
    sourceRef: ['source_ref', 'source_reference', 'source_id'],
    sources: ['sources', 'source_references'],
};
const importFile = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
function registerImportApi(app, getPool) {
    app.get('/api/admin/imports', async (_req, res, next) => {
        try {
            res.json(await history(await getPool()));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/imports/:id', async (req, res, next) => {
        try {
            res.json(await getJob(await getPool(), parseId(req.params.id)));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/imports/:id/issues', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const limit = Math.min(500, Math.max(1, Number.parseInt(String(req.query.limit ?? '100'), 10) || 100));
            const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
            const severity = typeof req.query.severity === 'string' ? req.query.severity.toUpperCase() : '';
            if (severity && !['ERROR', 'WARNING'].includes(severity))
                throw apiError('Unknown issue severity.');
            const params = [id];
            const where = severity ? ` AND severity = $${params.push(severity)}` : '';
            params.push(limit, offset);
            const result = await (await getPool()).query(`SELECT id, row_number, source_record_id, severity, message
        FROM import_row_issues WHERE import_job_id = $1${where} ORDER BY row_number, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
            res.json(result.rows.map((row) => ({ id: Number(row.id), row: row.row_number, rowNumber: row.row_number,
                sourceRecordId: row.source_record_id, recordId: row.source_record_id, severity: row.severity, message: row.message })));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/imports/preview', importFile.single('file'), async (req, res, next) => {
        try {
            const file = req.file;
            if (!file?.buffer.length)
                throw apiError('The uploaded file is empty.');
            const parsed = parseDataset(file.buffer);
            const pool = await getPool();
            const counts = await classify(pool, parsed.records);
            const filename = (file.originalname || 'upload.json').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 255);
            const hash = (0, node_crypto_1.createHash)('sha256').update(file.buffer).digest('hex');
            const client = await pool.connect();
            let id;
            try {
                await client.query('BEGIN');
                const job = await client.query(`INSERT INTO import_jobs (filename, sha256, adapter, status, total_rows, created_count,
          updated_count, unchanged_count, failed_count, warning_count, payload, created_by)
          VALUES ($1,$2,'json-snapshot','PREVIEW',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [filename, hash, parsed.totalRows, counts.created, counts.updated, counts.unchanged,
                    parsed.issues.filter((issue) => issue.severity === 'ERROR').length,
                    parsed.issues.filter((issue) => issue.severity === 'WARNING').length, file.buffer, res.locals.actor]);
                id = Number(job.rows[0].id);
                for (const issue of parsed.issues.slice(0, MAX_ISSUES)) {
                    await client.query(`INSERT INTO import_row_issues (import_job_id,row_number,source_record_id,severity,message)
            VALUES ($1,$2,$3,$4,$5)`, [id, issue.row, issue.sourceRecordId, issue.severity, issue.message]);
                }
                await client.query('COMMIT');
            }
            catch (error) {
                await client.query('ROLLBACK').catch(() => { });
                throw error;
            }
            finally {
                client.release();
            }
            res.json(await getJob(pool, id));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/imports/:id/commit', async (req, res, next) => {
        try {
            const id = parseId(req.params.id);
            const pool = await getPool();
            const job = await pool.query('SELECT status, payload, filename FROM import_jobs WHERE id = $1', [id]);
            if (!job.rows[0])
                throw apiError('Import not found.', 404);
            if (job.rows[0].status !== 'PREVIEW')
                throw Object.assign(new Error('This import has already been applied.'), { status: 409, code: 'CONFLICT' });
            const parsed = parseDataset(job.rows[0].payload);
            const client = await pool.connect();
            const counts = { created: 0, updated: 0, unchanged: 0 };
            try {
                await client.query('BEGIN');
                for (const record of parsed.records) {
                    const outcome = await applyRecord(client, record, id);
                    counts[outcome]++;
                }
                await client.query(`UPDATE import_jobs SET status = 'COMPLETED', created_count = $2, updated_count = $3,
          unchanged_count = $4, completed_at = now(), payload = NULL WHERE id = $1`, [id, counts.created, counts.updated, counts.unchanged]);
                await client.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
          VALUES ($1, 'IMPORT_COMMITTED', 'import', $2, $3::jsonb)`, [res.locals.actor, String(id), JSON.stringify({ ...counts, file: job.rows[0].filename })]);
                await client.query('COMMIT');
            }
            catch (error) {
                await client.query('ROLLBACK').catch(() => { });
                await pool.query(`UPDATE import_jobs SET status = 'FAILED', completed_at = now() WHERE id = $1`, [id]);
                await pool.query(`INSERT INTO import_row_issues (import_job_id,row_number,severity,message)
          VALUES ($1,0,'ERROR',$2)`, [id, `Import failed and was rolled back: ${error.message.slice(0, 200)}`]);
                throw Object.assign(new Error('The import failed and no records were changed.'), { status: 500, code: 'IMPORT_FAILED' });
            }
            finally {
                client.release();
            }
            res.json(await getJob(pool, id));
        }
        catch (error) {
            next(error);
        }
    });
}
async function applyRecord(client, record, jobId) {
    const retailerSlug = slug(record.retailer);
    const retailer = await client.query(`INSERT INTO retailers (name, slug, timezone) VALUES ($1,$2,$3)
    ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`, [record.retailer, retailerSlug, process.env.APP_DEFAULT_RETAILER_TIMEZONE || 'America/New_York']);
    const category = await client.query('SELECT id FROM categories WHERE lower(name) = lower($1) OR slug = $2', [record.category, slug(record.category || '')]);
    const categoryId = Number(category.rows[0]?.id ?? (await client.query("SELECT id FROM categories WHERE slug = 'other'")).rows[0].id);
    if (!category.rows[0] && !record.flags.includes('CATEGORY_UNMATCHED'))
        record.flags.push('CATEGORY_UNMATCHED');
    const snapshot = JSON.stringify({ normalized: record.normalized, raw: record.raw });
    const existingResult = await client.query(`SELECT id, status, overrides, imported_snapshot, review_flags
    FROM deals WHERE source_record_id = $1 FOR UPDATE`, [record.sourceRecordId]);
    let dealId;
    let outcome;
    const values = FIELDS.map((field) => record.values[field] ?? null);
    if (!existingResult.rows[0]) {
        const columnNames = ['source_record_id', 'retailer_id', 'category_id', 'review_flags', 'imported_snapshot', 'status', ...FIELDS];
        const params = [record.sourceRecordId, retailer.rows[0].id, categoryId, record.flags, snapshot, 'DRAFT', ...values];
        const placeholders = params.map((_, index) => `$${index + 1}`);
        placeholders[4] = `$5::jsonb`;
        const inserted = await client.query(`INSERT INTO deals (${columnNames.join(',')}) VALUES (${placeholders.join(',')}) RETURNING id`, params);
        dealId = Number(inserted.rows[0].id);
        outcome = 'created';
    }
    else {
        const old = existingResult.rows[0];
        dealId = Number(old.id);
        const oldNormalized = old.imported_snapshot?.normalized ?? null;
        if (oldNormalized && equalObjects(oldNormalized, record.normalized))
            outcome = 'unchanged';
        else {
            const overrides = old.overrides ?? {};
            const params = [snapshot];
            const sets = ['imported_snapshot = $1::jsonb', 'updated_at = now()'];
            FIELDS.forEach((field, index) => {
                if (overrides[field])
                    return;
                params.push(values[index]);
                sets.push(`${field} = $${params.length}`);
            });
            if (!overrides.retailer_id) {
                params.push(retailer.rows[0].id);
                sets.push(`retailer_id = $${params.length}`);
            }
            if (!overrides.category_id) {
                params.push(categoryId);
                sets.push(`category_id = $${params.length}`);
            }
            let flags = Array.isArray(old.review_flags) ? [...old.review_flags] : [];
            const material = oldNormalized && [...MATERIAL].some((field) => oldNormalized[field] !== record.normalized[field]);
            if (!overrides.review_flags) {
                flags = [...new Set([...record.flags, ...(flags.includes('MATERIAL_CHANGE') || material ? ['MATERIAL_CHANGE'] : [])])];
                params.push(flags);
                sets.push(`review_flags = $${params.length}`);
            }
            else if (material)
                sets.push("review_flags = array_append(array_remove(review_flags, 'MATERIAL_CHANGE'), 'MATERIAL_CHANGE')");
            if (material && old.status === 'PUBLISHED')
                sets.push("status = 'DRAFT'", 'published_at = NULL', 'featured = false');
            params.push(dealId);
            await client.query(`UPDATE deals SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
            outcome = 'updated';
        }
    }
    for (const source of record.sources) {
        await client.query(`INSERT INTO deal_sources (deal_id, source_name, source_url, source_ref, collected_at, import_job_id, raw, origin_record_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT (deal_id, source_ref) DO UPDATE SET source_name = EXCLUDED.source_name,
      source_url = EXCLUDED.source_url, collected_at = EXCLUDED.collected_at, import_job_id = EXCLUDED.import_job_id, raw = EXCLUDED.raw`, [dealId, source.name, source.url, source.ref, source.collectedAt, jobId, JSON.stringify(record.raw), record.sourceRecordId]);
    }
    return outcome;
}
function parseDataset(bytes) {
    let root;
    try {
        root = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw apiError('Could not read the file as JSON.');
    }
    let rows = root;
    if (root && !Array.isArray(root) && typeof root === 'object') {
        const container = Object.entries(root).find(([key, value]) => /^(records|deals|offers|items|data)$/.test(key) && Array.isArray(value));
        rows = container?.[1];
    }
    if (!Array.isArray(rows))
        throw apiError('Expected a JSON array of records (or an object containing one).');
    const records = [];
    const issues = [];
    const seen = new Set();
    rows.forEach((item, index) => {
        const row = index + 1;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            issues.push(issue(row, null, 'ERROR', 'Row is not a JSON object.'));
            return;
        }
        const raw = item;
        const sourceRecordId = text(raw, 'id');
        if (!sourceRecordId) {
            issues.push(issue(row, null, 'ERROR', 'Missing stable record id.'));
            return;
        }
        if (seen.has(sourceRecordId)) {
            issues.push(issue(row, sourceRecordId, 'ERROR', 'Duplicate record id within this file.'));
            return;
        }
        seen.add(sourceRecordId);
        const title = text(raw, 'title');
        const retailer = text(raw, 'retailer');
        if (!title) {
            issues.push(issue(row, sourceRecordId, 'ERROR', 'Missing product title.'));
            return;
        }
        if (!retailer) {
            issues.push(issue(row, sourceRecordId, 'ERROR', 'Missing retailer.'));
            return;
        }
        const flags = [];
        const addFlag = (value) => { const safe = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''); if (safe && !flags.includes(safe))
            flags.push(safe); };
        const moneyValue = (key) => {
            const input = text(raw, key);
            if (!input)
                return null;
            if (!/^\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(input)) {
                addFlag('PRICE_UNCLEAR');
                issues.push(issue(row, sourceRecordId, 'WARNING', `Price '${input}' (${key}) is ambiguous; left blank.`));
                return null;
            }
            return Number(input.replace(/[$,\s]/g, ''));
        };
        const values = {};
        const conditionText = text(raw, 'condition')?.toLowerCase() ?? '';
        values.title = title;
        values.variant = text(raw, 'variant');
        values.model = text(raw, 'model');
        values.condition_type = conditionText.includes('refurb') || conditionText.includes('renewed') || conditionText.includes('open box')
            ? 'REFURBISHED' : conditionText.includes('used') || conditionText.includes('pre-owned') ? 'USED' : conditionText.includes('new') ? 'NEW' : 'UNKNOWN';
        values.seller = text(raw, 'seller');
        const offerType = text(raw, 'offerType');
        values.offer_type = offerType?.toLowerCase().includes('store') ? 'STOREWIDE' : 'PRODUCT';
        if (!offerType)
            issues.push(issue(row, sourceRecordId, 'WARNING', 'No offer type in source; treated as a product deal.'));
        values.source_price_text = text(raw, 'sourcePriceText') ?? text(raw, 'sourcePrice');
        values.source_price = moneyValue('sourcePrice');
        values.listed_cash_price = moneyValue('listedCash');
        values.original_price_text = values.source_price_text;
        values.conditions_text = text(raw, 'conditions');
        values.reward_text = text(raw, 'reward');
        values.reward_amount = moneyValue('rewardAmount');
        values.reference_price = moneyValue('reference');
        values.reference_price_text = text(raw, 'referenceText');
        values.date_text = text(raw, 'dateText');
        let start = temporal(text(raw, 'start'));
        let end = temporal(text(raw, 'end'));
        if (text(raw, 'start') && !start || text(raw, 'end') && !end) {
            start = null;
            end = null;
            addFlag('DATES_UNCLEAR');
            issues.push(issue(row, sourceRecordId, 'WARNING', 'Date value(s) could not be parsed; kept original text only.'));
        }
        values.starts_on = start?.date ?? null;
        values.ends_on = end?.date ?? null;
        values.starts_at = start?.instant ?? null;
        values.ends_at = end?.instant ?? null;
        const anyDates = start || end;
        const declaredDate = text(raw, 'dateStatus')?.toUpperCase();
        const conflict = (values.starts_on && values.ends_on && String(values.starts_on) > String(values.ends_on))
            || (values.starts_at && values.ends_at && Date.parse(String(values.starts_at)) > Date.parse(String(values.ends_at)));
        values.date_status = conflict || declaredDate === 'CONFLICT' ? 'CONFLICT' : anyDates && declaredDate !== 'UNKNOWN' ? 'KNOWN' : 'UNKNOWN';
        if (values.date_status === 'CONFLICT')
            addFlag('DATES_CONFLICT');
        values.collected_at = instant(text(raw, 'collected'));
        values.retailer_verified_at = instant(text(raw, 'verifiedAt'));
        values.source_verification_status = text(raw, 'verification');
        values.candidate_group_key = text(raw, 'group');
        const rawFlags = value(raw, 'flags');
        if (Array.isArray(rawFlags))
            rawFlags.forEach((flag) => addFlag(String(flag)));
        else if (rawFlags)
            String(rawFlags).split(/[;,|]/).forEach(addFlag);
        const productUrl = text(raw, 'productUrl');
        values.product_url = productUrl ? (0, public_api_js_1.safeHttpUrl)(productUrl) : null;
        if (productUrl && !values.product_url)
            issues.push(issue(row, sourceRecordId, 'WARNING', 'Product URL was invalid and was ignored.'));
        const sources = [];
        const sourceNodes = value(raw, 'sources');
        if (Array.isArray(sourceNodes))
            sourceNodes.forEach((source, sourceIndex) => {
                const sourceObj = typeof source === 'object' && source ? source : null;
                const url = sourceObj ? pickString(sourceObj, ['url', 'link', 'source_url']) : typeof source === 'string' ? source : null;
                const safe = url ? (0, public_api_js_1.safeHttpUrl)(url) : null;
                if (url && !safe)
                    issues.push(issue(row, sourceRecordId, 'WARNING', 'Source URL was invalid and was ignored.'));
                sources.push({ name: sourceObj ? pickString(sourceObj, ['name', 'source', 'publisher']) : null,
                    url: safe, ref: (sourceObj && pickString(sourceObj, ['ref', 'reference', 'id'])) || safe || `source-${sourceIndex + 1}`,
                    collectedAt: values.collected_at });
            });
        if (!sources.length) {
            const url = text(raw, 'sourceUrl');
            sources.push({ name: text(raw, 'sourceName'), url: (0, public_api_js_1.safeHttpUrl)(url),
                ref: text(raw, 'sourceRef') || (0, public_api_js_1.safeHttpUrl)(url) || `import:${sourceRecordId}`, collectedAt: values.collected_at });
        }
        const normalized = {};
        for (const [key, val] of Object.entries(values))
            if (val !== null)
                normalized[key] = String(val);
        normalized.retailer = retailer;
        const category = text(raw, 'category');
        if (category)
            normalized.category = category;
        if (flags.length)
            normalized.review_flags = flags.join(',');
        records.push({ rowNumber: row, sourceRecordId, retailer, category, values, normalized, flags, sources, raw });
    });
    return { records, issues, totalRows: rows.length };
}
async function classify(pool, records) {
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const record of records) {
        const old = await pool.query('SELECT imported_snapshot FROM deals WHERE source_record_id = $1', [record.sourceRecordId]);
        if (!old.rows[0])
            counts.created++;
        else if (old.rows[0].imported_snapshot?.normalized && equalObjects(old.rows[0].imported_snapshot.normalized, record.normalized))
            counts.unchanged++;
        else
            counts.updated++;
    }
    return counts;
}
async function getJob(pool, id) {
    const result = await pool.query(`SELECT id, filename, sha256, adapter, status, total_rows, created_count, updated_count,
    unchanged_count, failed_count, warning_count, created_by, created_at, completed_at FROM import_jobs WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row)
        throw apiError('Import not found.', 404);
    return jobDto(row);
}
async function history(pool) {
    const result = await pool.query(`SELECT id, filename, sha256, adapter, status, total_rows, created_count, updated_count,
    unchanged_count, failed_count, warning_count, created_by, created_at, completed_at FROM import_jobs ORDER BY id DESC LIMIT 100`);
    return result.rows.map(jobDto);
}
function jobDto(row) {
    return { id: Number(row.id), filename: row.filename, sha256: row.sha256, adapter: row.adapter, status: row.status,
        totalRows: row.total_rows, created: row.created_count, updated: row.updated_count, unchanged: row.unchanged_count,
        failed: row.failed_count, warnings: row.warning_count, createdBy: row.created_by, createdAt: row.created_at, completedAt: row.completed_at };
}
function value(row, key) {
    for (const alias of ALIASES[key] ?? [key])
        if (row[alias] !== undefined && row[alias] !== null)
            return row[alias];
    return undefined;
}
function text(row, key) {
    const item = value(row, key);
    if (item === undefined || item === null || typeof item === 'object')
        return null;
    const result = String(item).trim();
    return result || null;
}
function pickString(row, keys) {
    for (const key of keys)
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim())
            return String(row[key]).trim();
    return null;
}
function temporal(value) {
    if (!value)
        return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
        return { date: value };
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)))
        return { instant: value };
    return null;
}
function instant(value) { return temporal(value)?.instant ?? null; }
function issue(row, sourceRecordId, severity, message) {
    return { row, sourceRecordId, severity, message };
}
function slug(value) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}
function equalObjects(a, b) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && a[key] === b[key]);
}
function parseId(raw) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1)
        throw apiError('Import not found.', 404);
    return id;
}
function apiError(message, status = 400) {
    return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' });
}
