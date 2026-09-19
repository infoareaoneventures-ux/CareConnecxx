import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';
import Stripe from 'stripe';
import { isOfflinePaymentMethod } from './billing/paymentMethods';
import { TIMESHEET_AUTO_APPROVE_HOURS } from './config/slaConstants';
import { timesheetAutoApprovalEnabled } from './config/featureFlags';
import { createValidatedShiftHours, createValidatedShiftHoursFromShift, ValidatedShiftHoursError } from './billing/createValidatedShiftHours';
import { claimShiftPaymentOperation, shiftPaymentOperationKey, updateShiftPaymentOperation } from './billing/paymentOperation';
import { resolveShiftBillableAmount, sanitizeShiftLineItems, ShiftLineItem, serviceFeeCentsFor } from './billing/shiftBillingAmounts';
import { formatClockTime } from './utils/scheduledTime';
import { resetShiftPaymentForRetry } from './billing/shiftPaymentRetry';
import { fmtHours, resolveBillableOrHttpsError, pushNotification, notifyAdmins, reviewShiftHoursAs } from './billing/reviewShiftHours';
// One review path for the website's callable and Evia's review_shift_hours tool (2026-09-17).
export { notifyAdmins, reviewShiftHoursAs } from './billing/reviewShiftHours';

// Everything the family would see in the app reaches them over Evia's text as it
// happens (standing rule, 2026-09-17) — same wording as the in-app notification.
// Fail-soft: the in-app notification is already written when this runs.
async function textClient(clientId: string, message: string): Promise<void> {
  try {
    const { sendSMSToUser } = await import('./sms');
    await sendSMSToUser(clientId, `Evia: ${message}`);
  } catch (err) {
    console.warn('shiftHours: client text failed (in-app notification still written)', err instanceof Error ? err.message : err);
  }
}

export { sanitizeShiftLineItems } from './billing/shiftBillingAmounts';

const stripe = new Stripe(functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY, {
  timeout: 10_000, // cap SDK calls (default 80s) so a slow Stripe response can't run a payment handler to the function deadline
});
const db = admin.firestore();

type ShiftHoursStatus =
  | 'pending_client_review'
  | 'correction_proposed'
  | 'caregiver_counter_proposed'
  | 'approved'
  | 'auto_approved'
  | 'disputed_admin_review'
  | 'charge_pending'
  | 'paid'
  | 'payment_failed';

const MAX_PAYMENT_ATTEMPTS = 5;
const PAYMENT_RETRY_DELAYS_MINUTES = [5, 30, 120, 360, 720];

// ---------- helpers ----------

async function requireAdmin(uid: string) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists || userDoc.data()?.userType !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }
}

function nowIso() {
  return new Date().toISOString();
}

function nextPaymentAttemptAt(attempt: number, fromMs = Date.now()): string {
  const delayMinutes = PAYMENT_RETRY_DELAYS_MINUTES[
    Math.min(Math.max(attempt - 1, 0), PAYMENT_RETRY_DELAYS_MINUTES.length - 1)
  ];
  return new Date(fromMs + delayMinutes * 60 * 1000).toISOString();
}

// Whitelist + clamp caregiver/client-supplied line items. Every path that lets
// a user set line items and feeds them into a charged/paid amount MUST run this
// (submit, propose_correction, counter_propose) — otherwise negative or absurd
// `amount`s flow straight into grossPay and the Stripe transfer/charge.
export const submitShiftHours = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { shiftId, startTime, endTime, lineItems: rawLineItems = [] } = data as {
    shiftId: string;
    startTime: string;
    endTime: string;
    lineItems?: any[];
  };
  if (!shiftId || !startTime || !endTime) {
    throw new functions.https.HttpsError('invalid-argument', 'shiftId, startTime and endTime are required');
  }

  // Additional charges are allowed through now (Hamse, 2026-08-23) — they used
  // to be rejected outright here, discarding the base hours too. Server-side
  // validation mirrors the modal's own client-side checks (never trust
  // client-only validation for money data); sanitizeShiftLineItems then
  // produces the safe shape createValidatedShiftHours persists. Presence of
  // any line item forces requiresExplicitApproval (shiftBillingPolicy.ts) —
  // the client must explicitly approve, no 24h auto-approve fallback.
  if (Array.isArray(rawLineItems) && rawLineItems.length > 0) {
    const missingType = rawLineItems.find((li) => !li?.type);
    if (missingType) {
      throw new functions.https.HttpsError('invalid-argument', 'Please select a type for each additional charge');
    }
    const missingAmount = rawLineItems.find((li) => !(Number(li?.amount) > 0));
    if (missingAmount) {
      throw new functions.https.HttpsError('invalid-argument', 'Please enter an amount for each additional charge');
    }
    const missingCustomLabel = rawLineItems.find((li) => li?.type === 'custom' && !String(li?.label ?? '').trim());
    if (missingCustomLabel) {
      throw new functions.https.HttpsError('invalid-argument', 'Please enter a label for each Custom charge');
    }
  }
  const lineItems: ShiftLineItem[] = sanitizeShiftLineItems(rawLineItems);

  let appointmentId = shiftId;
  let useLegacyShiftPath = false;
  const appointmentSnap = await db.collection('appointments').doc(appointmentId).get();
  if (!appointmentSnap.exists) {
    const legacyShiftSnap = await db.collection('shifts').doc(shiftId).get();
    if (!legacyShiftSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Appointment not found');
    }
    const legacyShift = legacyShiftSnap.data()!;
    if (legacyShift.caregiverId !== context.auth.uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not your shift');
    }
    const linkedAppointmentId = typeof legacyShift.appointmentId === 'string' ? legacyShift.appointmentId : '';
    if (linkedAppointmentId) {
      // A real link exists (rare for this pipeline, but respect it if present)
      // — validate against the linked appointment as usual.
      appointmentId = linkedAppointmentId;
      const linkedSnap = await db.collection('appointments').doc(linkedAppointmentId).get();
      if (!linkedSnap.exists) {
        throw new functions.https.HttpsError('failed-precondition', 'The linked appointment could not be verified');
      }
    } else {
      // No appointments doc exists for this shift and never has — this is the
      // website's own booking_requests -> shiftGenerator.ts pipeline, which
      // has never written an appointmentId (restored capability, Hamse
      // 2026-08-24 — see createValidatedShiftHoursFromShift). Submit directly
      // off the shift doc's own fields instead of requiring a linked
      // appointment.
      useLegacyShiftPath = true;
    }
  }

  try {
    const result = useLegacyShiftPath
      ? await createValidatedShiftHoursFromShift({
          shiftId,
          actorUid: context.auth.uid,
          submittedStartTime: startTime,
          submittedEndTime: endTime,
          source: 'web',
          lineItems,
        })
      : await createValidatedShiftHours({
          appointmentId,
          actorUid: context.auth.uid,
          submittedStartTime: startTime,
          submittedEndTime: endTime,
          source: 'web',
          lineItems,
        });
    return {
      success: true,
      shiftId,
      appointmentId,
      totalHours: result.totalHours,
      amountCents: result.grossPayCents,
      serviceFeeCents: serviceFeeCentsFor(result.grossPayCents),
      totalChargeCents: result.grossPayCents + serviceFeeCentsFor(result.grossPayCents),
      status: result.status,
      alreadyExisted: result.alreadyExisted,
    };
  } catch (error) {
    if (error instanceof ValidatedShiftHoursError) {
      const code = error.code === 'not_found'
        ? 'not-found'
        : error.code === 'forbidden'
          ? 'permission-denied'
          : error.code === 'conflict'
            ? 'already-exists'
          : error.code === 'outside_booked_window'
            ? 'invalid-argument'
            : 'failed-precondition';
      throw new functions.https.HttpsError(code, error.message);
    }
    throw error;
  }
});

