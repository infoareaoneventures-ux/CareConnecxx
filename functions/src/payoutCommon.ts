import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getStripeClient } from "./stripe";

/**
 * ── Payout model (decided 2026-07-06) ────────────────────────────────────────
 *
 * Caregivers are paid through Stripe Connect Express accounts on Stripe's
 * automatic DAILY payout schedule: every shift payment is transferred to the
 * caregiver's Connect balance (settleShiftTransfer) and Stripe sweeps it to
 * their bank automatically, arriving ~2 business days later. There is no
 * manual "standard payout" — Stripe rejects manual standard payouts on
 * automatic schedules, and the sweep already does the job for free.
 *
 * On top of that, a caregiver may cash out early with an INSTANT payout
 * (arrives in ~30 minutes). Instant payouts are FREE to the caregiver — the
 * platform absorbs Stripe's instant-payout fee (founder decision 2026-07-06).
 *
 * `executeInstantPayout` below is the ONLY code path that may create a payout.
 * The app callable (instantPayout.ts), the Evia MCP tool (mcp/server.ts), and
 * the Evia SMS PAYOUT flow (agents/instantPayoutHandler.ts) all delegate here,
 * so eligibility checks, idempotency, and record-keeping cannot drift apart
 * again. Records live in caregivers/{id}/payouts (read by PayoutHistory.tsx).
 */

const db = admin.firestore();

/**
 * Translate a Stripe Connect `account.requirements` shape into a human-readable
 * problem, or null when the account can receive payouts. Kept as a pure
 * function so both throwing (HttpsError) and tool-error callers can use it.
 */
export function payoutReadinessProblem(account: any): string | null {
    if (!account.charges_enabled || !account.payouts_enabled) {
        return "Account not fully onboarded. Please complete your Stripe Connect setup.";
    }
    const disabled = account.requirements?.disabled_reason;
    if (disabled) {
        return `Stripe disabled payouts: ${disabled}. Please update your account info.`;
    }
    const pastDue: string[] = account.requirements?.past_due ?? [];
    const currentlyDue: string[] = account.requirements?.currently_due ?? [];
    if (pastDue.length > 0 || currentlyDue.length > 0) {
        return "Your Stripe account needs additional information before you can receive payouts. Please complete verification.";
    }
    return null;
}

/**
 * Verify a Stripe Connect account is ready to receive a payout, throwing the
 * actionable HttpsError the caregiver UI expects instead of an opaque Stripe
 * error from `payouts.create`.
 */
export function assertPayoutsReady(account: any): void {
    const problem = payoutReadinessProblem(account);
    if (problem) {
        throw new functions.https.HttpsError("failed-precondition", problem);
    }
}

export type InstantPayoutErrorCode =
    | "NOT_FOUND"          // no caregiver doc
    | "NO_ACCOUNT"         // no stripeAccountId yet
    | "NOT_READY"          // Connect account has outstanding requirements
    | "NO_BALANCE"         // nothing instantly available
    | "EXCEEDS_BALANCE"    // requested more than instantly available
    | "DUPLICATE"          // a payout was just created — likely a replay
    | "STRIPE_ERROR";      // payouts.create rejected

/**
 * Typed failure so each caller can translate to its own surface: the app
 * callable maps to HttpsError, the MCP tool to toolError, the SMS flow to a
 * conversational message.
 */
export class InstantPayoutError extends Error {
    constructor(public code: InstantPayoutErrorCode, message: string) {
        super(message);
        this.name = "InstantPayoutError";
    }
}

export interface InstantPayoutSuccess {
    payoutDocId: string;
    stripePayoutId: string;
    amountCents: number;
    status: string;
    arrivalDate: string | null;
}

/** Two calls inside this window are treated as one — guards duplicate YES
 *  replies, Linq redeliveries, and agent-loop retries that would otherwise
 *  mint a fresh payout doc (and therefore a fresh Stripe idempotency key). */
const REPLAY_WINDOW_MS = 2 * 60 * 1000;

/**
 * The single instant-payout implementation. Balance-based: pays out the
 * caregiver's instantly-available Stripe balance (or a requested portion),
 * free of platform fees. Writes the unified payout record to
 * caregivers/{id}/payouts and notifies the caregiver.
 */
