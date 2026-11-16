"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerImageRoutes = registerImageRoutes;
const node_crypto_1 = require("node:crypto");
const multer_1 = __importDefault(require("multer"));
const storage_1 = require("firebase-admin/storage");
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
function registerImageRoutes(app, getPool) {
    app.post('/api/admin/deals/:id/image', upload.single('file'), async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isSafeInteger(id) || id < 1)
                throw apiError('Deal not found.', 404);
            const file = req.file;
            if (!file?.buffer.length)
                throw apiError('Choose an image to upload.');
            const detected = detectImage(file.buffer);
            if (!detected)
                throw Object.assign(new Error('Only JPEG, PNG or WebP images are accepted.'), { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
            const pool = await getPool();
            const found = await pool.query('SELECT id FROM deals WHERE id = $1', [id]);
            if (!found.rows[0])
                throw apiError('Deal not found.', 404);
            const name = `${(0, node_crypto_1.randomUUID)()}.${detected.extension}`;
            const object = (0, storage_1.getStorage)().bucket().file(`uploads/${name}`);
            await object.save(file.buffer, {
                resumable: false,
                metadata: {
                    contentType: detected.contentType,
                    cacheControl: 'public,max-age=31536000,immutable',
                },
            });
            const path = `/uploads/${name}`;
            await pool.query('UPDATE deals SET image_url = $2, image_authorized = false, updated_at = now() WHERE id = $1', [id, path]);
            await pool.query(`INSERT INTO admin_audit_events (actor, action, entity_type, entity_id, details)
        VALUES ($1, 'DEAL_IMAGE_UPLOADED', 'deal', $2, $3::jsonb)`, [res.locals.actor, String(id), JSON.stringify({ path })]);
            res.json({ imageUrl: path, note: 'Confirm the image is authorized before it will be shown publicly.' });
        }
        catch (error) {
            next(error);
        }
    });
    app.get('/uploads/:name', async (req, res, next) => {
        try {
            if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(req.params.name)) {
                res.status(404).end();
                return;
            }
            const object = (0, storage_1.getStorage)().bucket().file(`uploads/${req.params.name}`);
            const [bytes] = await object.download();
            const [metadata] = await object.getMetadata();
            res.set('Content-Type', String(metadata.contentType ?? 'application/octet-stream'))
                .set('Cache-Control', 'public,max-age=31536000,immutable')
                .send(bytes);
        }
        catch (error) {
            if (error.code === 404) {
                res.status(404).end();
                return;
            }
            next(error);
        }
    });
}
function detectImage(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { extension: 'jpg', contentType: 'image/jpeg' };
    }
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG'
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return { extension: 'png', contentType: 'image/png' };
    }
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        return { extension: 'webp', contentType: 'image/webp' };
    }
    return null;
}
function apiError(message, status = 400) {
    return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' });
}
