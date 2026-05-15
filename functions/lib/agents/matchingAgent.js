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
exports.runMatchingForClient = runMatchingForClient;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const db = admin.firestore();
function score(caregiver, intake) {
    var _a, _b, _c, _d, _e, _f;
    let pts = 0;
    const needs = ((_a = intake.careNeeds) !== null && _a !== void 0 ? _a : []);
    for (const need of needs) {
        if ((_b = caregiver.specialties) === null || _b === void 0 ? void 0 : _b.some((s) => s.toLowerCase().includes(need.toLowerCase())))
            pts += 10;
    }
    pts += Math.min(((_c = caregiver.yearsExperience) !== null && _c !== void 0 ? _c : 0) * 2, 20);
    pts += Math.min(((_d = caregiver.rating) !== null && _d !== void 0 ? _d : 0) * 4, 20);
    if (((_e = caregiver.city) !== null && _e !== void 0 ? _e : "").toLowerCase() === ((_f = intake.city) !== null && _f !== void 0 ? _f : "").toLowerCase())
        pts += 10;
    return pts;
}
async function runMatchingForClient(phone, chatId, intake, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    try {
        const zip = ((_a = intake.zipCode) !== null && _a !== void 0 ? _a : "");
        const city = ((_b = intake.city) !== null && _b !== void 0 ? _b : "");
        // Exclude caregivers the family has already declined
        const rejectedIds = ((_c = session === null || session === void 0 ? void 0 : session.rejectedCaregiverIds) !== null && _c !== void 0 ? _c : []);
        if (!session) {
            const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
            if (sessionSnap.exists) {
                rejectedIds.push(...((_e = (_d = sessionSnap.data()) === null || _d === void 0 ? void 0 : _d.rejectedCaregiverIds) !== null && _e !== void 0 ? _e : []));
            }
        }
        // Pull active + pending_review caregivers in a broad radius
        const snap = await db.collection("caregivers")
            .where("status", "in", ["active", "pending_review"])
            .limit(50)
            .get();
        let caregivers = snap.docs
            .map((d) => (Object.assign({ id: d.id, pendingBackgroundCheck: d.data().status === "pending_review" }, d.data())))
            .filter((c) => {
            var _a, _b;
            return !rejectedIds.includes(c.id) && (((_a = c.city) === null || _a === void 0 ? void 0 : _a.toLowerCase()) === city.toLowerCase() ||
                ((_b = c.zipCode) === null || _b === void 0 ? void 0 : _b.startsWith(zip.slice(0, 3))));
        });
        if (caregivers.length === 0) {
            // Broader search if local returns nothing (still respecting rejections)
            caregivers = snap.docs
                .map((d) => (Object.assign({ id: d.id }, d.data())))
                .filter((c) => !rejectedIds.includes(c.id));
        }
        const top3 = caregivers
            .map((c) => ({ c, pts: score(c, intake) }))
            .sort((a, b) => b.pts - a.pts)
            .slice(0, 3)
            .map((x) => x.c);
        if (top3.length === 0) {
            // Write admin alert so the team can manually follow up
            const intakeCareNeeds = ((_f = intake.careNeeds) !== null && _f !== void 0 ? _f : []);
            await db.collection("admin_alerts").add({
                type: "no_match_found",
                clientPhone: phone,
                city: ((_g = intake.city) !== null && _g !== void 0 ? _g : ""),
                zipCode: ((_h = intake.zipCode) !== null && _h !== void 0 ? _h : ""),
                careNeeds: intakeCareNeeds,
                createdAt: new Date().toISOString(),
                resolved: false,
                severity: "high",
            });
            await (0, client_1.sendMessage)(chatId, "I don't have anyone available in your area right now, but I've flagged your request " +
                "and our team will reach out within 24 hours to find the right match. 💙");
            return;
        }
        // Write pending interview requests (and caregiver_interest tasks for pending-bg-check caregivers)
        for (const c of top3) {
            await db.collection("interview_requests").add({
                clientPhone: phone,
                caregiverId: c.id,
                caregiverName: c.name,
                status: "pending_presentation",
                createdAt: new Date().toISOString(),
            });
            if (c.pendingBackgroundCheck) {
                await db.collection("agent_tasks").add({
                    type: "caregiver_interest",
                    caregiverId: c.id,
                    caregiverName: c.name,
                    clientPhone: phone,
                    clientId: (_j = session === null || session === void 0 ? void 0 : session.userId) !== null && _j !== void 0 ? _j : phone,
                    status: "pending_bg_clear",
                    createdAt: new Date().toISOString(),
                });
            }
        }
        const lines = top3.map((c, i) => {
            var _a, _b, _c, _d;
            const stars = "⭐".repeat(Math.round((_a = c.rating) !== null && _a !== void 0 ? _a : 4));
            const specials = ((_b = c.specialties) !== null && _b !== void 0 ? _b : []).slice(0, 2).join(", ") || "General care";
            const yrs = (_c = c.yearsExperience) !== null && _c !== void 0 ? _c : "?";
            const bgNote = c.pendingBackgroundCheck ? "\n   ⏳ Background check in progress" : "";
            const profileUrl = `${(_d = process.env.APP_URL) !== null && _d !== void 0 ? _d : "https://careconnecxx.com"}/caregiver/${c.id}`;
            return (`${i + 1}️⃣  ${c.name} · ${stars} · $${c.hourlyRate}/hr\n` +
                `   ${specials} · ${yrs}yrs exp${bgNote}\n` +
                `   👤 ${profileUrl}`);
        }).join("\n\n");
        await (0, client_1.sendMessage)(chatId, `I found ${top3.length} great matches for ${((_k = intake.seniorName) !== null && _k !== void 0 ? _k : "your loved one")} in ${city}! 🎉\n\n` +
            `${lines}\n\n` +
            `Reply with numbers to request interviews.\n` +
            `(e.g. "1" or "1 and 3" or "all")`);
        // Store match list in session for follow-up
        await db.collection("agent_sessions").doc(phone).update({
            pendingMatches: top3.map((c) => ({ id: c.id, name: c.name, rate: c.hourlyRate })),
        });
    }
    catch (err) {
        console.error("runMatchingForClient error:", err);
        await (0, client_1.sendMessage)(chatId, "I'm searching for caregivers — I'll text you top matches within the hour! 🔍");
    }
}
//# sourceMappingURL=matchingAgent.js.map