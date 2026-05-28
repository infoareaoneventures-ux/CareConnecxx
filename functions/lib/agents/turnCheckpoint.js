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
exports.isCheckpointResumeEnabled = isCheckpointResumeEnabled;
exports.hashText = hashText;
exports.writeCheckpoint = writeCheckpoint;
exports.loadCheckpoint = loadCheckpoint;
exports.clearCheckpoint = clearCheckpoint;
const admin = __importStar(require("firebase-admin"));
// Turn checkpointing — Sprint 8 (post-process phase only).
//
// Problem: runQaAgent's tool loop can produce a fully-formed reply, then crash
// or hang in the post-process phase (grounding/format rewrites, the supervisor
// Haiku call, or the Linq send). When that happens the process dies, the family
// gets silence, and the next inbound restarts the ENTIRE turn from scratch —
// re-running every tool call (re-booking, re-messaging) with side effects.
//
// This module lets us checkpoint the turn AFTER the tool loop completes (raw
// reply in hand) so a retry can resume from that point: re-run the safety
// supervisor and send, WITHOUT re-invoking Claude or any tool. That rescues the
// exact crash window (post-loop) with zero tool-replay risk.
//
// Scope (Sprint 8): only the "loop_complete" phase. Mid-loop resume (which
// would need per-tool idempotency tagging) is deliberately out of scope.
//
// Storage: agent_turn_checkpoints/{phone}, one doc per phone, 5-minute TTL.
// The doc is keyed by a hash of the inbound text so we only resume for the
// SAME message — a different inbound from the same phone never resumes.
//
// Gated by the CARA_CHECKPOINT_RESUME env flag. When unset/false, all functions
// are no-ops (writes skipped, loads return null) so the feature can ship dark
// and flip on after one clean deploy.
const db = admin.firestore();
const CHECKPOINT_TTL_MS = 5 * 60 * 1000;
const COLLECTION = "agent_turn_checkpoints";
function isCheckpointResumeEnabled() {
    return process.env.CARA_CHECKPOINT_RESUME === "true";
}
// FNV-1a 32-bit — same hash used by promptExperiments. Deterministic, no deps.
function hashText(text) {
    let h = 0x811c9dc5;
    const s = (text !== null && text !== void 0 ? text : "").trim();
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16);
}
/**
 * Persist a checkpoint for a phone. Fire-and-forget friendly — callers should
 * not await on the hot path (use `.catch(() => {})`). No-op when the resume
 * flag is off.
 */
async function writeCheckpoint(phone, phase, textHash, reply) {
    if (!isCheckpointResumeEnabled())
        return;
    if (!phone || !reply)
        return;
    const now = Date.now();
    const checkpoint = {
        textHash,
        phase,
        reply,
        createdAt: new Date(now).toISOString(),
        expiresAt: now + CHECKPOINT_TTL_MS,
    };
    await db.collection(COLLECTION).doc(phone).set(checkpoint);
}
/**
 * Load a resumable checkpoint for (phone, inbound text). Returns null when:
 *   - the resume flag is off
 *   - no checkpoint exists
 *   - the checkpoint is expired (also deletes it)
 *   - the stored textHash doesn't match this inbound (different message)
 */
async function loadCheckpoint(phone, text) {
    if (!isCheckpointResumeEnabled())
        return null;
    if (!phone)
        return null;
    const snap = await db.collection(COLLECTION).doc(phone).get().catch(() => null);
    if (!snap || !snap.exists)
        return null;
    const cp = snap.data();
    if (!cp)
        return null;
    if (cp.expiresAt < Date.now()) {
        await snap.ref.delete().catch(() => { });
        return null;
    }
    if (cp.textHash !== hashText(text))
        return null;
    return cp;
}
/** Delete a phone's checkpoint. Called on successful send (turn finished). */
async function clearCheckpoint(phone) {
    if (!phone)
        return;
    await db.collection(COLLECTION).doc(phone).delete().catch(() => { });
}
//# sourceMappingURL=turnCheckpoint.js.map