/**
 * Client approves, proposes a correction, accepts a counter-proposal, or escalates.
 */
export const reviewShiftHours = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }
  // The modal's four actions live in billing/reviewShiftHours.ts so Evia's
  // review_shift_hours tool runs the very same function (one write path).
  return reviewShiftHoursAs(context.auth.uid, data ?? {});
});

/**
 * Caregiver accepts the client's correction or sends a counter-proposal.
 */
export const respondToCorrection = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { appointmentId, action, counterStartTime, counterEndTime, counterNote, counterLineItems: rawCounterLineItems } = data;
  if (!appointmentId || (action !== 'accept' && action !== 'counter_propose')) {
    throw new functions.https.HttpsError('invalid-argument', 'appointmentId and valid action (accept | counter_propose) required');
  }

  const ref = db.collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Shift hours not found');
  }
  const shift = snap.data()!;

  if (shift.caregiverId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'Not your shift');
  }
  if (shift.status !== 'correction_proposed') {
    throw new functions.https.HttpsError('failed-precondition', 'Nothing to respond to');
  }

  const now = nowIso();

  if (action === 'accept') {
    const finalAmount = resolveBillableOrHttpsError({
      startTime: shift.proposedStartTime,
      endTime: shift.proposedEndTime,
      bookedRateDollars: Number(shift.payRate),
      lineItems: shift.proposedLineItems ?? shift.lineItems,
    });

    await ref.update({
      status: 'approved',
      finalStartTime: shift.proposedStartTime,
      finalEndTime: shift.proposedEndTime,
      finalTotalHours: finalAmount.totalHours,
      lineItems: finalAmount.lineItems,
      lineItemsTotal: finalAmount.lineItemsTotal,
      basePay: finalAmount.basePay,
      grossPay: finalAmount.grossPay,
      amountCents: finalAmount.grossPayCents,
      serviceFeeCents: finalAmount.serviceFeeCents,
      totalChargeCents: finalAmount.totalChargeCents,
      requiresExplicitApproval: finalAmount.requiresExplicitApproval,
      resolvedAt: now,
      resolvedBy: 'caregiver',
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: 'caregiver',
        action: 'accepted',
        at: now,
        startTime: shift.proposedStartTime,
        endTime: shift.proposedEndTime,
        hours: finalAmount.totalHours,
        lineItems: finalAmount.lineItems,
        lineItemsTotal: finalAmount.lineItemsTotal,
        basePay: finalAmount.basePay,
        grossPay: finalAmount.grossPay,
      }),
    });
    await pushNotification(
      shift.clientId,
      'shift_hours_approved',
      'Caregiver accepted correction',
      `${shift.caregiverName} accepted your proposed ${finalAmount.totalHours}h.`,
      { appointmentId }
    );
    // The family was promised a text as soon as the caregiver answers — a counter
    // and the 24h auto-accept already text them; an accept only left an in-app
    // notification (live-caught 2026-09-18). Same information as the card.
    await textClient(shift.clientId,
      `${shift.caregiverName ?? 'Your caregiver'} accepted your correction: ${formatClockTime(Date.parse(shift.proposedStartTime))}–${formatClockTime(Date.parse(shift.proposedEndTime))} (${fmtHours(finalAmount.totalHours)}). $${finalAmount.grossPay.toFixed(2)} to ${shift.caregiverName ?? 'your caregiver'}; $${(finalAmount.totalChargeCents / 100).toFixed(2)} goes on your card on file (incl. the $${(finalAmount.serviceFeeCents / 100).toFixed(2)} service fee).`);
    return { success: true };
  }

  // action === 'counter_propose'
  if (!counterStartTime || !counterEndTime) {
    throw new functions.https.HttpsError('invalid-argument', 'counterStartTime and counterEndTime are required for counter_propose');
  }
  const counter = resolveBillableOrHttpsError({
    startTime: counterStartTime,
    endTime: counterEndTime,
    bookedRateDollars: Number(shift.payRate),
    lineItems: rawCounterLineItems !== undefined ? rawCounterLineItems : shift.lineItems,
  });
  // Clamp/whitelist — a caregiver counter feeds counterGrossPay, which is
  // charged if the client accepts. Fall back to stored (already-sanitized)
  // items when none are sent.
  await ref.update({
    status: 'caregiver_counter_proposed' as ShiftHoursStatus,
    counterStartTime,
    counterEndTime,
    counterTotalHours: counter.totalHours,
    counterNote: counterNote || null,
    counterLineItems: counter.lineItems,
    counterLineItemsTotal: counter.lineItemsTotal,
    counterGrossPay: counter.grossPay,
    requiresExplicitApproval: counter.requiresExplicitApproval,
    updatedAt: now,
    correctionHistory: admin.firestore.FieldValue.arrayUnion({
      by: 'caregiver',
      action: 'counter_proposed',
      at: now,
      startTime: counterStartTime,
      endTime: counterEndTime,
      hours: counter.totalHours,
      basePay: counter.basePay,
      lineItems: counter.lineItems,
      lineItemsTotal: counter.lineItemsTotal,
      grossPay: counter.grossPay,
      note: counterNote || null,
    }),
  });

  await pushNotification(
    shift.clientId,
    'shift_hours_counter_proposed',
    'Caregiver sent a counter-proposal',
    `${shift.caregiverName} sent a counter-proposal for ${counter.totalHours}h. Review and accept or escalate.`,
    { appointmentId, counterTotalHours: counter.totalHours }
  );
  await textClient(shift.clientId, `${shift.caregiverName} sent a counter-proposal for ${counter.totalHours}h on their hours. Reply here to accept it, or ask me to escalate it to our team.`);

  return { success: true };
});

