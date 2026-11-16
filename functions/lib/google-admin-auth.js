"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleIdentity = googleIdentity;
exports.adminRef = adminRef;
exports.userRef = userRef;
exports.isBootstrapAdmin = isBootstrapAdmin;
exports.verifyGoogleToken = verifyGoogleToken;
exports.isApprovedAdmin = isApprovedAdmin;
const node_crypto_1 = require("node:crypto");
const auth_1 = require("firebase-admin/auth");
const firestore_api_js_1 = require("./firestore-api.js");
function googleIdentity(token) {
    if (token.firebase?.sign_in_provider !== 'google.com' || token.email_verified !== true || typeof token.email !== 'string')
        return null;
    const email = token.email.trim().toLowerCase();
    if (!email || !token.uid)
        return null;
    return { uid: token.uid, email, name: typeof token.name === 'string' ? token.name : null };
}
function adminRef(email) {
    return firestore_api_js_1.db.collection('dealmein_adminAccounts').doc((0, node_crypto_1.createHash)('sha256').update(email.trim().toLowerCase()).digest('hex'));
}
function userRef(email) {
    return firestore_api_js_1.db.collection('dealmein_userAccounts').doc((0, node_crypto_1.createHash)('sha256').update(email.trim().toLowerCase()).digest('hex'));
}
function isBootstrapAdmin(email) {
    const configured = process.env.APP_ADMIN_USERNAME?.trim().toLowerCase();
    return Boolean(configured && email === configured);
}
async function verifyGoogleToken(header) {
    if (!header?.startsWith('Bearer '))
        return null;
    try {
        return googleIdentity(await (0, auth_1.getAuth)().verifyIdToken(header.slice(7), true));
    }
    catch {
        return null;
    }
}
async function isApprovedAdmin(identity) {
    if (isBootstrapAdmin(identity.email))
        return true;
    const account = await adminRef(identity.email).get();
    return account.exists && account.get('status') === 'approved';
}
