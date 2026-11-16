"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFavoritesApi = registerFavoritesApi;
const firestore_1 = require("firebase-admin/firestore");
const firestore_api_js_1 = require("./firestore-api.js");
function registerFavoritesApi(app) {
    const favorites = (uid) => firestore_api_js_1.db.collection('dealmein_userFavorites').doc(uid).collection('deals');
    app.get('/api/favorites', async (_req, res, next) => {
        try {
            const snapshot = await favorites(res.locals.user.uid).orderBy('addedAt', 'desc').get();
            res.json(snapshot.docs.map((doc) => Number(doc.id)).filter((id) => Number.isSafeInteger(id) && id > 0));
        }
        catch (error) {
            next(error);
        }
    });
    app.put('/api/favorites/:id', async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
                res.status(400).json({ status: 400, code: 'BAD_REQUEST', message: 'Invalid deal ID.' });
                return;
            }
            const deal = await firestore_api_js_1.db.collection('dealmein_deals').doc(String(id)).get();
            if (!deal.exists || !(0, firestore_api_js_1.isPublicDeal)(deal.data())) {
                res.status(404).json({ status: 404, code: 'NOT_FOUND', message: 'Deal not found.' });
                return;
            }
            await favorites(res.locals.user.uid).doc(String(id)).set({ addedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
            res.json({ id, favorite: true });
        }
        catch (error) {
            next(error);
        }
    });
    app.delete('/api/favorites/:id', async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) {
                res.status(400).json({ status: 400, code: 'BAD_REQUEST', message: 'Invalid deal ID.' });
                return;
            }
            await favorites(res.locals.user.uid).doc(String(id)).delete();
            res.json({ id, favorite: false });
        }
        catch (error) {
            next(error);
        }
    });
}
