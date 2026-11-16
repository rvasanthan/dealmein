"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFirestoreImportApi = registerFirestoreImportApi;
exports.parseImport = parseImport;
exports.applyRecordsBulk = applyRecordsBulk;
const node_crypto_1 = require("node:crypto");
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const firestore_1 = require("firebase-admin/firestore");
const firestore_api_js_1 = require("./firestore-api.js");
const MAX_BYTES = 25 * 1024 * 1024;
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
const CHUNK_BYTES = 256 * 1024;
const MAX_CHUNKS = 100;
const aliases = {
    id: ['id', 'record_id', 'recordId', 'source_record_id', 'offer_id', 'deal_id'],
    title: ['title', 'product_title', 'product', 'name', 'product_name'], variant: ['variant', 'variants', 'variant_text', 'options'],
    model: ['model', 'model_number', 'mpn', 'sku'], condition: ['condition', 'item_condition'], retailer: ['retailer', 'store', 'retailer_name', 'merchant'],
    seller: ['seller', 'sold_by'], category: ['category', 'category_name', 'department'], offerType: ['offer_type', 'deal_type', 'type'],
    sourcePrice: ['source_price', 'source_reported_price', 'reported_price', 'price', 'sale_price'], sourcePriceText: ['source_price_text', 'price_text', 'original_price_text', 'price_raw'],
    listedCashPrice: ['listed_cash_price', 'cash_price', 'listed_price'], conditions: ['conditions', 'conditions_text', 'terms', 'notes', 'price_conditions'],
    reward: ['reward_text', 'rebate_text', 'gift_card_text', 'rewards'], rewardAmount: ['reward_amount', 'rebate_amount', 'gift_card_amount'],
    referencePrice: ['reference_price', 'advertised_reference_price', 'original_price', 'list_price', 'was_price'], referencePriceText: ['reference_price_text'],
    start: ['start_date', 'sale_start', 'starts_on', 'starts_at', 'valid_from'], end: ['end_date', 'sale_end', 'ends_on', 'ends_at', 'expires', 'valid_until'],
    dateText: ['date_text', 'sale_dates', 'dates', 'original_date_text', 'timing'], dateStatus: ['date_status'],
    collected: ['collected_at', 'collected', 'scraped_at', 'captured_at'], retailerVerifiedAt: ['retailer_verified_at', 'verified_at'],
    verification: ['verification_status', 'verification', 'verified'],
    flags: ['review_flags', 'flags', 'review_notes'], candidateGroupKey: ['candidate_group', 'candidate_group_id', 'related_group', 'group_id', 'possible_product_group'],
    productUrl: ['product_url', 'retailer_url', 'retailer_product_url'], imageUrl: ['image_url'], sources: ['sources', 'source_references'],
    sourceName: ['source_name', 'source', 'publisher'], sourceUrl: ['source_url', 'source_link', 'listing_url', 'url', 'link'],
    sourceRef: ['source_ref', 'source_reference', 'source_id', 'source_locator'], publishReady: ['publish_ready'],
};
const dealFields = ['title', 'variant', 'model', 'condition', 'seller', 'offerType', 'sourcePrice', 'sourcePriceText', 'listedCashPrice',
    'originalPriceText', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice', 'startsOn', 'endsOn', 'startsAt', 'endsAt',
    'dateText', 'dateStatus', 'collectedAt', 'sourceVerificationStatus', 'candidateGroupKey', 'productUrl'];