/**
 * Admin resolves a disputed shift.
 */
export const adminResolveShiftHours = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }
  await requireAdmin(context.auth.uid);

  const { appointmentId, finalStartTime, finalEndTime, note } = data;
  if (!appointmentId || !finalStartTime || !finalEndTime) {
    throw new functions.https.HttpsError('invalid-argument', 'appointmentId, finalStartTime, finalEndTime required');
  }

  const ref = db.collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Shift hours not found');
  }
  const shift = snap.data()!;
  if (shift.status !== 'disputed_admin_review') {
    throw new functions.https.HttpsError('failed-precondition', 'Not in admin review');
  }

  const now = nowIso();

  const finalAmount = resolveBillableOrHttpsError({
    startTime: finalStartTime,
    endTime: finalEndTime,
    bookedRateDollars: Number(shift.payRate),
    lineItems: shift.lineItems,
  });
  await ref.update({
    status: 'approved',
    finalStartTime,
    finalEndTime,
    finalTotalHours: finalAmount.totalHours,
    basePay: finalAmount.basePay,
    lineItems: finalAmount.lineItems,
    lineItemsTotal: finalAmount.lineItemsTotal,
    grossPay: finalAmount.grossPay,
    amountCents: finalAmount.grossPayCents,
      serviceFeeCents: finalAmount.serviceFeeCents,
      totalChargeCents: finalAmount.totalChargeCents,
    requiresExplicitApproval: finalAmount.requiresExplicitApproval,
    resolvedAt: now,
    resolvedBy: 'admin',
    adminAssignedTo: context.auth.uid,
    adminResolutionNote: note || null,
    updatedAt: now,
    correctionHistory: admin.firestore.FieldValue.arrayUnion({
      by: 'admin',
      action: 'admin_resolved',
      at: now,
      startTime: finalStartTime,
      endTime: finalEndTime,
      hours: finalAmount.totalHours,
      lineItems: finalAmount.lineItems,
      lineItemsTotal: finalAmount.lineItemsTotal,
      basePay: finalAmount.basePay,
      grossPay: finalAmount.grossPay,
      note: note || null,
    }),
  });

  await pushNotification(
    shift.caregiverId,
    'shift_hours_approved',
    'Admin resolved your dispute',
    `Final: ${finalAmount.totalHours}h.`,
    { appointmentId }
  );
  await pushNotification(
    shift.clientId,
    'shift_hours_approved',
    'Admin resolved the dispute',
    `Final: ${finalAmount.totalHours}h.`,
    { appointmentId }
  );

  return { success: true };
});

/**
 * Retries a failed payment by resetting status to 'approved', re-triggering the payment flow.
 * Callable by the shift's own client or an admin.
 */
export const retryShiftPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { appointmentId } = data;
  if (!appointmentId) {
    throw new functions.https.HttpsError('invalid-argument', 'appointmentId required');
  }

  const ref = db.collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Shift hours not found');
  }
  const shift = snap.data()!;

  // Allow the shift's own client or an admin
  if (shift.clientId !== context.auth.uid) {
    await requireAdmin(context.auth.uid);
  }

  if (shift.status !== 'payment_failed') {
    throw new functions.https.HttpsError('failed-precondition', 'Not in payment_failed state');
  }

  // Reset to 'approved' — re-triggers the onShiftHoursApproved Firestore trigger
  await resetShiftPaymentForRetry({ appointmentId, shiftRef: ref, shift });
  return { success: true };
});

