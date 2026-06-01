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
exports.assertPayoutsReady = assertPayoutsReady;
const functions = __importStar(require("firebase-functions/v1"));
/**
 * Verify a Stripe Connect account is ready to receive a payout.
 *
 * Stripe will reject `payouts.create` if the account has outstanding KYC
 * requirements, but the raw error is opaque. This helper translates the
 * `account.requirements` shape into actionable HttpsError messages so the
 * caregiver UI can prompt the user to finish onboarding instead of showing
 * a generic Stripe error.
 */
function assertPayoutsReady(account) {
    var _a, _b, _c, _d, _e;
    if (!account.charges_enabled || !account.payouts_enabled) {
        throw new functions.https.HttpsError("failed-precondition", "Account not fully onboarded. Please complete your Stripe Connect setup.");
    }
    const disabled = (_a = account.requirements) === null || _a === void 0 ? void 0 : _a.disabled_reason;
    if (disabled) {
        throw new functions.https.HttpsError("failed-precondition", `Stripe disabled payouts: ${disabled}. Please update your account info.`);
    }
    const pastDue = (_c = (_b = account.requirements) === null || _b === void 0 ? void 0 : _b.past_due) !== null && _c !== void 0 ? _c : [];
    const currentlyDue = (_e = (_d = account.requirements) === null || _d === void 0 ? void 0 : _d.currently_due) !== null && _e !== void 0 ? _e : [];
    if (pastDue.length > 0 || currentlyDue.length > 0) {
        throw new functions.https.HttpsError("failed-precondition", "Your Stripe account needs additional information before you can receive payouts. Please complete verification.");
    }
}
//# sourceMappingURL=payoutCommon.js.map