const materialFields = new Set(['sourcePrice', 'sourcePriceText', 'listedCashPrice', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice', 'startsOn', 'endsOn', 'startsAt', 'endsAt']);
async function createPreviewJob(bytes, originalFilename, actor) {
    if (!bytes.length)
        throw apiError('The uploaded file is empty.');
    if (bytes.length > MAX_BYTES)
        throw Object.assign(new Error('Import file is too large.'), { status: 413, code: 'FILE_TOO_LARGE' });
    await (0, firestore_api_js_1.ensureDefaultCategories)();
    const parsed = parseImport(bytes);
    const existingById = await existingDealsBySourceId(parsed.records.map((record) => record.sourceRecordId));
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const record of parsed.records) {
        const existing = existingById.get(record.sourceRecordId);
        if (!existing)
            counts.created++;
        else if (same(existing.importedSnapshot?.normalized ?? {}, record.normalized))
            counts.unchanged++;
        else
            counts.updated++;
    }
    const filename = originalFilename.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 255);
    const id = await reserveCounterRange('importJobs', 1);
    const payloadName = String(id);
    await savePayloadChunks(payloadName, bytes);
    const job = { id, filename, sha256: (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex'), adapter: 'json-snapshot', status: 'PREVIEW',
        totalRows: parsed.totalRows, ...counts, failed: parsed.issues.filter((issue) => issue.severity === 'ERROR').length,
        warnings: parsed.issues.filter((issue) => issue.severity === 'WARNING').length, createdBy: actor,
        createdAt: firestore_1.FieldValue.serverTimestamp(), payloadName };
    const ref = firestore_api_js_1.db.collection('dealmein_importJobs').doc(String(id));
    await ref.set(job);
    const savedIssues = parsed.issues.slice(0, 5000);
    for (let offset = 0; offset < savedIssues.length; offset += 450) {
        const batch = firestore_api_js_1.db.batch();
        savedIssues.slice(offset, offset + 450).forEach((issue) => batch.set(ref.collection('issues').doc(), {
            rowNumber: issue.row, sourceRecordId: issue.sourceRecordId, severity: issue.severity, message: issue.message,
        }));
        await batch.commit();
    }
    return jobDto(job);
}
function registerFirestoreImportApi(app) {
    app.post('/api/admin/deals', async (req, res, next) => {
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
                throw apiError('A product object is required.');
            const productUrl = req.body.product_url ?? req.body.productUrl;
            if (productUrl && (typeof productUrl !== 'string' || !safeHttp(productUrl)))
                throw apiError('The retailer product URL must be an http or https URL.');
            const imageUrl = req.body.image_url ?? req.body.imageUrl;
            if (imageUrl && (typeof imageUrl !== 'string' || !safeHttp(imageUrl)))
                throw apiError('The image URL must be an http or https URL.');
            const sourceRecordId = `manual:${(0, node_crypto_1.randomUUID)()}`;
            const parsed = parseImport(Buffer.from(JSON.stringify([{ ...req.body, id: sourceRecordId }])));
            if (!parsed.records.length)
                throw apiError(parsed.issues[0]?.message ?? 'Invalid product.');
            await (0, firestore_api_js_1.ensureDefaultCategories)();
            await applyRecordsBulk(parsed.records);
            const created = (await existingDealsBySourceId([sourceRecordId])).get(sourceRecordId);
            if (!created)
                throw apiError('The product was saved but could not be retrieved.', 500);
            await writeAudit(res.locals.actor, 'DEAL_CREATED', 'deal', Number(created.__docId), { sourceRecordId });
            res.status(201).json({ id: Number(created.__docId), sourceRecordId });
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/imports/upload-chunk', express_1.default.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES }), async (req, res, next) => {
        try {
            const sessionId = req.header('x-upload-session') ?? '';
            const index = Number(req.header('x-upload-index'));
            const total = Number(req.header('x-upload-total'));
            if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !Number.isInteger(index) || !Number.isInteger(total)
                || total < 1 || total > MAX_CHUNKS || index < 0 || index >= total)
                throw apiError('Invalid upload chunk metadata.');
            const bytes = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
            if (!bytes.length)
                throw apiError('The upload chunk is empty.');
            const session = firestore_api_js_1.db.collection('dealmein_importUploads').doc(sessionId);
            await session.set({ totalChunks: total, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                uploadedBy: res.locals.actor, updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
            await session.collection('chunks').doc(String(index).padStart(3, '0')).set({ index, data: bytes.toString('base64'), byteLength: bytes.length });
            res.json({ ok: true, index });
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/imports/preview-chunks', async (req, res, next) => {
        try {
            const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
            const total = Number(req.body?.totalChunks);
            if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS)
                throw apiError('Invalid upload session.');
            const sessionRef = firestore_api_js_1.db.collection('dealmein_importUploads').doc(sessionId);
            const session = await sessionRef.get();
            if (!session.exists || session.get('totalChunks') !== total || session.get('uploadedBy') !== res.locals.actor)
                throw apiError('Upload session was not found or is incomplete.', 400);
            const chunkSnapshot = await sessionRef.collection('chunks').get();
            if (chunkSnapshot.size !== total)
                throw apiError('Upload is incomplete. Please retry it.');
            const chunkMap = new Map(chunkSnapshot.docs.map((doc) => [Number(doc.get('index')), String(doc.get('data'))]));
            if (Array.from({ length: total }, (_, index) => index).some((index) => !chunkMap.has(index)))
                throw apiError('Upload is incomplete. Please retry it.');
            const buffers = Array.from({ length: total }, (_, index) => Buffer.from(chunkMap.get(index), 'base64'));
            const payload = Buffer.concat(buffers);
            if (payload.length > MAX_BYTES)
                throw Object.assign(new Error('Import file is too large.'), { status: 413, code: 'FILE_TOO_LARGE' });
            const filename = typeof req.body?.filename === 'string' ? req.body.filename : 'upload.json';
            const job = await createPreviewJob(payload, filename, res.locals.actor);
            await deleteCollection(sessionRef.collection('chunks'));
            await sessionRef.delete();
            res.json(job);
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/imports', async (_req, res, next) => {
        try {
            const snap = await firestore_api_js_1.db.collection('dealmein_importJobs').orderBy('id', 'desc').limit(100).get();
            res.json(snap.docs.map((doc) => jobDto(doc.data())));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/imports/:id', async (req, res, next) => {
        try {
            res.json(await loadJob(req.params.id));
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/api/admin/imports/:id/issues', async (req, res, next) => {
        try {
            const job = await firestore_api_js_1.db.collection('dealmein_importJobs').doc(req.params.id).get();
            if (!job.exists)
                throw apiError('Import not found.', 404);
            const severity = typeof req.query.severity === 'string' ? req.query.severity.toUpperCase() : '';
            const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
            const snap = await job.ref.collection('issues').orderBy('rowNumber').limit(limit).get();
            const issues = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
            res.json(issues.filter((issue) => !severity || issue.severity === severity));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/imports/preview', upload.single('file'), async (req, res, next) => {
        try {
            if (!req.file?.buffer.length)
                throw apiError('The uploaded file is empty.');
            res.json(await createPreviewJob(req.file.buffer, req.file.originalname || 'upload.json', res.locals.actor));
        }
        catch (error) {
            next(error);
        }
    });
    app.post('/api/admin/imports/:id/commit', async (req, res, next) => {
        try {
            const ref = firestore_api_js_1.db.collection('dealmein_importJobs').doc(String(Number(req.params.id)));
            const jobSnap = await ref.get();
            if (!jobSnap.exists)
                throw apiError('Import not found.', 404);
            const job = jobSnap.data();
            if (job.status !== 'PREVIEW')
                throw Object.assign(new Error('This import has already been applied.'), { status: 409, code: 'CONFLICT' });
            const bytes = await loadPayloadChunks(String(job.payloadName));
            const parsed = parseImport(bytes);
            await ref.update({ status: 'COMMITTING' });
            let counts;
            try {
                counts = await applyRecordsBulk(parsed.records);
            }
            catch (error) {
                await ref.update({ status: 'PREVIEW' }).catch(() => { });
                throw error;
            }
            await ref.update({ ...counts, status: 'COMPLETED', completedAt: firestore_1.FieldValue.serverTimestamp(), payloadName: firestore_1.FieldValue.delete() });
            await deleteCollection(firestore_api_js_1.db.collection('dealmein_importPayloads').doc(String(job.payloadName)).collection('chunks'));
            await writeAudit(res.locals.actor, 'IMPORT_COMMITTED', 'import', job.id, counts);
            res.json(jobDto({ ...job, ...counts, status: 'COMPLETED', payloadName: undefined }));
        }
        catch (error) {
            next(error);
        }
    });
}
function parseImport(bytes) {
    let root;
    try {
        root = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        throw apiError('Could not read the file as JSON.');
    }
    let rows = root;
    if (root && !Array.isArray(root) && typeof root === 'object') {
        rows = Object.entries(root).find(([key, value]) => /^(records|deals|offers|items|data)$/.test(key) && Array.isArray(value))?.[1];
    }
    if (!Array.isArray(rows))
        throw apiError('Expected a JSON array of records (or an object containing one).');
    const records = [];
    const issues = [];
    const ids = new Set();
    rows.forEach((value, index) => {
        const row = index + 1;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            issues.push(issue(row, null, 'ERROR', 'Row is not a JSON object.'));
            return;
        }
        const raw = value;
        const sourceRecordId = text(raw, 'id');
        if (!sourceRecordId) {
            issues.push(issue(row, null, 'ERROR', 'Missing stable record id.'));
            return;
        }
        if (ids.has(sourceRecordId)) {
            issues.push(issue(row, sourceRecordId, 'ERROR', 'Duplicate record id within this file.'));
            return;
        }
        ids.add(sourceRecordId);
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
        const addFlag = (input) => { const flag = String(input).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''); if (flag && !flags.includes(flag))
            flags.push(flag); };
        const money = (key) => {
            const value = text(raw, key);
            if (!value)
                return null;
            if (!/^\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(value)) {
                addFlag('PRICE_UNCLEAR');
                issues.push(issue(row, sourceRecordId, 'WARNING', `Price '${value}' (${key}) is ambiguous; left blank.`));
                return null;
            }
            return Number(value.replace(/[$,\s]/g, ''));
        };
        const conditionText = (text(raw, 'condition') ?? '').toLowerCase();
        const data = {
            title, variant: text(raw, 'variant'), model: text(raw, 'model'), condition: conditionText.includes('refurb') || conditionText.includes('renewed') || conditionText.includes('open box') ? 'REFURBISHED' : conditionText.includes('used') ? 'USED' : conditionText.includes('new') ? 'NEW' : 'UNKNOWN',
            seller: text(raw, 'seller'), offerType: (text(raw, 'offerType') ?? '').toLowerCase().includes('store') ? 'STOREWIDE' : 'PRODUCT',
            sourcePrice: money('sourcePrice'), sourcePriceText: text(raw, 'sourcePriceText') ?? text(raw, 'sourcePrice'),
            listedCashPrice: money('listedCashPrice'), originalPriceText: text(raw, 'sourcePriceText') ?? text(raw, 'sourcePrice'),
            conditionsText: text(raw, 'conditions'), rewardText: text(raw, 'reward'), rewardAmount: money('rewardAmount'),
            referencePrice: money('referencePrice'), referencePriceText: text(raw, 'referencePriceText'), dateText: text(raw, 'dateText'),
            dateStatus: 'UNKNOWN', collectedAt: parseInstant(text(raw, 'collected')), retailerVerifiedAt: parseInstant(text(raw, 'retailerVerifiedAt')),
            sourceVerificationStatus: text(raw, 'verification'),
            candidateGroupKey: text(raw, 'candidateGroupKey'), productUrl: safeHttp(text(raw, 'productUrl')), imageUrl: safeHttp(text(raw, 'imageUrl')),
        };
        const start = temporal(text(raw, 'start'));
        const end = temporal(text(raw, 'end'));
        const rawStart = text(raw, 'start');
        const rawEnd = text(raw, 'end');
        if (rawStart && !start || rawEnd && !end) {
            addFlag('DATES_UNCLEAR');
            issues.push(issue(row, sourceRecordId, 'WARNING', 'Date value(s) could not be parsed; kept original text only.'));
        }
        data.startsOn = start?.date ?? null;
        data.startsAt = start?.instant ?? null;
        data.endsOn = end?.date ?? null;
        data.endsAt = end?.instant ?? null;
        const anyDates = start || end;
        const startsAfterEnds = Boolean(data.startsOn && data.endsOn && String(data.startsOn) > String(data.endsOn))
            || Boolean(data.startsAt && data.endsAt && Date.parse(String(data.startsAt)) > Date.parse(String(data.endsAt)));
        const declaredDateStatus = text(raw, 'dateStatus')?.toUpperCase();
        data.dateStatus = startsAfterEnds || declaredDateStatus === 'CONFLICT' ? 'CONFLICT' : anyDates && declaredDateStatus !== 'UNKNOWN' ? 'KNOWN' : 'UNKNOWN';
        if (data.dateStatus === 'CONFLICT')
            addFlag('DATES_CONFLICT');
        const rawFlags = valueFor(raw, 'flags');
        if (Array.isArray(rawFlags))
            rawFlags.forEach(addFlag);
        else if (rawFlags)
            String(rawFlags).split(/[;,|]/).forEach(addFlag);
        if (!text(raw, 'offerType') && valueFor(raw, 'publishReady') === null)
            issues.push(issue(row, sourceRecordId, 'WARNING', 'No offer type in source; treated as a product deal.'));
        const category = text(raw, 'category');
        const normalized = {};
        for (const [key, val] of Object.entries(data))
            if (val !== null && val !== undefined)
                normalized[key] = String(val);
        normalized.retailer = retailer;
        if (category)
            normalized.category = category;
        if (flags.length)
            normalized.reviewFlags = flags.join(',');
        const sourceNodes = valueFor(raw, 'sources');
        const sources = Array.isArray(sourceNodes) ? sourceNodes.map((source, sourceIndex) => {
            const item = typeof source === 'object' && source ? source : null;
            const url = item ? strFrom(item, ['url', 'link', 'source_url']) : typeof source === 'string' ? source : null;
            return { name: item ? strFrom(item, ['name', 'source', 'publisher', 'source_name']) : null, url: safeHttp(url),
                ref: (item && strFrom(item, ['ref', 'reference', 'id', 'source_locator'])) || safeHttp(url) || `source-${sourceIndex + 1}`, collectedAt: data.collectedAt };
        }) : [{ name: text(raw, 'sourceName'), url: safeHttp(text(raw, 'sourceUrl')),
                ref: text(raw, 'sourceRef') || safeHttp(text(raw, 'sourceUrl')) || `import:${sourceRecordId}`, collectedAt: data.collectedAt }];
        records.push({ row, sourceRecordId, retailer, category, data, normalized, flags, sources, raw });
    });
    return { records, issues, totalRows: rows.length };
}
async function existingDealsBySourceId(sourceIds) {
    const found = new Map();
    const chunks = [];
    for (let offset = 0; offset < sourceIds.length; offset += 30)
        chunks.push(sourceIds.slice(offset, offset + 30));
    for (let offset = 0; offset < chunks.length; offset += 8) {
        const results = await Promise.all(chunks.slice(offset, offset + 8).map((chunk) => firestore_api_js_1.db.collection('dealmein_deals').where('sourceRecordId', 'in', chunk).get()));
        for (const result of results)
            for (const doc of result.docs)
                found.set(String(doc.get('sourceRecordId')), { ...doc.data(), __docId: doc.id });
    }
    return found;
}
async function getAllInChunks(refs) {
    const docs = [];
    for (let offset = 0; offset < refs.length; offset += 100)
        docs.push(...await firestore_api_js_1.db.getAll(...refs.slice(offset, offset + 100)));
    return docs;
}
async function savePayloadChunks(payloadId, bytes) {
    const parent = firestore_api_js_1.db.collection('dealmein_importPayloads').doc(payloadId);
    const chunkCount = Math.ceil(bytes.length / CHUNK_BYTES);
    for (let offset = 0; offset < chunkCount; offset += 400) {
        const batch = firestore_api_js_1.db.batch();
        for (let index = offset; index < Math.min(offset + 400, chunkCount); index++) {
            const start = index * CHUNK_BYTES;
            const chunk = bytes.subarray(start, Math.min(start + CHUNK_BYTES, bytes.length));
            batch.set(parent.collection('chunks').doc(String(index).padStart(3, '0')), {
                index, data: chunk.toString('base64'), byteLength: chunk.length,
            });
        }
        await batch.commit();
    }
    await parent.set({ chunkCount, byteLength: bytes.length, createdAt: firestore_1.FieldValue.serverTimestamp() });
}
async function loadPayloadChunks(payloadId) {
    const parent = firestore_api_js_1.db.collection('dealmein_importPayloads').doc(payloadId);
    const meta = await parent.get();
    if (!meta.exists)
        throw apiError('The stored import payload is missing.', 404);
    const count = Number(meta.get('chunkCount'));
    const snapshot = await parent.collection('chunks').orderBy('index').get();
    if (!Number.isInteger(count) || count < 1 || snapshot.size !== count)
        throw apiError('The stored import payload is incomplete.', 500);
    const buffers = snapshot.docs.map((doc, index) => {
        if (Number(doc.get('index')) !== index)
            throw apiError('The stored import payload is incomplete.', 500);
        return Buffer.from(String(doc.get('data')), 'base64');
    });
    return Buffer.concat(buffers);
}
async function deleteCollection(collection) {
    const snapshot = await collection.limit(400).get();
    if (snapshot.empty)
        return;
    const batch = firestore_api_js_1.db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snapshot.size === 400)
        await deleteCollection(collection);
}
async function reserveCounterRange(name, count) {
    const ref = firestore_api_js_1.db.collection('dealmein_counters').doc(name);
    return firestore_api_js_1.db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        const last = Number(doc.get('value') ?? 0);
        tx.set(ref, { value: last + count });
        return last + 1;
    });
}
async function applyRecordsBulk(records) {
    const existing = await existingDealsBySourceId(records.map((record) => record.sourceRecordId));
    const counts = { created: 0, updated: 0, unchanged: 0 };
    const retailerSlugs = [...new Set(records.map((record) => slugify(record.retailer)))];
    const categorySlugs = [...new Set(records.map((record) => slugify(record.category ?? 'other')))];
    const retailerDocs = await getAllInChunks(retailerSlugs.map((slug) => firestore_api_js_1.db.collection('dealmein_retailers').doc(slug)));
    const categoryDocs = await getAllInChunks(categorySlugs.map((slug) => firestore_api_js_1.db.collection('dealmein_categories').doc(slug)));
    const retailers = new Map(retailerSlugs.map((slug, index) => [slug, retailerDocs[index]]));
    const categories = new Map(categorySlugs.map((slug, index) => [slug, categoryDocs[index]]));
    const missingRetailers = retailerSlugs.filter((slug) => !retailers.get(slug)?.exists);
    const missingCategories = categorySlugs.filter((slug) => slug !== 'other' && !categories.get(slug)?.exists);
    const newDealCount = records.filter((record) => !existing.has(record.sourceRecordId)).length;
    const [retailerStart, dealStart, lastCategory] = await Promise.all([
        missingRetailers.length ? reserveCounterRange('retailers', missingRetailers.length) : Promise.resolve(0),
        newDealCount ? reserveCounterRange('deals', newDealCount) : Promise.resolve(0),
        firestore_api_js_1.db.collection('dealmein_categories').orderBy('sortOrder', 'desc').limit(1).get(),
    ]);
    let nextCategoryOrder = Number(lastCategory.docs[0]?.get('sortOrder') ?? 0) + 1;
    const retailerIds = new Map(missingRetailers.map((slug, index) => [slug, retailerStart + index]));
    const categoryNames = new Map(records.filter((record) => record.category).map((record) => [slugify(record.category), record.category]));
    const writer = firestore_api_js_1.db.bulkWriter();
    const scheduledRetailers = new Set();
    const scheduledCategories = new Set();
    let nextDealId = dealStart;
    for (const record of records) {
        const retailerSlug = slugify(record.retailer);
        const retailerSnapshot = retailers.get(retailerSlug);
        const retailerTimezone = retailerSnapshot.exists ? retailerSnapshot.get('timezone') ?? null : process.env.APP_DEFAULT_RETAILER_TIMEZONE || 'America/New_York';
        if (!retailerSnapshot.exists && !scheduledRetailers.has(retailerSlug)) {
            scheduledRetailers.add(retailerSlug);
            writer.set(firestore_api_js_1.db.collection('dealmein_retailers').doc(retailerSlug), { id: retailerIds.get(retailerSlug), name: record.retailer,
                slug: retailerSlug, timezone: retailerTimezone, createdAt: firestore_1.FieldValue.serverTimestamp() });
        }
        const categorySlug = slugify(record.category ?? 'other');
        const categorySnapshot = categories.get(categorySlug);
        const categoryName = categorySnapshot?.exists ? categorySnapshot.get('name') : categoryNames.get(categorySlug);
        const category = categoryName ? { name: categoryName, slug: categorySlug } : { name: 'Other', slug: 'other' };
        if (!categorySnapshot?.exists && categorySlug !== 'other' && !scheduledCategories.has(categorySlug)) {
            scheduledCategories.add(categorySlug);
            writer.set(firestore_api_js_1.db.collection('dealmein_categories').doc(categorySlug), {
                name: categoryName, slug: categorySlug, sortOrder: nextCategoryOrder++,
            });
        }
        const flags = new Set(record.flags);
        if (!record.category)
            flags.add('CATEGORY_UNMATCHED');
        const previous = existing.get(record.sourceRecordId);
        let ref;
        if (!previous) {
            ref = firestore_api_js_1.db.collection('dealmein_deals').doc(String(nextDealId++));
            counts.created++;
            const timing = { ...record.data, retailerTimezone };
            writer.set(ref, { id: Number(ref.id), sourceRecordId: record.sourceRecordId, title: record.data.title,
                retailer: { name: record.retailer, slug: retailerSlug }, retailerTimezone, category, status: (0, firestore_api_js_1.timingFor)(timing) === 'expired' ? 'EXPIRED' : 'PUBLISHED', featured: false,
                publishedAt: firestore_1.FieldValue.serverTimestamp(), expiresAt: (0, firestore_api_js_1.expiryDateFor)(timing), reviewFlags: [...flags], overrides: {}, importedSnapshot: { normalized: record.normalized, raw: record.raw },
                createdAt: firestore_1.FieldValue.serverTimestamp(), updatedAt: firestore_1.FieldValue.serverTimestamp(), ...record.data });
        }
        else {
            ref = firestore_api_js_1.db.collection('dealmein_deals').doc(String(previous.__docId));
            if (same(previous.importedSnapshot?.normalized ?? {}, record.normalized))
                counts.unchanged++;
            else {
                counts.updated++;
                const overrides = previous.overrides ?? {};
                const update = Object.fromEntries(Object.entries(record.data).filter(([field]) => !overrides[field]));
                const material = [...materialFields].some((field) => previous.importedSnapshot?.normalized?.[field] !== record.normalized[field]);
                const mergedFlags = new Set([...(previous.reviewFlags ?? []), ...flags]);
                if (material)
                    mergedFlags.add('MATERIAL_CHANGE');
                writer.update(ref, { ...update,
                    retailer: overrides.retailer ? previous.retailer : { name: record.retailer, slug: retailerSlug },
                    retailerTimezone, category: overrides.category ? previous.category : category,
                    importedSnapshot: { normalized: record.normalized, raw: record.raw }, reviewFlags: [...mergedFlags], updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    ...(previous.status === 'PUBLISHED' ? { expiresAt: (0, firestore_api_js_1.expiryDateFor)({ ...previous, ...update, retailerTimezone }) } : {}) });
            }
        }
        record.sources.forEach((source, index) => writer.set(ref.collection('sources').doc(slugify(source.ref)), {
            id: index + 1, ...source, raw: record.raw, originRecordId: record.sourceRecordId,
        }));
    }
    await writer.close();
    return counts;
}
async function loadJob(id) { const doc = await firestore_api_js_1.db.collection('dealmein_importJobs').doc(String(Number(id))).get(); if (!doc.exists)
    throw apiError('Import not found.', 404); return jobDto(doc.data()); }
function jobDto(job) {
    return { id: Number(job.id), filename: job.filename, sha256: job.sha256, adapter: job.adapter,
        status: job.status, totalRows: job.totalRows, created: job.created ?? 0, updated: job.updated ?? 0, unchanged: job.unchanged ?? 0,
        failed: job.failed ?? 0, warnings: job.warnings ?? 0, createdBy: job.createdBy, createdAt: (0, firestore_api_js_1.asIso)(job.createdAt), completedAt: (0, firestore_api_js_1.asIso)(job.completedAt) };
}
async function writeAudit(actor, action, entityType, entityId, details) {
    await firestore_api_js_1.db.collection('dealmein_auditEvents').add({ actor, action, entityType, entityId, details, createdAt: firestore_1.FieldValue.serverTimestamp() });
}
function issue(row, sourceRecordId, severity, message) { return { row, sourceRecordId, severity, message }; }
function valueFor(row, key) { for (const name of aliases[key] ?? [key])
    if (row[name] !== null && row[name] !== undefined)
        return row[name]; return null; }
function text(row, key) { const value = valueFor(row, key); if (value === null || typeof value === 'object')
    return null; return String(value).trim() || null; }
function strFrom(row, names) { for (const name of names)
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim())
        return String(row[name]).trim(); return null; }
function temporal(value) { if (!value)
    return null; if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return { date: value }; if (!Number.isNaN(Date.parse(value)) && /(Z|[+-]\d{2}:?\d{2})$/i.test(value))
    return { instant: value }; return null; }
function parseInstant(value) { return temporal(value)?.instant ?? null; }
function safeHttp(value) { if (!value)
    return null; try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? value : null;
}
catch {
    return null;
} }
function slugify(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'; }
function same(a, b) { const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((key, index) => key === kb[index] && a[key] === b[key]); }
function apiError(message, status = 400) { return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' }); }
