"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupImportChunks = exports.expireDueOffers = exports.api = void 0;
const express_1 = __importDefault(require("express"));
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_api_js_1 = require("./firestore-api.js");
const firestore_admin_js_1 = require("./firestore-admin.js");
const firestore_access_js_1 = require("./firestore-access.js");
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: '1mb' }));
(0, firestore_access_js_1.registerDealAccessGuard)(app);
(0, firestore_api_js_1.registerFirestoreApi)(app);
(0, firestore_admin_js_1.registerFirestoreAdminApi)(app);
(0, firestore_api_js_1.registerFirestoreErrors)(app);
app.use((_req, res) => {
    res.status(404).json({ status: 404, code: 'NOT_FOUND', message: 'Not found.' });
});
exports.api = (0, https_1.onRequest)({
    region: 'us-east1',
    maxInstances: 2,
    concurrency: 10,
    memory: '512MiB',
    timeoutSeconds: 540,
    secrets: ['APP_ADMIN_USERNAME'],
}, app);
exports.expireDueOffers = (0, scheduler_1.onSchedule)({
    schedule: 'every 1 minutes',
    timeZone: 'Etc/UTC',
    region: 'us-east1',
    maxInstances: 1,
}, async () => {
    const db = (0, firestore_1.getFirestore)();
    const published = await db.collection('dealmein_deals').where('expiresAt', '<=', new Date()).limit(250).get();
    const batch = db.batch();
    let count = 0;
    for (const doc of published.docs) {
        const data = doc.data();
        if (data.status !== 'PUBLISHED' || data.dateStatus !== 'KNOWN')
            continue;
        if ((0, firestore_api_js_1.timingFor)(data) !== 'expired')
            continue;
        batch.update(doc.ref, { status: 'EXPIRED', featured: false, expiresAt: firestore_1.FieldValue.delete(), updatedAt: firestore_1.FieldValue.serverTimestamp() });
        batch.set(db.collection('dealmein_auditEvents').doc(), { actor: 'system', action: 'DEAL_AUTO_EXPIRED', entityType: 'deal',
            entityId: Number(doc.id), details: {}, createdAt: firestore_1.FieldValue.serverTimestamp() });
        count++;
        if (count === 250)
            break;
    }
    if (count)
        await batch.commit();
});
exports.cleanupImportChunks = (0, scheduler_1.onSchedule)({
    schedule: 'every 24 hours',
    timeZone: 'Etc/UTC',
    region: 'us-east1',
    maxInstances: 1,
}, async () => {
    const db = (0, firestore_1.getFirestore)();
    const expired = await db.collection('dealmein_importUploads').where('expiresAt', '<=', new Date()).limit(100).get();
    for (const session of expired.docs) {
        const chunks = await session.ref.collection('chunks').limit(400).get();
        const batch = db.batch();
        chunks.docs.forEach((chunk) => batch.delete(chunk.ref));
        if (!chunks.empty)
            await batch.commit();
        await session.ref.delete();
    }
});
