import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
const Stripe = require('stripe');

const stripe = new Stripe(functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();

type PaymentMethod = 'cash' | 'credit';

type ShiftHoursStatus =
  | 'pending_client_review'
  | 'correction_proposed'
  | 'approved'
  | 'auto_approved'
  | 'disputed_admin_review'
  | 'paid'
  | 'payment_failed';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PLATFORM_FEE_RATE = 0.015;       // 1.5%
const PLATFORM_FEE_MIN = 0.50;         // $0.50 min
const MAX_PAYMENT_ATTEMPTS = 3;

// ---------- helpers ----------

async function requireAdmin(uid: string) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists || userDoc.data()?.userType !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }
}

function computeTotalHours(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!isFinite(start) || !isFinite(end) || end <= start) {
    throw new functions.https.HttpsError('invalid-argument', 'End time must be after start time');
  }
  return Math.round(((end - start) / 1000 / 60 / 60) * 100) / 100;
}

function nowIso() {
  return new Date().toISOString();
}

async function pushNotification(userId: string, type: string, title: string, message: string, data: any) {
  await db.collection('notifications').add({
    userId,
    type,
    title,
    message,
    data,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function notifyAdmins(type: string, title: string, message: string, data: any) {
  const admins = await db.collection('users').where('userType', '==', 'admin').get();
  const batch = db.batch();
  admins.forEach(docSnap => {
    const ref = db.collection('notifications').doc();
    batch.set(ref, {
      userId: docSnap.id,
      type,
      title,
      message,
      data,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
}

// ---------- callables ----------

/**
 * Caregiver submits hours for a completed appointment.
 */
export const submitShiftHours = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { shiftId, startTime, endTime } = data;
  if (!shiftId || !startTime || !endTime) {
    throw new functions.https.HttpsError('invalid-argument', 'shiftId, startTime, endTime required');
  }

  // Source of truth is now the shifts collection
  const shiftDocRef = db.collection('shifts').doc(shiftId);
  const shiftDocSnap = await shiftDocRef.get();
  if (!shiftDocSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Shift not found');
  }
  const shiftDoc = shiftDocSnap.data()!;

  if (shiftDoc.caregiverId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'Not your shift');
  }
  if (shiftDoc.status !== 'completed') {
    throw new functions.https.HttpsError('failed-precondition', 'Shift is not completed yet');
  }

  const shiftHoursRef = db.collection('shiftHours').doc(shiftId);
  const existing = await shiftHoursRef.get();
  if (existing.exists) {
    throw new functions.https.HttpsError('already-exists', 'Hours already submitted for this shift');
  }

  const caregiverDoc = await db.collection('users').doc(context.auth.uid).get();
  const caregiverData = caregiverDoc.data() || {};
  const totalHours = computeTotalHours(startTime, endTime);
  const payRate = shiftDoc.rate || caregiverData.hourlyRate || 25;
  const paymentMethod: PaymentMethod = shiftDoc.paymentMethod === 'cash' ? 'cash' : 'credit';
  const submittedAt = nowIso();
  const autoApproveAt = new Date(Date.now() + ONE_DAY_MS).toISOString();

  await shiftHoursRef.set({
    id: shiftId,
    appointmentId: shiftId,   // keep field for backward compat with existing queries
    shiftId,
    caregiverId: context.auth.uid,
    caregiverName: caregiverData.name || caregiverData.displayName || shiftDoc.caregiverName || 'Caregiver',
    caregiverPhotoURL: caregiverData.profilePhoto || caregiverData.photoURL || shiftDoc.caregiverPhotoURL || null,
    clientId: shiftDoc.clientId,
    clientName: shiftDoc.clientName || 'Client',
    payRate,
    currency: 'usd',
    paymentMethod,
    submittedStartTime: startTime,
    submittedEndTime: endTime,
    submittedTotalHours: totalHours,
    submittedAt,
    autoApproveAt,
    paymentAttemptCount: 0,
    status: 'pending_client_review' as ShiftHoursStatus,
    createdAt: submittedAt,
    updatedAt: submittedAt,
  });

  await pushNotification(
    shiftDoc.clientId,
    'shift_hours_submitted',
    'Hours submitted for your review',
    `${caregiverData.name || 'Your caregiver'} submitted ${totalHours}h for review. Auto-approves in 24h.`,
    { appointmentId: shiftId, totalHours }
  );

  // iMessage: notify client so they can approve or dispute without opening the app
  try {
    const clientUserSnap = await db.collection("users").doc(shiftDoc.clientId).get();
    const clientPhone = clientUserSnap.data()?.phone as string | undefined;
    if (clientPhone) {
      const amount = (totalHours * payRate).toFixed(2);
      const { sendToPhone } = await import("./linq/client");
      await sendToPhone(
        clientPhone,
        `${caregiverData.name ?? "Your caregiver"} submitted ${totalHours}h for ` +
        `${shiftDoc.date ?? "today"}'s visit ($${amount}).\n\n` +
        `Reply APPROVE to confirm, or DISPUTE if something looks wrong.`
      );
      await db.collection("agent_sessions").doc(clientPhone).set({
        pendingShiftApproval: {
          appointmentId: shiftId,
          amount,
          caregiverName: caregiverData.name ?? "Caregiver",
        },
        pendingShiftApprovalSetAt: new Date().toISOString(),
      }, { merge: true });
    }
  } catch (err) {
    console.error("shiftHours iMessage notification error:", err);
  }

  return { success: true, shiftId, totalHours };
});

/**
 * Client approves or proposes a correction.
 */
export const reviewShiftHours = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { appointmentId, action, proposedStartTime, proposedEndTime, proposalReason } = data;
  if (!appointmentId || (action !== 'approve' && action !== 'propose_correction')) {
    throw new functions.https.HttpsError('invalid-argument', 'appointmentId and valid action required');
  }

  const ref = db.collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Shift hours not found');
  }
  const shift = snap.data()!;

  if (shift.clientId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'Not your appointment');
  }
  if (shift.status !== 'pending_client_review') {
    throw new functions.https.HttpsError('failed-precondition', 'Already reviewed');
  }

  const now = nowIso();

  if (action === 'approve') {
    await ref.update({
      status: 'approved',
      finalStartTime: shift.submittedStartTime,
      finalEndTime: shift.submittedEndTime,
      finalTotalHours: shift.submittedTotalHours,
      grossPay: Math.round(shift.submittedTotalHours * shift.payRate * 100) / 100,
      resolvedAt: now,
      resolvedBy: 'client',
      updatedAt: now,
    });
    await pushNotification(
      shift.caregiverId,
      'shift_hours_approved',
      'Your hours were approved',
      `Client approved ${shift.submittedTotalHours}h.`,
      { appointmentId }
    );
    return { success: true };
  }

  // action === 'propose_correction'
  if (!proposedStartTime || !proposedEndTime) {
    throw new functions.https.HttpsError('invalid-argument', 'Proposed start/end required');
  }
  const proposedTotalHours = computeTotalHours(proposedStartTime, proposedEndTime);
  const correctionRespondByAt = new Date(Date.now() + ONE_DAY_MS).toISOString();

  await ref.update({
    status: 'correction_proposed',
    proposedStartTime,
    proposedEndTime,
    proposedTotalHours,
    proposalReason: proposalReason || null,
    proposedAt: now,
    correctionRespondByAt,
    updatedAt: now,
  });

  await pushNotification(
    shift.caregiverId,
    'shift_hours_correction_proposed',
    'Client proposed a correction',
    `Client proposed ${proposedTotalHours}h (you submitted ${shift.submittedTotalHours}h). Respond within 24h or it auto-accepts.`,
    { appointmentId, proposedTotalHours }
  );

  return { success: true };
});

