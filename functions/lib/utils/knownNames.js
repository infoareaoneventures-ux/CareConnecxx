"use strict";
/**
 * Known-names registry for the persona-shift detector.
 *
 * The persona-shift detector ([personaShiftDetector.ts]) guards the shared-phone
 * case (one family member texting about a different care recipient). Its blind
 * spot is NAME COLLISIONS: any name that isn't the single senior on file looks
 * like a "different care recipient" — so asking about a caregiver named "Imran",
 * a second care recipient ("Dad" when the plan started with "Mom"), or a family
 * member who shares a name all tripped a false alarm.
 *
 * To fix that without a Firestore read on every inbound, we keep a per-session
 * `knownNames` list (lowercased first names of everyone Cara already expects on
 * this account — the client, their care recipients, family members, and their
 * connected/discussed caregivers). It's appended at care events (a match shown,
 * a booking confirmed, onboarding completed) and read for free off the session
 * when the detector runs.
 */
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
exports.firstNameToken = firstNameToken;
exports.addKnownNames = addKnownNames;
exports.collectKnownNames = collectKnownNames;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
/**
 * Reduce a full name to its lowercased first-name token — that's all the
 * detector needs to recognize "Imran Mohamed" when the user types "Imran".
 * Returns [] for empty / placeholder names.
 */
function firstNameToken(name) {
    const raw = (name !== null && name !== void 0 ? name : "").trim().toLowerCase();
    if (!raw)
        return "";
    // Drop obvious placeholders we use when a real name isn't known yet.
    if (raw === "there" || raw === "your loved one" || raw === "the person on file" ||
        raw === "unknown" || raw === "caregiver" || raw === "__parse_error__")
        return "";
    const first = raw.split(/\s+/)[0];
    // Strip punctuation a name token wouldn't carry.
    return first.replace(/[^a-z'-]/g, "");
}
function tokensOf(names) {
    const out = new Set();
    for (const n of names) {
        const t = firstNameToken(n);
        if (t)
            out.add(t);
    }
    return [...out];
}
/**
 * Append names to the session's knownNames registry (idempotent — arrayUnion of
 * normalized first-name tokens). Best-effort: never throws, never blocks.
 */
async function addKnownNames(phone, names) {
    const tokens = tokensOf(names);
    if (tokens.length === 0)
        return;
    await db.collection("agent_sessions").doc(phone).update({
        knownNames: admin.firestore.FieldValue.arrayUnion(...tokens),
    }).catch(() => { });
}
/**
 * Assemble the full set of known first-name tokens for the detector, combining
 * the persisted registry with names live on the session (client, senior, and
 * recently-discussed caregivers from pendingMatches) so coverage holds even
 * before the registry has been populated for an older session.
 */
function collectKnownNames(session) {
    var _a, _b, _c, _d;
    const out = new Set();
    const registry = (_a = session.knownNames) !== null && _a !== void 0 ? _a : [];
    for (const t of registry) {
        const tok = firstNameToken(t);
        if (tok)
            out.add(tok);
    }
    const od = (_b = session.onboardingData) !== null && _b !== void 0 ? _b : {};
    for (const t of tokensOf([
        od.firstName,
        od.seniorName,
        session.seniorName,
    ]))
        out.add(t);
    // Every recipient on a multi-recipient care plan, if present on the session.
    const recipients = (_c = od.recipients) !== null && _c !== void 0 ? _c : [];
    for (const r of recipients) {
        const t = firstNameToken(r === null || r === void 0 ? void 0 : r.name);
        if (t)
            out.add(t);
    }
    // Caregivers currently being discussed (the screenshot case).
    const pending = (_d = session.pendingMatches) !== null && _d !== void 0 ? _d : [];
    for (const m of pending) {
        const t = firstNameToken(m === null || m === void 0 ? void 0 : m.name);
        if (t)
            out.add(t);
    }
    return [...out];
}
//# sourceMappingURL=knownNames.js.map