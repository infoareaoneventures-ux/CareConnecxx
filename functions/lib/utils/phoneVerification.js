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
exports.generateOtp = generateOtp;
exports.verifyOtp = verifyOtp;
exports.formatOtpForDisplay = formatOtpForDisplay;
const crypto = __importStar(require("crypto"));
// Phone verification (OTP) — proves the inbound sender actually controls the
// number it appears to come from. Without this, an SMS gateway can spoof the
// FROM header and create sessions under any +1 number. The OTP loop closes
// that gap: the code we send is delivered to the real number owner via the
// carrier, so a spoofer never sees it and can't reply with it.
const OTP_TTL_MS = 15 * 60 * 1000; // 15 min
const MAX_ATTEMPTS = 5;
function generateOtp() {
    // 6-digit zero-padded random code. crypto.randomInt is constant-time-ish and
    // pulls from the OS entropy pool, which is what we want for a one-shot token.
    const n = crypto.randomInt(0, 1000000);
    const code = String(n).padStart(6, "0");
    const now = Date.now();
    return {
        code,
        expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
        attempts: 0,
        issuedAt: new Date(now).toISOString(),
    };
}
function verifyOtp(input, state) {
    var _a, _b, _c, _d;
    if (!state || !state.code)
        return { status: "no_state" };
    if (new Date(state.expiresAt) < new Date())
        return { status: "expired" };
    if (((_a = state.attempts) !== null && _a !== void 0 ? _a : 0) >= MAX_ATTEMPTS)
        return { status: "locked" };
    const cleaned = input.replace(/[^0-9]/g, "").slice(0, 6);
    if (cleaned.length !== 6) {
        return { status: "wrong", attemptsLeft: MAX_ATTEMPTS - ((_b = state.attempts) !== null && _b !== void 0 ? _b : 0) - 1 };
    }
    // Constant-time compare — both buffers must be 6 bytes.
    const a = Buffer.from(cleaned);
    const b = Buffer.from(state.code);
    if (a.length !== b.length) {
        return { status: "wrong", attemptsLeft: MAX_ATTEMPTS - ((_c = state.attempts) !== null && _c !== void 0 ? _c : 0) - 1 };
    }
    if (crypto.timingSafeEqual(a, b))
        return { status: "ok" };
    return { status: "wrong", attemptsLeft: MAX_ATTEMPTS - ((_d = state.attempts) !== null && _d !== void 0 ? _d : 0) - 1 };
}
function formatOtpForDisplay(code) {
    // "845290" → "845-290" — easier to read on a small screen.
    if (code.length !== 6)
        return code;
    return `${code.slice(0, 3)}-${code.slice(3)}`;
}
//# sourceMappingURL=phoneVerification.js.map