/**
 * Caregiver accepts or rejects the client's correction.
 */
export const respondToCorrection = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { appointmentId, action } = data;
  if (!appointmentId || (action !== 'accept' && action !== 'reject')) {
    throw new functions.https.HttpsError('invalid-argument', 'appointmentId and valid action required');
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
    await ref.update({
      status: 'approved',
      finalStartTime: shift.proposedStartTime,
      finalEndTime: shift.proposedEndTime,
      finalTotalHours: shift.proposedTotalHours,
      grossPay: Math.round(shift.proposedTotalHours * shift.payRate * 100) / 100,
      resolvedAt: now,
      resolvedBy: 'caregiver',
      updatedAt: now,
    });
    await pushNotification(
      shift.clientId,
      'shift_hours_approved',
      'Caregiver accepted correction',
      `${shift.caregiverName} accepted your proposed ${shift.proposedTotalHours}h.`,
      { appointmentId }
    );
    return { success: true };
  }

  // reject → admin mediation
  await ref.update({
    status: 'disputed_admin_review',
    resolvedBy: null,
    updatedAt: now,
  });

  await notifyAdmins(
    'shift_hours_admin_review',
    'Shift hours dispute needs mediation',
    `${shift.caregiverName} and ${shift.clientName} could not agree on hours for appointment ${appointmentId}.`,
    { appointmentId }
  );

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

  const finalTotalHours = computeTotalHours(finalStartTime, finalEndTime);
  const now = nowIso();

  await ref.update({
    status: 'approved',
    finalStartTime,
    finalEndTime,
    finalTotalHours,
    grossPay: Math.round(finalTotalHours * shift.payRate * 100) / 100,
    resolvedAt: now,
    resolvedBy: 'admin',
    adminAssignedTo: context.auth.uid,
    adminResolutionNote: note || null,
    updatedAt: now,
  });

  await pushNotification(
    shift.caregiverId,
    'shift_hours_approved',
    'Admin resolved your dispute',
    `Final: ${finalTotalHours}h.`,
    { appointmentId }
  );
  await pushNotification(
    shift.clientId,
    'shift_hours_approved',
    'Admin resolved the dispute',
    `Final: ${finalTotalHours}h.`,
    { appointmentId }
  );

  return { success: true };
});

