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
exports.expirePostVisitFeedback = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
exports.expirePostVisitFeedback = functions.pubsub
    .schedule("0 3 * * *") // 3am UTC daily
    .timeZone("UTC")
    .onRun(async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const snap = await db.collection("proactive_triggers")
        .where("type", "==", "custom")
        .where("firedAt", "<=", sevenDaysAgo)
        .where("cancelledAt", "==", null)
        .get();
    if (snap.empty)
        return;
    const stale = snap.docs.filter(doc => { var _a; return ((_a = doc.data().message) !== null && _a !== void 0 ? _a : "").startsWith("post_visit_feedback:"); });
    if (stale.length === 0)
        return;
    const batch = db.batch();
    for (const doc of stale) {
        batch.update(doc.ref, { cancelledAt: now });
    }
    await batch.commit();
    console.log(`[expirePostVisitFeedback] Expired ${stale.length} stale feedback triggers`);
});
//# sourceMappingURL=feedbackExpiry.js.map