// ---------- scheduled ----------

/**
 * Auto-approve shifts the client hasn't touched within 24h.
 */
export const autoApproveShiftHours = functions.pubsub.schedule('every 1 hours').onRun(async () => {
  if (!timesheetAutoApprovalEnabled()) {
    console.info('[autoApproveShiftHours] disabled by TIMESHEET_AUTO_APPROVAL_ENABLED');
    return null;
  }

  const now = nowIso();
  const snap = await db.collection('shiftHours')
    .where('status', '==', 'pending_client_review')
    .where('autoApproveAt', '<=', now)
    .limit(200)
    .get();

  for (const doc of snap.docs) {
    const shift = doc.data();
    if (shift.approvalNoticeState !== 'delivered' || shift.requiresExplicitApproval === true) {
      continue;
    }
    const autoBasePay        = Math.round(shift.submittedTotalHours * shift.payRate * 100) / 100;
    const autoLineItems      = Array.isArray(shift.lineItems) ? shift.lineItems : [];
    const autoLineItemsTotal = Math.round(autoLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0) * 100) / 100;
    const autoGrossPay       = shift.grossPay ?? Math.round((autoBasePay + autoLineItemsTotal) * 100) / 100;
    await doc.ref.update({
      status: 'auto_approved',
      finalStartTime: shift.submittedStartTime,
      finalEndTime: shift.submittedEndTime,
      finalTotalHours: shift.submittedTotalHours,
      basePay: autoBasePay,
      lineItems: autoLineItems,
      lineItemsTotal: autoLineItemsTotal,
      grossPay: autoGrossPay,
      resolvedAt: now,
      resolvedBy: 'system_auto_approve',
      updatedAt: now,
    });

    await pushNotification(shift.caregiverId, 'shift_hours_auto_approved', 'Hours auto-approved', `Client did not respond in ${TIMESHEET_AUTO_APPROVE_HOURS}h; ${fmtHours(shift.submittedTotalHours)} auto-approved.`, { appointmentId: doc.id });
    await pushNotification(shift.clientId, 'shift_hours_auto_approved', 'Hours auto-approved', `The ${TIMESHEET_AUTO_APPROVE_HOURS}h review window closed; ${fmtHours(shift.submittedTotalHours)} auto-approved.`, { appointmentId: doc.id });
    await textClient(shift.clientId, `The ${TIMESHEET_AUTO_APPROVE_HOURS}-hour review window closed, so ${shift.caregiverName ?? 'your caregiver'}'s ${fmtHours(shift.submittedTotalHours)} were auto-approved ($${Number(autoGrossPay).toFixed(2)} to them) and your card is being charged $${((Math.round(Number(autoGrossPay) * 100) + serviceFeeCentsFor(Math.round(Number(autoGrossPay) * 100))) / 100).toFixed(2)} (incl. the 9% service fee).`);
  }

  return null;
});

/**
 * Auto-accept client's proposed correction after 24h caregiver silence.
 */
export const autoAcceptCorrection = functions.pubsub.schedule('every 1 hours').onRun(async () => {
  const now = nowIso();
  const snap = await db.collection('shiftHours')
    .where('status', '==', 'correction_proposed')
    .where('correctionRespondByAt', '<=', now)
    .limit(200)
    .get();

  for (const doc of snap.docs) {
    const shift = doc.data();
    let autoFinal: ReturnType<typeof resolveShiftBillableAmount> | null = null;
    let billingReviewReason: string | null = null;
    try {
      autoFinal = resolveShiftBillableAmount({
        startTime: shift.proposedStartTime,
        endTime: shift.proposedEndTime,
        bookedRateDollars: Number(shift.payRate),
        lineItems: shift.proposedLineItems ?? shift.lineItems,
      });
      if (autoFinal.requiresExplicitApproval || shift.requiresExplicitApproval === true) {
        billingReviewReason = 'Correction exceeds the automatic approval threshold';
      }
    } catch (error) {
      billingReviewReason = error instanceof Error ? error.message : 'Correction failed billing validation';
    }

    if (!autoFinal || billingReviewReason) {
      await doc.ref.update({
        status: 'disputed_admin_review',
        billingReviewReason,
        updatedAt: now,
        correctionHistory: admin.firestore.FieldValue.arrayUnion({
          by: 'system',
          action: 'auto_accept_blocked',
          at: now,
          note: billingReviewReason,
        }),
      });
      await notifyAdmins(
        'shift_hours_billing_review',
        'Correction needs billing review',
        `Appointment ${doc.id} was blocked from auto-accept: ${billingReviewReason}.`,
        { appointmentId: doc.id, reason: billingReviewReason },
      );
      continue;
    }

    await doc.ref.update({
      status: 'approved',
      finalStartTime: shift.proposedStartTime,
      finalEndTime: shift.proposedEndTime,
      finalTotalHours: autoFinal.totalHours,
      lineItems: autoFinal.lineItems,
      lineItemsTotal: autoFinal.lineItemsTotal,
      basePay: autoFinal.basePay,
      grossPay: autoFinal.grossPay,
      amountCents: autoFinal.grossPayCents,
      serviceFeeCents: autoFinal.serviceFeeCents,
      totalChargeCents: autoFinal.totalChargeCents,
      requiresExplicitApproval: false,
      resolvedAt: now,
      resolvedBy: 'system_auto_accept',
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: 'system',
        action: 'accepted',
        at: now,
        startTime: shift.proposedStartTime,
        endTime: shift.proposedEndTime,
        hours: autoFinal.totalHours,
        lineItems: autoFinal.lineItems,
        lineItemsTotal: autoFinal.lineItemsTotal,
        basePay: autoFinal.basePay,
        grossPay: autoFinal.grossPay,
      }),
    });

    await pushNotification(shift.caregiverId, 'shift_hours_approved', 'Correction auto-accepted', `You did not respond in 24h; client's ${autoFinal.totalHours}h proposal was accepted.`, { appointmentId: doc.id });
    await pushNotification(shift.clientId, 'shift_hours_approved', 'Correction auto-accepted', `Caregiver did not respond; your proposed ${autoFinal.totalHours}h is final.`, { appointmentId: doc.id });
    await textClient(shift.clientId, `${shift.caregiverName ?? 'Your caregiver'} didn't respond to your correction in 24 hours, so your proposed ${autoFinal.totalHours}h ($${autoFinal.grossPay.toFixed(2)} to them) is final and your card is being charged $${(autoFinal.totalChargeCents / 100).toFixed(2)} (incl. the $${(autoFinal.serviceFeeCents / 100).toFixed(2)} service fee).`);
  }

  return null;
});

