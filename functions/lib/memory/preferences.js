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
exports.getPreferences = getPreferences;
exports.updatePreferences = updatePreferences;
exports.isActiveHour = isActiveHour;
exports.isInDND = isInDND;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
const DEFAULTS = {
    dndEnabled: false,
    dndStart: "22:00",
    dndEnd: "08:00",
    activeHours: { start: "08:00", end: "21:00" },
    preferredSummaryTime: "18:00",
    preferSMS: false,
    timezone: "America/Los_Angeles",
};
async function getPreferences(userId) {
    const snap = await db.collection("user_preferences").doc(userId).get();
    if (!snap.exists)
        return Object.assign({}, DEFAULTS);
    return Object.assign(Object.assign({}, DEFAULTS), snap.data());
}
async function updatePreferences(userId, patch) {
    await db.collection("user_preferences").doc(userId).set(patch, { merge: true });
}
function validatedTz(tz) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
        return tz;
    }
    catch (_a) {
        console.warn(`[preferences] Invalid timezone "${tz}", falling back to America/Los_Angeles`);
        return "America/Los_Angeles";
    }
}
function isActiveHour(prefs, now) {
    var _a, _b, _c, _d, _e;
    const d = now !== null && now !== void 0 ? now : new Date();
    const tz = validatedTz(prefs.timezone || "America/Los_Angeles");
    const { start, end } = (_a = prefs.activeHours) !== null && _a !== void 0 ? _a : { start: "08:00", end: "21:00" };
    const parts = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
    }).formatToParts(d);
    const h = (_c = (_b = parts.find(p => p.type === "hour")) === null || _b === void 0 ? void 0 : _b.value) !== null && _c !== void 0 ? _c : "00";
    const m = (_e = (_d = parts.find(p => p.type === "minute")) === null || _d === void 0 ? void 0 : _d.value) !== null && _e !== void 0 ? _e : "00";
    const hhmm = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
    if (start <= end) {
        return hhmm >= start && hhmm < end;
    }
    else {
        return hhmm >= start || hhmm < end;
    }
}
function isInDND(prefs, now) {
    var _a, _b, _c, _d;
    if (!prefs.dndEnabled)
        return false;
    const d = now !== null && now !== void 0 ? now : new Date();
    const tz = validatedTz(prefs.timezone || "America/Los_Angeles");
    // Get HH:MM in the user's local timezone (avoids UTC-vs-local comparison bug)
    const parts = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
    }).formatToParts(d);
    const h = (_b = (_a = parts.find(p => p.type === "hour")) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : "00";
    const m = (_d = (_c = parts.find(p => p.type === "minute")) === null || _c === void 0 ? void 0 : _c.value) !== null && _d !== void 0 ? _d : "00";
    const hhmm = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
    const { dndStart, dndEnd } = prefs;
    if (dndStart <= dndEnd) {
        return hhmm >= dndStart && hhmm < dndEnd;
    }
    else {
        // Overnight window e.g. 22:00–08:00
        return hhmm >= dndStart || hhmm < dndEnd;
    }
}
//# sourceMappingURL=preferences.js.map