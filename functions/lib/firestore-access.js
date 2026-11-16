"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireApprovedUser = requireApprovedUser;
exports.registerDealAccessGuard = registerDealAccessGuard;
const google_admin_auth_js_1 = require("./google-admin-auth.js");
async function requireApprovedUser(req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    try {
        const identity = await (0, google_admin_auth_js_1.verifyGoogleToken)(req.header('authorization'));
        if (!identity) {
            res.status(401).json({ status: 401, code: 'UNAUTHORIZED', message: 'Sign in with Google first.' });
            return;
        }
        if (!await (0, google_admin_auth_js_1.isApprovedAdmin)(identity) && (await (0, google_admin_auth_js_1.userRef)(identity.email).get()).get('status') !== 'approved') {
            res.status(403).json({ status: 403, code: 'USER_APPROVAL_REQUIRED', message: 'Account approval is required.' });
            return;
        }
        next();
    }
    catch (error) {
        next(error);
    }
}
function registerDealAccessGuard(app) {
    app.use(['/api/deals', '/api/categories', '/api/retailers'], requireApprovedUser);
}