/**
 * Retry failed payments up to MAX_PAYMENT_ATTEMPTS.
 */
export const retryFailedShiftPayments = functions.pubsub.schedule('every 6 hours').onRun(async () => {
  const now = nowIso();
  const snap = await db.collection('shiftHours')
    .where('status', '==', 'payment_failed')
    .where('nextPaymentAttemptAt', '<=', now)
    .orderBy('nextPaymentAttemptAt', 'asc')
    .limit(50)
    .get();

  for (const doc of snap.docs) {
    const shift = doc.data();
    if ((shift.paymentAttemptCount || 0) >= MAX_PAYMENT_ATTEMPTS) {
      continue;
    }
    await processShiftPayment(doc.id, shift);
  }

  return null;
});

/** Reconcile bounded pages of asynchronous charges when a webhook is missed. */
export const reconcileChargePendingShiftPayments = functions.pubsub
  .schedule('every 15 minutes')
  .onRun(async () => {
    const now = nowIso();
    const snap = await db.collection('shiftHours')
      .where('status', '==', 'charge_pending')
      .where('nextPaymentReconcileAt', '<=', now)
      .orderBy('nextPaymentReconcileAt', 'asc')
      .limit(50)
      .get();

    for (const doc of snap.docs) {
      const shift = doc.data();
      const paymentIntentId = shift.stripeChargeId as string | undefined;
      if (!paymentIntentId) {
        const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
        const retryAt = nextPaymentAttemptAt(Number(shift.paymentAttemptCount ?? 1));
        await doc.ref.update({
          status: 'payment_failed',
          stripeFailureReason: 'charge_pending_without_payment_intent',
          nextPaymentAttemptAt: retryAt,
          updatedAt: now,
        });
        await updateShiftPaymentOperation(shiftPaymentOperationKey(doc.id, generation), 'retry', {
          nextAttemptAt: retryAt,
          lastErrorCode: 'charge_pending_without_payment_intent',
        });
        continue;
      }

      try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
        const intentGeneration = Math.max(1, Number(intent.metadata?.paymentGeneration ?? 1));
        if (intentGeneration !== generation) {
          await doc.ref.update({
            status: 'requires_admin_review',
            autoApproveAt: null,
            stripeFailureReason: 'stale_payment_generation_on_reconcile',
            nextPaymentReconcileAt: null,
            updatedAt: now,
          });
          await updateShiftPaymentOperation(shiftPaymentOperationKey(doc.id, generation), 'requires_admin_review', {
            nextAttemptAt: null,
            lastErrorCode: 'stale_payment_generation_on_reconcile',
          });
        } else if (intent.status === 'succeeded') {
          await completeShiftPaymentAfterCharge(doc.id, intent.id, intentGeneration);
        } else if (isTerminalPaymentIntentStatus(intent.status)) {
          const retryAt = nextPaymentAttemptAt(Number(shift.paymentAttemptCount ?? 1));
          await doc.ref.update({
            status: 'payment_failed',
            stripeChargeStatus: intent.status,
            nextPaymentAttemptAt: retryAt,
            nextPaymentReconcileAt: null,
            updatedAt: now,
          });
          await updateShiftPaymentOperation(shiftPaymentOperationKey(doc.id, generation), 'retry', {
            nextAttemptAt: retryAt,
            providerOperationId: intent.id,
            lastErrorCode: `payment_intent_${intent.status}`,
          });
        } else {
          await doc.ref.update({
            stripeChargeStatus: intent.status,
            nextPaymentReconcileAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            updatedAt: now,
          });
        }
      } catch (error) {
        await doc.ref.update({
          nextPaymentReconcileAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          lastReconcileError: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          updatedAt: now,
        });
      }
    }
    return null;
  });

// ---------- Firestore trigger ----------

/**
 * When a shift transitions to approved/auto_approved and is credit, run Stripe.
 */
export const onShiftHoursApproved = functions
  .firestore.document('shiftHours/{appointmentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    const nowPayable = (after.status === 'approved' || after.status === 'auto_approved');
    const wasPayable = (before.status === 'approved' || before.status === 'auto_approved');
    if (!nowPayable || wasPayable) {
      return null;
    }
    // Re-approve guard: a shift that already has a transfer was already paid out.
    // Without this, an approved -> payment_failed -> re-approved cycle (before
    // is payment_failed, so wasPayable is false) would fire a second transfer.
    if (after.stripeTransferId) {
      return null;
    }

    await processShiftPayment(context.params.appointmentId, after);
    return null;
  });