/**
 * Admin manually retries a failed Stripe payment.
 */
export const retryShiftPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }
  await requireAdmin(context.auth.uid);

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
  if (shift.status !== 'payment_failed') {
    throw new functions.https.HttpsError('failed-precondition', 'Not in payment_failed state');
  }

  const result = await processShiftPayment(appointmentId, shift);
  return { success: result.ok, error: result.error };
});

// ---------- scheduled ----------

/**
 * Auto-approve shifts the client hasn't touched within 24h.
 */
export const autoApproveShiftHours = functions.pubsub.schedule('every 1 hours').onRun(async () => {
  const now = nowIso();
  const snap = await db.collection('shiftHours')
    .where('status', '==', 'pending_client_review')
    .where('autoApproveAt', '<=', now)
    .limit(200)
    .get();

  for (const doc of snap.docs) {
    const shift = doc.data();
    await doc.ref.update({
      status: 'auto_approved',
      finalStartTime: shift.submittedStartTime,
      finalEndTime: shift.submittedEndTime,
      finalTotalHours: shift.submittedTotalHours,
      grossPay: Math.round(shift.submittedTotalHours * shift.payRate * 100) / 100,
      resolvedAt: now,
      resolvedBy: 'system_auto_approve',
      updatedAt: now,
    });

    await pushNotification(shift.caregiverId, 'shift_hours_auto_approved', 'Hours auto-approved', `Client did not respond in 24h; ${shift.submittedTotalHours}h auto-approved.`, { appointmentId: doc.id });
    await pushNotification(shift.clientId, 'shift_hours_auto_approved', 'Hours auto-approved', `The 24h review window closed; ${shift.submittedTotalHours}h auto-approved.`, { appointmentId: doc.id });
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
    await doc.ref.update({
      status: 'approved',
      finalStartTime: shift.proposedStartTime,
      finalEndTime: shift.proposedEndTime,
      finalTotalHours: shift.proposedTotalHours,
      grossPay: Math.round(shift.proposedTotalHours * shift.payRate * 100) / 100,
      resolvedAt: now,
      resolvedBy: 'system_auto_accept',
      updatedAt: now,
    });

    await pushNotification(shift.caregiverId, 'shift_hours_approved', 'Correction auto-accepted', `You did not respond in 24h; client's ${shift.proposedTotalHours}h proposal was accepted.`, { appointmentId: doc.id });
    await pushNotification(shift.clientId, 'shift_hours_approved', 'Correction auto-accepted', `Caregiver did not respond; your proposed ${shift.proposedTotalHours}h is final.`, { appointmentId: doc.id });
  }

  return null;
});

/**
 * Retry failed payments up to MAX_PAYMENT_ATTEMPTS.
 */
export const retryFailedShiftPayments = functions.pubsub.schedule('every 6 hours').onRun(async () => {
  const snap = await db.collection('shiftHours')
    .where('status', '==', 'payment_failed')
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

    if (after.paymentMethod === 'cash') {
      // Cash shifts: mark paid immediately — no Stripe charge needed.
      // The client hands cash directly to the caregiver; approval is confirmation.
      const now = nowIso();
      await change.after.ref.update({
        status: 'paid' as ShiftHoursStatus,
        paidMethod: 'cash',
        paidAt: now,
        updatedAt: now,
      });
      await pushNotification(
        after.caregiverId,
        'shift_hours_paid',
        'Cash payment confirmed',
        `${after.finalTotalHours}h approved — collect $${(after.grossPay || 0).toFixed(2)} cash from the client.`,
        { appointmentId: context.params.appointmentId }
      );
      await pushNotification(
        after.clientId,
        'shift_hours_paid',
        'Hours settled',
        `${after.caregiverName}'s ${after.finalTotalHours}h cash shift is confirmed.`,
        { appointmentId: context.params.appointmentId }
      );
      return null;
    }

    await processShiftPayment(context.params.appointmentId, after);
    return null;
  });

