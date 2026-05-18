"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.INSURER_KEY_MAP = void 0;
exports.insurerToServiceKey = insurerToServiceKey;
exports.encryptPassword = encryptPassword;
exports.decryptPassword = decryptPassword;
exports.storeCredential = storeCredential;
exports.getCredential = getCredential;
exports.hasCredential = hasCredential;
exports.deleteCredential = deleteCredential;
exports.listCredentials = listCredentials;
exports.markCredentialUsed = markCredentialUsed;
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
const db = admin.firestore();
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
// Map common insurer name strings → PortalService keys
exports.INSURER_KEY_MAP = {
    aetna: "aetna",
    "united healthcare": "unitedhealthcare",
    unitedhealthcare: "unitedhealthcare",
    uhc: "unitedhealthcare",
    humana: "humana",
    cigna: "cigna",
    medicare: "medicare",
    medicaid: "medicaid",
};
function insurerToServiceKey(insurer) {
    var _a;
    const lower = insurer.toLowerCase().trim();
    return (_a = exports.INSURER_KEY_MAP[lower]) !== null && _a !== void 0 ? _a : lower.replace(/[^a-z]/g, "");
}
// ── Encryption helpers ────────────────────────────────────────────────────────
function getVaultKey() {
    const key = process.env.CREDENTIAL_VAULT_KEY;
    if (!key)
        throw new Error("CREDENTIAL_VAULT_KEY not set");
    if (key.length !== 64)
        throw new Error("CREDENTIAL_VAULT_KEY must be 64 hex chars (32 bytes)");
    return Buffer.from(key, "hex");
}
function encryptPassword(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getVaultKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted: encrypted.toString("hex"),
        ivHex: iv.toString("hex"),
        tagHex: cipher.getAuthTag().toString("hex"),
    };
}
function decryptPassword(encryptedHex, ivHex, tagHex) {
    const decipher = crypto.createDecipheriv(ALGORITHM, getVaultKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedHex, "hex")),
        decipher.final(),
    ]).toString("utf8");
}
// ── CRUD operations ───────────────────────────────────────────────────────────
async function storeCredential(userId, service, username, password, options) {
    var _a, _b;
    const { encrypted, ivHex, tagHex } = encryptPassword(password);
    await db.collection("credential_vault")
        .doc(`${userId}_${service}`)
        .set({
        userId,
        service,
        username,
        passwordEncrypted: encrypted,
        ivHex,
        tagHex,
        portalUrl: (_a = options === null || options === void 0 ? void 0 : options.portalUrl) !== null && _a !== void 0 ? _a : null,
        notes: (_b = options === null || options === void 0 ? void 0 : options.notes) !== null && _b !== void 0 ? _b : null,
        storedAt: new Date().toISOString(),
        lastUsedAt: null,
        lastUsedSuccess: null,
    });
}
async function getCredential(userId, service) {
    var _a;
    const snap = await db.collection("credential_vault")
        .doc(`${userId}_${service}`)
        .get();
    if (!snap.exists)
        return null;
    const data = snap.data();
    try {
        const password = decryptPassword(data.passwordEncrypted, data.ivHex, data.tagHex);
        await snap.ref.update({ lastUsedAt: new Date().toISOString() });
        return {
            username: data.username,
            password,
            portalUrl: (_a = data.portalUrl) !== null && _a !== void 0 ? _a : undefined,
        };
    }
    catch (_b) {
        return null;
    }
}
async function hasCredential(userId, service) {
    const snap = await db.collection("credential_vault")
        .doc(`${userId}_${service}`)
        .get();
    return snap.exists;
}
async function deleteCredential(userId, service) {
    await db.collection("credential_vault")
        .doc(`${userId}_${service}`)
        .delete();
}
async function listCredentials(userId) {
    const snap = await db.collection("credential_vault")
        .where("userId", "==", userId)
        .get();
    return snap.docs.map(d => ({
        service: d.data().service,
        username: d.data().username,
        notes: d.data().notes,
    }));
}
async function markCredentialUsed(userId, service, success) {
    try {
        await db.collection("credential_vault")
            .doc(`${userId}_${service}`)
            .update({
            lastUsedAt: new Date().toISOString(),
            lastUsedSuccess: success,
        });
    }
    catch (_a) {
        // Doc may not exist — ignore
    }
}
//# sourceMappingURL=credentialVault.js.map