// ---------- core Stripe flow ----------

// Resolve gross pay in cents. shiftHours docs come from three rails that
// historically disagreed on field names: in-app submitShiftHours writes
// `grossPay` (dollars); the Evia MCP tool and care-notes completion write
// `amountCents`. Fall back through the known shapes so every approved shift
// charges instead of dying on "grossPay not set".
function computeGrossCents(shift: any): number {
  const grossDollars =
    typeof shift.grossPay === 'number'   ? shift.grossPay
    : typeof shift.amountCents === 'number' ? shift.amountCents / 100
    : Number(shift.finalTotalHours ?? shift.submittedTotalHours ?? 0) *
      Number(shift.payRate ?? shift.hourlyRate ?? 0);
  const grossCents = Math.round(grossDollars * 100);
  // Number.isFinite guards against NaN/Infinity from malformed data: typeof NaN
  // is 'number' (so it passes the field-shape checks above) and NaN <= 0 is
  // false, so without this an invalid amount would slip through to Stripe.
  if (!Number.isFinite(grossDollars) || grossCents <= 0) {
    throw new Error('grossPay not set or invalid');
  }
  return grossCents;
}

function isTerminalPaymentIntentStatus(status: string | undefined): boolean {
  return status === 'canceled' || status === 'requires_payment_method';
}

/**
 * Create the Connect transfer to the caregiver, sync the appointment, mark the
 * shift paid, and notify. Called ONLY once the funding charge has actually
 * settled — synchronously in processShiftPayment, or later from the
 * payment_intent.succeeded webhook. Transfer creation is idempotency-keyed so
 * a double invocation never double-pays.
 */
export async function settleShiftTransfer(
  appointmentId: string,
  shift: any,
  grossCents: number,
  caregiverStripeAccountId: string,
  attempt: number,
): Promise<void> {
  const ref = db.collection('shiftHours').doc(appointmentId);
  const now = nowIso();
  const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));

  let transferId: string | undefined = shift.stripeTransferId;
  if (!transferId) {
    const transfer = await stripe.transfers.create({
      amount: grossCents,
      currency: shift.currency || 'usd',
      destination: caregiverStripeAccountId,
      transfer_group: appointmentId,
      metadata: { appointmentId, shiftHoursId: appointmentId },
    }, {
      // STABLE per appointment — never attempt-suffixed. A shift is paid out
      // exactly once, so Stripe must dedupe the transfer even across retries.
      // The Firestore `stripeTransferId` guard above is written by the SAME
      // update that can fail (leaving transferId unrecorded), so a per-attempt
      // key would let a retry create a SECOND real transfer — double-paying the
      // caregiver. This key is the only durable guarantee, so it must not vary.
      idempotencyKey: `shift-transfer-${appointmentId}-generation-${generation}`,
    });
    transferId = transfer.id;
  }

  // Sync the appointment's paymentStatus so the EarningsPanel and other
  // appointment-driven UIs reflect what really happened.
  const apptRef = db.collection('appointments').doc(appointmentId);
  const apptSnap = await apptRef.get();
  if (apptSnap.exists) {
    await apptRef.update({
      paymentStatus: 'pending',  // pending payout — money is in Connect balance, not yet to bank
      chargedAt: now,
      stripeChargeId: shift.stripeChargeId,
    });
  }

  await ref.update({
    status: 'paid',
    stripeChargeId: shift.stripeChargeId,
    stripeTransferId: transferId,
    stripeTransferGeneration: generation,
    stripeChargeStatus: 'succeeded',
    paymentAttemptCount: attempt,
    lastPaymentAttemptAt: now,
    updatedAt: now,
  });

  await pushNotification(shift.caregiverId, 'shift_hours_paid', 'Payment sent', `$${(grossCents / 100).toFixed(2)} is on its way.`, { appointmentId });
}

/**
 * Completion path for a charge that settled asynchronously — invoked by the
 * payment_intent.succeeded webhook. Idempotent: a shift already paid is a
 * no-op, and the transfer idempotency key guards a duplicate webhook delivery.
 */
export async function completeShiftPaymentAfterCharge(
  appointmentId: string,
  expectedPaymentIntentId?: string,
  expectedGeneration?: number,
): Promise<void> {
  const ref = db.collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const shift = snap.data()!;
  const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
  if (expectedGeneration != null && expectedGeneration !== generation) return;
  if (expectedPaymentIntentId && shift.stripeChargeId !== expectedPaymentIntentId) return;
  if (shift.status === 'paid' && shift.stripeTransferId) return; // already settled
  if (isOfflinePaymentMethod(shift.paymentMethod)) return;       // offline (cash/Venmo/Zelle) never transfers
  if (!shift.stripeChargeId) return;                             // no charge initiated

  const caregiverSnap = await db.collection('caregivers').doc(shift.caregiverId).get();
  const { getCaregiverPayoutFields } = await import('./caregiverPrivate');
  const payoutFields = await getCaregiverPayoutFields(shift.caregiverId, caregiverSnap.data() ?? null);
  const caregiverStripeAccountId = payoutFields.stripeAccountId as string | undefined;
  if (!caregiverStripeAccountId) return;

  const grossCents = computeGrossCents(shift);
  await settleShiftTransfer(appointmentId, shift, grossCents, caregiverStripeAccountId, (shift.paymentAttemptCount || 0));
  await updateShiftPaymentOperation(shiftPaymentOperationKey(appointmentId, generation), 'completed', {
    providerOperationId: shift.stripeChargeId,
  });
}

