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
exports.calculateNextFireAt = calculateNextFireAt;
exports.createUserTrigger = createUserTrigger;
exports.listUserTriggers = listUserTriggers;
exports.deleteUserTrigger = deleteUserTrigger;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
function calculateNextFireAt(recurrence, dayOfWeek, hour, minute) {
    const now = new Date();
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setHours(hour, minute);
    switch (recurrence) {
        case "daily": {
            if (candidate <= now)
                candidate.setDate(candidate.getDate() + 1);
            return candidate.toISOString();
        }
        case "weekly": {
            const targetDay = dayOfWeek !== null && dayOfWeek !== void 0 ? dayOfWeek : 1; // default Monday
            const daysUntil = (targetDay - now.getDay() + 7) % 7 || 7;
            candidate.setDate(now.getDate() + daysUntil);
            if (daysUntil === 0 && candidate <= now)
                candidate.setDate(candidate.getDate() + 7);
            return candidate.toISOString();
        }
        case "monthly": {
            candidate.setDate(1); // 1st of next occurrence
            if (candidate <= now)
                candidate.setMonth(candidate.getMonth() + 1);
            return candidate.toISOString();
        }
        case "once": {
            if (candidate <= now)
                candidate.setDate(candidate.getDate() + 1);
            return candidate.toISOString();
        }
    }
}
async function createUserTrigger(phone, userId, params) {
    const nextFireAt = calculateNextFireAt(params.recurrence, params.dayOfWeek, params.hour, params.minute);
    const ref = await db.collection("user_triggers").add(Object.assign(Object.assign({}, params), { phone,
        userId, active: true, nextFireAt, createdAt: new Date().toISOString() }));
    return ref.id;
}
async function listUserTriggers(phone) {
    const snap = await db.collection("user_triggers")
        .where("phone", "==", phone)
        .where("active", "==", true)
        .get();
    return snap.docs.map(d => (Object.assign({ id: d.id }, d.data())));
}
async function deleteUserTrigger(phone, triggerId) {
    var _a;
    const ref = db.collection("user_triggers").doc(triggerId);
    const snap = await ref.get();
    if (!snap.exists || ((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.phone) !== phone)
        return false;
    await ref.update({ active: false, deletedAt: new Date().toISOString() });
    return true;
}
//# sourceMappingURL=userTriggerManager.js.map