export async function executeInstantPayout(opts: {
    caregiverId: string;
    requestedCents?: number | null;
    source: "app" | "cara_sms" | "mcp";
}): Promise<InstantPayoutSuccess> {
    const { caregiverId, requestedCents, source } = opts;
    const stripe = getStripeClient();

    const caregiverRef = db.collection("caregivers").doc(caregiverId);
    const caregiverSnap = await caregiverRef.get();
    if (!caregiverSnap.exists) {
        throw new InstantPayoutError("NOT_FOUND", "Caregiver profile not found");
    }
    const stripeAccountId = caregiverSnap.data()?.stripeAccountId as string | undefined;
    if (!stripeAccountId) {
        throw new InstantPayoutError("NO_ACCOUNT", "Please connect your bank account first");
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);
    const problem = payoutReadinessProblem(account);
    if (problem) {
        throw new InstantPayoutError("NOT_READY", problem);
    }

    const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
    const instant = (balance as any).instant_available as Array<{ amount: number; currency: string }> | undefined;
    const availableCents = instant?.find((b) => b.currency === "usd")?.amount ?? 0;
    if (availableCents < 100) {
        throw new InstantPayoutError("NO_BALANCE", "No funds are instantly available right now. Your balance pays out automatically on the daily schedule.");
    }

    let amountCents = availableCents;
    if (requestedCents != null) {
        if (!Number.isInteger(requestedCents) || requestedCents < 100) {
            throw new InstantPayoutError("EXCEEDS_BALANCE", "Minimum instant payout is $1.00");
        }
        if (requestedCents > availableCents) {
            throw new InstantPayoutError(
                "EXCEEDS_BALANCE",
                `Requested $${(requestedCents / 100).toFixed(2)} exceeds the $${(availableCents / 100).toFixed(2)} instantly available`,
            );
        }
        amountCents = requestedCents;
    }

    // Replay guard — reuse the most recent payout instead of creating another.
    // Runs in a TRANSACTION so two concurrent requests (e.g. a duplicate SMS
    // "YES" and an app tap landing on different instances) can't both read
    // "no recent payout" and each create a live Stripe payout — which would
    // bill the platform the instant-payout fee twice and double-disburse the
    // requested amount. The read (recent payout) and the write (placeholder
    // doc) are now atomic; the Stripe call stays outside, keyed by the doc id.
    const payoutsCol = caregiverRef.collection("payouts");
    const createdAt = new Date().toISOString();
    // Fixed per-caregiver lock doc, read+written by every request. Firestore
    // detects transaction conflicts on documents READ, not on collection
    // membership — so with an empty payouts collection two simultaneous
    // requests would each see "no recent payout" and both commit (phantom
    // read). Reading and writing this shared doc forces the two transactions
    // to serialize: the loser retries, re-runs the query, and now sees the
    // winner's fresh payout. Kept OUT of the payouts collection so it never
    // pollutes the reuse query or PayoutHistory.
    const lockRef = caregiverRef.collection("payoutLocks").doc("instant");
    const txnResult = await caregiverRef.firestore.runTransaction<
        | { reuse: InstantPayoutSuccess }
        | { reuse: null; payoutRef: FirebaseFirestore.DocumentReference }
    >(async (txn) => {
        await txn.get(lockRef);
        const recentSnap = await txn.get(payoutsCol.orderBy("createdAt", "desc").limit(1));
        if (!recentSnap.empty) {
            const recent = recentSnap.docs[0].data();
            const recentAt = Date.parse(recent.createdAt ?? "");
            if (Number.isFinite(recentAt) && Date.now() - recentAt < REPLAY_WINDOW_MS && recent.status !== "failed") {
                if (recent.stripePayoutId) {
                    return {
                        reuse: {
                            payoutDocId: recentSnap.docs[0].id,
                            stripePayoutId: recent.stripePayoutId,
                            amountCents: Math.round((recent.amount ?? 0) * 100),
                            status: recent.status ?? "pending",
                            arrivalDate: recent.arrivalDate ?? null,
                        },
                    };
                }
                throw new InstantPayoutError("DUPLICATE", "A payout was requested moments ago and is still processing — give it a minute.");
            }
        }
        const newRef = payoutsCol.doc();
        txn.set(newRef, {
            amount: amountCents / 100,
            grossAmount: amountCents / 100,
            fee: 0,
            type: "instant",
            status: "pending",
            source,
            createdAt,
        });
        // Bump the lock doc we read above — this is what makes a concurrent
        // transaction's commit conflict (it read the old lock version) and
        // retry, at which point it sees THIS payout and reuses/rejects it.
        txn.set(lockRef, { lastRequestedAt: createdAt }, { merge: true });
        return { reuse: null, payoutRef: newRef };
    });

    if (txnResult.reuse) return txnResult.reuse;
    const payoutRef = txnResult.payoutRef;

    let payout: any;
    try {
        payout = await stripe.payouts.create(
            {
                amount: amountCents,
                currency: "usd",
                method: "instant",
                statement_descriptor: "Evia Payout",
            },
            {
                stripeAccount: stripeAccountId,
                idempotencyKey: `instant-payout-${payoutRef.id}`,
            },
        );
    } catch (stripeErr: any) {
        await payoutRef.update({
            status: "failed",
            failureReason: stripeErr?.message || "stripe_error",
            failedAt: new Date().toISOString(),
        });
        throw new InstantPayoutError("STRIPE_ERROR", stripeErr?.message || "Stripe rejected the payout");
    }

    const arrivalDate = payout.arrival_date ? new Date(payout.arrival_date * 1000).toISOString() : null;
    await payoutRef.update({
        status: payout.status,
        stripePayoutId: payout.id,
        arrivalDate,
        paidOutAt: new Date().toISOString(),
    });

    await db.collection("users").doc(caregiverId).collection("notifications").add({
        userId: caregiverId,
        type: "payout_initiated",
        title: "Instant Payout Initiated",
        body: `Your instant payout of $${(amountCents / 100).toFixed(2)} has been initiated — no fee, arrives within about 30 minutes.`,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => { /* notification is best-effort; the payout already succeeded */ });

    return {
        payoutDocId: payoutRef.id,
        stripePayoutId: payout.id,
        amountCents,
        status: payout.status,
        arrivalDate,
    };
}