/**
 * Reverse a caregiver transfer when the funding charge later fails — the case
 * where the charge settled (transfer fired) but a subsequent
 * payment_intent.payment_failed means we paid from money we never collected.
 * Only acts when a transfer exists; idempotency-keyed against double-reversal.
 * Returns true when a reversal was issued.
 */
export async function reverseShiftTransfer(appointmentId: string, shift: any): Promise<boolean> {
  if (!shift.stripeTransferId) return false;
  const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
  await stripe.transfers.createReversal(shift.stripeTransferId, {
    metadata: { appointmentId, reason: 'charge_failed_after_payout' },
  }, {
    idempotencyKey: `shift-reversal-${appointmentId}-generation-${generation}`,
  });
  return true;
}

export async function processShiftPayment(appointmentId: string, inputShift: any): Promise<{ ok: boolean; error?: string }> {
  const ref = db.collection('shiftHours').doc(appointmentId);
  const claim = await claimShiftPaymentOperation(appointmentId, MAX_PAYMENT_ATTEMPTS);
  if (!claim) return { ok: true };
  const { shift, attempt, generation, operationKey } = claim;
  const now = nowIso();

  // Hard idempotency: never run the payment flow twice on a shift that's
  // already settled. The Stripe-side idempotencyKeys on charge/transfer below
  // are belt-and-suspenders — this short-circuits before we even hit Stripe.
  if (shift.status === 'paid' && shift.stripeChargeId && shift.stripeTransferId) {
    return { ok: true };
  }

  // Declared outside the try so the catch can record it on payment_failed —
  // a `let` scoped inside the try is invisible to the catch (ReferenceError).
  let paymentIntentId: string | undefined = shift.stripeChargeId;

  try {
    const caregiverSnap = await db.collection('caregivers').doc(shift.caregiverId).get();
    const { getCaregiverPayoutFields } = await import('./caregiverPrivate');
    const payoutFields = await getCaregiverPayoutFields(shift.caregiverId, caregiverSnap.data() ?? null);
    const caregiverStripeAccountId = payoutFields.stripeAccountId as string | undefined;
    if (!caregiverStripeAccountId) {
      throw new Error('Caregiver has no Stripe Connect account');
    }

    // ONE source of truth for the family's Stripe customer: customers/{clientId} —
    // the same record the Payment Method tab (v1-getPaymentMethodStatus /
    // getPaymentMethodStatusFor) and both checkout paths use. The old fallback
    // to users/{clientId}.stripeCustomerId let a family be charged while the
    // tab told them they had no card on file; removed 2026-09-17 (no live
    // clients predate the customers/{uid} write, so nothing to backfill).
    const stripeCustomerId = (await db.collection('customers').doc(shift.clientId).get()).data()?.stripeCustomerId;
    if (!stripeCustomerId) {
      throw new Error('Client has no Stripe customer');
    }

    // stripe.customers.retrieve returns Customer | DeletedCustomer. A deleted
    // customer has none of the billing fields, so guard explicitly before
    // reading invoice_settings rather than blind-casting to the live shape.
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if ((customer as Stripe.DeletedCustomer).deleted) {
      throw new Error('Client Stripe customer has been deleted');
    }
    const liveCustomer = customer as Stripe.Customer;
    const defaultPm = liveCustomer.invoice_settings?.default_payment_method
      || liveCustomer.default_source;
    if (!defaultPm) {
      throw new Error('Client has no default payment method');
    }

    const grossCents = computeGrossCents(shift);
    // The service fee — one calculation for the charge and every display (billing/shiftBillingAmounts.ts).
    const feeCents = serviceFeeCentsFor(grossCents);
    const totalChargeCents = grossCents + feeCents;
    // Recorded on the timesheet so the card, the texts and the Stripe dashboard all show the same three numbers.
    await ref.update({ serviceFeeCents: feeCents, totalChargeCents }).catch(() => {});

    // Charge the client, then capture whether it actually settled. An
    // off_session card charge usually returns 'succeeded' synchronously, but
    // some payment methods settle asynchronously ('processing'). We must NOT
    // pay the caregiver until the charge has truly settled — paying earlier
    // risks an un-recoverable payout if the charge later fails.
    let chargeStatus: string;
    if (paymentIntentId) {
      const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
      chargeStatus = existing.status;
      if (isTerminalPaymentIntentStatus(chargeStatus)) {
        // Terminal (canceled / requires_payment_method): abandon this PI and
        // create a fresh one under the next attempt's key.
        paymentIntentId = undefined;
      }
    }

    if (!paymentIntentId) {
      const intent = await stripe.paymentIntents.create({
        amount: totalChargeCents,
        currency: shift.currency || 'usd',
        customer: stripeCustomerId,
        payment_method: typeof defaultPm === 'string' ? defaultPm : defaultPm.id,
        confirm: true,
        off_session: true,
        description: `Evia shift ${appointmentId}`,
        metadata: { appointmentId, shiftHoursId: appointmentId, paymentGeneration: String(generation), grossCents: String(grossCents), serviceFeeCents: String(feeCents) },
      }, {
        // Key on (appointment, attempt) ALWAYS. `attempt` is derived from the
        // input snapshot's paymentAttemptCount, so:
        //  - re-firing the trigger on the same doc computes the SAME attempt →
        //    SAME key → Stripe dedupes → never a second charge for one shift;
        //  - a genuine retry (after a failure bumped paymentAttemptCount, or
        //    after replacing a terminal PI) computes a HIGHER attempt → new key
        //    → a fresh charge, as intended.
        // The previous base-vs-attempt branch could hand two concurrent
        // processors (trigger + scheduled retry sweep) DIFFERENT keys for the
        // same shift → two live PaymentIntents → the client charged twice.
        idempotencyKey: `shift-charge-${appointmentId}-generation-${generation}-attempt-${attempt}`,
      });
      paymentIntentId = intent.id;
      chargeStatus = intent.status;
    } else {
      // Retry path: a charge already exists — re-check whether it has settled
      // before deciding whether to pay out.
      const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
      chargeStatus = existing.status;
    }

    if (chargeStatus !== 'succeeded') {
      // A charge that reached a TERMINAL failure state will never emit a
      // payment_intent.succeeded webhook, so it must not be parked in
      // charge_pending forever. 'canceled' is terminal; an off_session intent
      // that reverts to 'requires_payment_method' means the card was declined.
      // (The create path throws on decline and is handled by the catch below;
      // this guards the retrieve/retry path, where we read an already-failed
      // intent.) Throwing routes it through the payment_failed handling — and
      // retry/escalation — in the catch block.
      if (isTerminalPaymentIntentStatus(chargeStatus)) {
        throw new Error(`Charge ${paymentIntentId} is in terminal failure state '${chargeStatus}'`);
      }
      // Genuinely pending/processing (e.g. 'processing', 'requires_action').
      // Hold the payout in 'charge_pending'; the payment_intent.succeeded webhook
      // then calls completeShiftPaymentAfterCharge to create the transfer once the
      // money has actually moved. Retry jobs only act on 'payment_failed', so
      // they correctly leave a charge_pending shift alone (no double-charge).
      await ref.update({
        status: 'charge_pending',
        stripeChargeId: paymentIntentId,
        stripeChargeStatus: chargeStatus,
        paymentAttemptCount: attempt,
        paymentGeneration: generation,
        nextPaymentReconcileAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        lastPaymentAttemptAt: now,
        updatedAt: now,
      });
      await updateShiftPaymentOperation(operationKey, 'waiting_provider', {
        providerOperationId: paymentIntentId,
        nextAttemptAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
      return { ok: true };
    }

    // Charge settled synchronously — safe to pay the caregiver now.
    await settleShiftTransfer(
      appointmentId,
      { ...shift, stripeChargeId: paymentIntentId },
      grossCents,
      caregiverStripeAccountId,
      attempt,
    );
    await updateShiftPaymentOperation(operationKey, 'completed', { providerOperationId: paymentIntentId });

    return { ok: true };
  } catch (err: any) {
    const errorMessage = err?.message || 'Stripe error';
    const terminal = attempt >= MAX_PAYMENT_ATTEMPTS;
    const updates: any = {
      status: terminal ? 'requires_admin_review' : 'payment_failed',
      stripeFailureReason: errorMessage,
      paymentAttemptCount: attempt,
      paymentGeneration: generation,
      nextPaymentAttemptAt: terminal ? null : nextPaymentAttemptAt(attempt),
      lastPaymentAttemptAt: now,
      updatedAt: now,
    };
    if (paymentIntentId) updates.stripeChargeId = paymentIntentId;
    await ref.update(updates);
    await updateShiftPaymentOperation(
      operationKey,
      terminal ? 'requires_admin_review' : 'retry',
      {
        providerOperationId: paymentIntentId ?? null,
        nextAttemptAt: terminal ? null : updates.nextPaymentAttemptAt,
        lastErrorCode: errorMessage.slice(0, 100),
      },
    );

    if (attempt >= MAX_PAYMENT_ATTEMPTS) {
      await notifyAdmins(
        'shift_hours_payment_failed_escalated',
        'Shift payment failed after retries',
        `Appointment ${appointmentId}: ${errorMessage}`,
        { appointmentId, attempt }
      );
      await Promise.all([
        pushNotification(shift.clientId, 'shift_hours_payment_failed', 'Payment needs review', 'We could not complete this visit payment. Evia support is reviewing it.', { appointmentId }),
        textClient(shift.clientId, `We couldn't complete the payment for ${shift.caregiverName ?? 'your caregiver'}'s visit. Please check the card on file (say "update my card" and I'll send the link), then tell me to retry the payment.`),
        pushNotification(shift.caregiverId, 'shift_hours_payment_failed', 'Payment needs review', 'This visit payment could not be completed automatically. Evia support is reviewing it.', { appointmentId }),
      ]);
    }

    return { ok: false, error: errorMessage };
  }
}

// confirmCashReceived (caregiver confirms receipt of an offline cash/Venmo/
// Zelle payment) was removed along with cash itself (Hamse, 2026-08-23) —
// every shift is now settled by Stripe, so there's nothing left to confirm.

/**
 * Approve shift hours on behalf of the client via iMessage reply.
 */
export async function approveShiftHoursForClient(appointmentId: string): Promise<void> {
  // The APPROVE keyword reply = the Timesheets modal's Approve button: the same
  // shared write (final times, billable amounts, correctionHistory, the
  // caregiver's notification) — not a separate Evia-only approval shape.
  const snap = await db.collection("shiftHours")
    .where("appointmentId", "==", appointmentId)
    .where("status", "==", "pending_client_review")
    .limit(1)
    .get();
  if (snap.empty) return;
  const doc = snap.docs[0];
  await reviewShiftHoursAs(String(doc.data().clientId ?? ""), { appointmentId: doc.id, action: "approve" });
}