// ---------- core Stripe flow ----------

async function processShiftPayment(appointmentId: string, shift: any): Promise<{ ok: boolean; error?: string }> {
  const ref = db.collection('shiftHours').doc(appointmentId);
  const attempt = (shift.paymentAttemptCount || 0) + 1;
  const now = nowIso();

  // Hard idempotency: never run the payment flow twice on a shift that's
  // already settled. The Stripe-side idempotencyKeys on charge/transfer below
  // are belt-and-suspenders — this short-circuits before we even hit Stripe.
  if (shift.status === 'paid' && shift.stripeChargeId && shift.stripeTransferId) {
    return { ok: true };
  }

  try {
    const caregiverSnap = await db.collection('caregivers').doc(shift.caregiverId).get();
    const caregiverStripeAccountId = caregiverSnap.data()?.stripeAccountId;
    if (!caregiverStripeAccountId) {
      throw new Error('Caregiver has no Stripe Connect account');
    }

    const customerSnap = await db.collection('customers').doc(shift.clientId).get();
    const stripeCustomerId = customerSnap.data()?.stripeCustomerId;
    if (!stripeCustomerId) {
      throw new Error('Client has no Stripe customer');
    }

    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const defaultPm = customer.invoice_settings?.default_payment_method
      || customer.default_source;
    if (!defaultPm) {
      throw new Error('Client has no default payment method');
    }

    const grossCents = Math.round((shift.grossPay || 0) * 100);
    if (grossCents <= 0) {
      throw new Error('grossPay not set');
    }
    const feeCents = Math.max(Math.round(grossCents * PLATFORM_FEE_RATE), Math.round(PLATFORM_FEE_MIN * 100));
    const totalChargeCents = grossCents + feeCents;

    let paymentIntentId: string | undefined = shift.stripeChargeId;

    if (!paymentIntentId) {
      const intent = await stripe.paymentIntents.create({
        amount: totalChargeCents,
        currency: shift.currency || 'usd',
        customer: stripeCustomerId,
        payment_method: typeof defaultPm === 'string' ? defaultPm : defaultPm.id,
        confirm: true,
        off_session: true,
        description: `CareConnex shift ${appointmentId}`,
        metadata: { appointmentId, shiftHoursId: appointmentId },
      }, {
        // Idempotency-keyed by appointmentId so re-firing the Firestore
        // trigger never creates a second charge for the same shift.
        idempotencyKey: `shift-charge-${appointmentId}`,
      });
      paymentIntentId = intent.id;
    }

    let transferId: string | undefined = shift.stripeTransferId;
    if (!transferId) {
      const transfer = await stripe.transfers.create({
        amount: grossCents,
        currency: shift.currency || 'usd',
        destination: caregiverStripeAccountId,
        transfer_group: appointmentId,
        metadata: { appointmentId, shiftHoursId: appointmentId },
      }, {
        idempotencyKey: `shift-transfer-${appointmentId}`,
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
        stripeChargeId: paymentIntentId,
      });
    }

    await ref.update({
      status: 'paid',
      stripeChargeId: paymentIntentId,
      stripeTransferId: transferId,
      paymentAttemptCount: attempt,
      lastPaymentAttemptAt: now,
      updatedAt: now,
    });

    await pushNotification(shift.caregiverId, 'shift_hours_paid', 'Payment sent', `$${(grossCents / 100).toFixed(2)} is on its way.`, { appointmentId });

    return { ok: true };
  } catch (err: any) {
    const errorMessage = err?.message || 'Stripe error';
    const updates: any = {
      status: 'payment_failed',
      stripeFailureReason: errorMessage,
      paymentAttemptCount: attempt,
      lastPaymentAttemptAt: now,
      updatedAt: now,
    };
    await ref.update(updates);

    if (attempt >= MAX_PAYMENT_ATTEMPTS) {
      await notifyAdmins(
        'shift_hours_payment_failed_escalated',
        'Shift payment failed after retries',
        `Appointment ${appointmentId}: ${errorMessage}`,
        { appointmentId, attempt }
      );
    }

    return { ok: false, error: errorMessage };
  }
}

/**
 * Approve shift hours on behalf of the client via iMessage reply.
 */
export async function approveShiftHoursForClient(appointmentId: string): Promise<void> {
  const snap = await db.collection("shiftHours")
    .where("appointmentId", "==", appointmentId)
    .where("status", "==", "pending_client_review")
    .limit(1)
    .get();
  if (snap.empty) return;
  await snap.docs[0].ref.update({
    status:     "approved",
    approvedAt: new Date().toISOString(),
    approvedBy: "client_imessage",
    updatedAt:  new Date().toISOString(),
  });
}
