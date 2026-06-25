import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';
import Stripe from 'stripe';
import { autoApproveAtIso, TIMESHEET_AUTO_APPROVE_HOURS } from './config/slaConstants';

const stripe = new Stripe(functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY, {
  timeout: 10_000, // cap SDK calls (default 80s) so a slow Stripe response can't run a payment handler to the function deadline
});
const db = admin.firestore();

type PaymentMethod = 'cash' | 'credit';

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
  return (end - start) / 3_600_000;
}

function fmtHours(hours: number): string {
  const totalSecs = Math.round(hours * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

  const { shiftId, startTime, endTime, lineItems: rawLineItems = [] } = data as {
    shiftId: string;
    startTime: string;
    endTime: string;
    lineItems?: any[];
  };
  if (!shiftId || !startTime || !endTime) {
    throw new functions.https.HttpsError('invalid-argument', 'shiftId, startTime and endTime are required');
  }

  // Validate and sanitise line items
  const VALID_TYPES = ['overtime', 'mileage', 'supplies', 'bonus', 'custom'];
  const lineItems: Array<{ type: string; label: string; note: string; amount: number }> =
    (Array.isArray(rawLineItems) ? rawLineItems : [])
      .filter((li: any) => li && typeof li === 'object')
      .map((li: any) => ({
        type:   VALID_TYPES.includes(li.type) ? li.type : 'custom',
        label:  typeof li.label === 'string' ? li.label.slice(0, 100) : '',
        note:   typeof li.note  === 'string' ? li.note.slice(0, 500)  : '',
        amount: Math.max(0, Math.round((Number(li.amount) || 0) * 100) / 100),
      }))
      .filter((li) => li.amount > 0);

  const lineItemsTotal = lineItems.reduce((sum, li) => sum + li.amount, 0);

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

  const [caregiverDoc, clientDoc] = await Promise.all([
    db.collection('users').doc(context.auth.uid).get(),
    shiftDoc.clientId ? db.collection('users').doc(shiftDoc.clientId).get() : Promise.resolve(null),
  ]);
  const caregiverData = caregiverDoc.data() || {};
  const clientData = clientDoc?.data() || {};
  const totalHours = computeTotalHours(startTime, endTime);
  const payRate = shiftDoc.rate || caregiverData.hourlyRate || 25;
  const paymentMethod: PaymentMethod = (shiftDoc.paymentMethod || '').toLowerCase() === 'cash' ? 'cash' : 'credit';
  const submittedAt = nowIso();
  const autoApproveAt = autoApproveAtIso();
  const basePay  = Math.round(totalHours * payRate * 100) / 100;
  const grossPay = Math.round((basePay + lineItemsTotal) * 100) / 100;

  await shiftHoursRef.set({
    id: shiftId,
    appointmentId: shiftId,   // keep field for backward compat with existing queries
    shiftId,
    caregiverId: context.auth.uid,
    caregiverName: caregiverData.name || caregiverData.displayName || shiftDoc.caregiverName || 'Caregiver',
    caregiverPhotoURL: caregiverData.profilePhoto || caregiverData.photoURL || shiftDoc.caregiverPhotoURL || null,
    clientId: shiftDoc.clientId,
    clientName: shiftDoc.clientName || 'Client',
    clientPhotoURL: clientData.profilePhoto || clientData.photoURL || shiftDoc.clientPhotoURL || null,
    payRate,
    currency: 'usd',
    paymentMethod,
    submittedStartTime: startTime,
    submittedEndTime: endTime,
    submittedTotalHours: totalHours,
    lineItems,
    lineItemsTotal,
    basePay,
    grossPay,
    submittedAt,
    autoApproveAt,
    paymentAttemptCount: 0,
    loggedManually: shiftDoc.loggedManually ?? false,
    status: 'pending_client_review' as ShiftHoursStatus,
    correctionHistory: [{
      by: 'caregiver',
      action: 'submitted',
      at: submittedAt,
      startTime: startTime,
      endTime: endTime,
      hours: totalHours,
      lineItems,
      lineItemsTotal,
      basePay,
      grossPay,
    }],
    createdAt: submittedAt,
    updatedAt: submittedAt,
  });

  await pushNotification(
    shiftDoc.clientId,
    'shift_hours_submitted',
    'Hours submitted for your review',
    `${caregiverData.name || 'Your caregiver'} submitted ${fmtHours(totalHours)} for review. Auto-approves in ${TIMESHEET_AUTO_APPROVE_HOURS}h.`,
    { appointmentId: shiftId, totalHours }
  );

  // iMessage: notify client so they can approve or dispute without opening the app
  try {
    const clientUserSnap = await db.collection("users").doc(shiftDoc.clientId).get();
    const clientPhone = clientUserSnap.data()?.phone as string | undefined;
    if (clientPhone) {
      const amount = grossPay.toFixed(2);
      const { sendToPhone } = await import("./linq/client");
      await sendToPhone(
        clientPhone,
        `${caregiverData.name ?? "Your caregiver"} submitted ${fmtHours(totalHours)} for ` +
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
 * Client approves, proposes a correction, accepts a counter-proposal, or escalates.
 */
export const reviewShiftHours = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be authenticated');
  }

  const { appointmentId, action, proposedStartTime, proposedEndTime, proposalReason, lineItems: rawLineItems } = data;
  if (!appointmentId || !['approve', 'propose_correction', 'accept_counter', 'escalate'].includes(action)) {
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

  // Validate status constraints per action
  if ((action === 'approve' || action === 'propose_correction') && shift.status !== 'pending_client_review') {
    throw new functions.https.HttpsError('failed-precondition', 'Already reviewed');
  }
  if ((action === 'accept_counter' || action === 'escalate') && shift.status !== 'caregiver_counter_proposed') {
    throw new functions.https.HttpsError('failed-precondition', 'No counter-proposal to respond to');
  }

  const now = nowIso();

  if (action === 'approve') {
    const approvedBasePay      = Math.round(shift.submittedTotalHours * shift.payRate * 100) / 100;
    const approvedLineItems    = Array.isArray(shift.lineItems) ? shift.lineItems : [];
    const approvedLineItemsTotal = Math.round(approvedLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0) * 100) / 100;
    const approvedGrossPay     = shift.grossPay ?? Math.round((approvedBasePay + approvedLineItemsTotal) * 100) / 100;
    await ref.update({
      status: 'approved',
      finalStartTime: shift.submittedStartTime,
      finalEndTime: shift.submittedEndTime,
      finalTotalHours: shift.submittedTotalHours,
      basePay: approvedBasePay,
      lineItems: approvedLineItems,
      lineItemsTotal: approvedLineItemsTotal,
      grossPay: approvedGrossPay,
      resolvedAt: now,
      resolvedBy: 'client',
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: 'client',
        action: 'accepted',
        at: now,
        startTime: shift.submittedStartTime,
        endTime: shift.submittedEndTime,
        hours: shift.submittedTotalHours,
        lineItems: approvedLineItems,
        lineItemsTotal: approvedLineItemsTotal,
        basePay: approvedBasePay,
        grossPay: approvedGrossPay,
      }),
    });
    await pushNotification(
      shift.caregiverId,
      'shift_hours_approved',
      'Your hours were approved',
      `Client approved ${fmtHours(shift.submittedTotalHours)}.`,
      { appointmentId }
    );
    return { success: true };
  }

  if (action === 'propose_correction') {
    if (!proposedStartTime || !proposedEndTime) {
      throw new functions.https.HttpsError('invalid-argument', 'Proposed start/end required');
    }
    const proposedTotalHours = computeTotalHours(proposedStartTime, proposedEndTime);
    const correctionRespondByAt = new Date(Date.now() + ONE_DAY_MS).toISOString();

    const proposedLineItems: Array<{ type: string; label: string; note: string; amount: number }> =
      Array.isArray(rawLineItems) ? rawLineItems : (shift.lineItems ?? []);
    const proposedLineItemsTotal = proposedLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0);
    const proposedBasePay = Math.round(proposedTotalHours * shift.payRate * 100) / 100;
    const proposedGrossPay = Math.round((proposedBasePay + proposedLineItemsTotal) * 100) / 100;

    await ref.update({
      status: 'correction_proposed',
      proposedStartTime,
      proposedEndTime,
      proposedTotalHours,
      proposedLineItems,
      proposedLineItemsTotal,
      proposedGrossPay,
      proposalReason: proposalReason || null,
      proposedAt: now,
      correctionRespondByAt,
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: 'client',
        action: 'proposed_correction',
        at: now,
        startTime: proposedStartTime,
        endTime: proposedEndTime,
        hours: proposedTotalHours,
        basePay: proposedBasePay,
        lineItems: proposedLineItems,
        lineItemsTotal: proposedLineItemsTotal,
        grossPay: proposedGrossPay,
        note: proposalReason || null,
      }),
    });

    await pushNotification(
      shift.caregiverId,
      'shift_hours_correction_proposed',
      'Client proposed a correction',
      `Client proposed ${fmtHours(proposedTotalHours)} (you submitted ${fmtHours(shift.submittedTotalHours)}). Respond within 24h or it auto-accepts.`,
      { appointmentId, proposedTotalHours }
    );
    return { success: true };
  }

  if (action === 'accept_counter') {
    const counterHours = shift.counterTotalHours;
    if (!counterHours) {
      throw new functions.https.HttpsError('failed-precondition', 'Counter-proposal data missing');
    }
    const counterBasePay     = Math.round(counterHours * shift.payRate * 100) / 100;
    const safeCounterLineItems: any[] = Array.isArray(shift.counterLineItems) ? shift.counterLineItems : [];
    const counterLineItemsTotal = Math.round(safeCounterLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0) * 100) / 100;
    const acceptedGrossPay   = shift.counterGrossPay ?? Math.round((counterBasePay + counterLineItemsTotal) * 100) / 100;

    await ref.update({
      status: 'approved',
      finalStartTime: shift.counterStartTime,
      finalEndTime: shift.counterEndTime,
      finalTotalHours: counterHours,
      lineItems: safeCounterLineItems,
      lineItemsTotal: counterLineItemsTotal,
      basePay: counterBasePay,
      grossPay: acceptedGrossPay,
      resolvedAt: now,
      resolvedBy: 'client',
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: 'client',
        action: 'accepted',
        at: now,
        startTime: shift.counterStartTime,
        endTime: shift.counterEndTime,
        hours: counterHours,
        lineItems: safeCounterLineItems,
        lineItemsTotal: counterLineItemsTotal,
        basePay: counterBasePay,
        grossPay: acceptedGrossPay,
      }),
    });
    await pushNotification(
      shift.caregiverId,
      'shift_hours_approved',
      'Client accepted your counter-proposal',
      `Client accepted ${counterHours}h. Payment will be processed shortly.`,
      { appointmentId }
    );
    return { success: true };
  }

  // action === 'escalate'
  await ref.update({
    status: 'disputed_admin_review',
    resolvedBy: null,
    updatedAt: now,
    correctionHistory: admin.firestore.FieldValue.arrayUnion({
      by: 'client',
      action: 'escalated',
      at: now,
    }),
  });

  await notifyAdmins(
    'shift_hours_admin_review',
    'Shift hours dispute needs mediation',
    `${shift.clientName} escalated a dispute with ${shift.caregiverName} for appointment ${appointmentId}.`,
    { appointmentId }
  );

  return { success: true };
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
    const finalLineItems = Array.isArray(shift.proposedLineItems) ? shift.proposedLineItems : (shift.lineItems ?? []);
    const finalLineItemsTotal = Math.round(finalLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0) * 100) / 100;
    const finalBasePay = Math.round(shift.proposedTotalHours * shift.payRate * 100) / 100;
    const finalGrossPay = shift.proposedGrossPay != null
      ? shift.proposedGrossPay
      : Math.round((finalBasePay + finalLineItemsTotal) * 100) / 100;

    await ref.update({
      status: 'approved',
      finalStartTime: shift.proposedStartTime,
      finalEndTime: shift.proposedEndTime,
      finalTotalHours: shift.proposedTotalHours,
      lineItems: finalLineItems,
      lineItemsTotal: finalLineItemsTotal,
      basePay: finalBasePay,
      grossPay: finalGrossPay,
      resolvedAt: now,
      resolvedBy: 'caregiver',
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: 'caregiver',
        action: 'accepted',
        at: now,
        startTime: shift.proposedStartTime,
        endTime: shift.proposedEndTime,
        hours: shift.proposedTotalHours,
        lineItems: finalLineItems,
        lineItemsTotal: finalLineItemsTotal,
        basePay: finalBasePay,
        grossPay: finalGrossPay,
      }),
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

  // action === 'counter_propose'
  if (!counterStartTime || !counterEndTime) {
    throw new functions.https.HttpsError('invalid-argument', 'counterStartTime and counterEndTime are required for counter_propose');
  }
  const counterTotalHours = computeTotalHours(counterStartTime, counterEndTime);
  const safeCounterLineItems = Array.isArray(rawCounterLineItems) ? rawCounterLineItems : (shift.lineItems ?? []);
  const counterLineItemsTotal = safeCounterLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0);
  const counterBasePay = Math.round(counterTotalHours * (shift.payRate || 0) * 100) / 100;
  const counterGrossPay = Math.round((counterBasePay + counterLineItemsTotal) * 100) / 100;

  await ref.update({
    status: 'caregiver_counter_proposed' as ShiftHoursStatus,
    counterStartTime,
    counterEndTime,
    counterTotalHours,
    counterNote: counterNote || null,
    counterLineItems: safeCounterLineItems,
    counterLineItemsTotal,
    counterGrossPay,
    updatedAt: now,
    correctionHistory: admin.firestore.FieldValue.arrayUnion({
      by: 'caregiver',
      action: 'counter_proposed',
      at: now,
      startTime: counterStartTime,
      endTime: counterEndTime,
      hours: counterTotalHours,
      basePay: counterBasePay,
      lineItems: safeCounterLineItems,
      lineItemsTotal: counterLineItemsTotal,
      grossPay: counterGrossPay,
      note: counterNote || null,
    }),
  });

  await pushNotification(
    shift.clientId,
    'shift_hours_counter_proposed',
    'Caregiver sent a counter-proposal',
    `${shift.caregiverName} sent a counter-proposal for ${counterTotalHours}h. Review and accept or escalate.`,
    { appointmentId, counterTotalHours }
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

  const adminBasePay        = Math.round(finalTotalHours * shift.payRate * 100) / 100;
  const adminLineItems      = Array.isArray(shift.lineItems) ? shift.lineItems : [];
  const adminLineItemsTotal = Math.round(adminLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0) * 100) / 100;
  const adminGrossPay       = Math.round((adminBasePay + adminLineItemsTotal) * 100) / 100;
  await ref.update({
    status: 'approved',
    finalStartTime,
    finalEndTime,
    finalTotalHours,
    basePay: adminBasePay,
    lineItems: adminLineItems,
    lineItemsTotal: adminLineItemsTotal,
    grossPay: adminGrossPay,
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
      hours: finalTotalHours,
      lineItems: adminLineItems,
      lineItemsTotal: adminLineItemsTotal,
      basePay: adminBasePay,
      grossPay: adminGrossPay,
      note: note || null,
    }),
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
  await ref.update({ status: 'approved', retryCount: (shift.retryCount ?? 0) + 1 });
  return { success: true };
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
    const autoFinalLineItems = Array.isArray(shift.proposedLineItems) ? shift.proposedLineItems : (shift.lineItems ?? []);
    const autoFinalLineItemsTotal = autoFinalLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0);
    const autoFinalBasePay  = Math.round(shift.proposedTotalHours * shift.payRate * 100) / 100;
    const autoFinalLineItemsTotalRounded = Math.round(autoFinalLineItemsTotal * 100) / 100;
    const autoFinalGrossPay = shift.proposedGrossPay != null
      ? shift.proposedGrossPay
      : Math.round((autoFinalBasePay + autoFinalLineItemsTotalRounded) * 100) / 100;
    await doc.ref.update({
      status: 'approved',
      finalStartTime: shift.proposedStartTime,
      finalEndTime: shift.proposedEndTime,
      finalTotalHours: shift.proposedTotalHours,
      lineItems: autoFinalLineItems,
      lineItemsTotal: autoFinalLineItemsTotalRounded,
      basePay: autoFinalBasePay,
      grossPay: autoFinalGrossPay,
      resolvedAt: now,
      resolvedBy: 'system_auto_accept',
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: 'system',
        action: 'accepted',
        at: now,
        startTime: shift.proposedStartTime,
        endTime: shift.proposedEndTime,
        hours: shift.proposedTotalHours,
        lineItems: autoFinalLineItems,
        lineItemsTotal: autoFinalLineItemsTotalRounded,
        basePay: autoFinalBasePay,
        grossPay: autoFinalGrossPay,
      }),
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
    // Re-approve guard: a shift that already has a transfer was already paid out.
    // Without this, an approved -> payment_failed -> re-approved cycle (before
    // is payment_failed, so wasPayable is false) would fire a second transfer.
    if (after.stripeTransferId) {
      return null;
    }

    if (after.paymentMethod === 'cash') {
      // Cash shifts: client has approved — notify caregiver to confirm cash receipt.
      // We do NOT mark paid here; caregiver must call confirmCashReceived to close it out.
      await pushNotification(
        after.caregiverId,
        'shift_hours_cash_pending_confirmation',
        'Client approved your hours',
        `Confirm you received $${(after.grossPay || 0).toFixed(2)} cash from ${after.clientName || 'the client'}.`,
        { appointmentId: context.params.appointmentId }
      );
      return null;
    }

    await processShiftPayment(context.params.appointmentId, after);
    return null;
  });

// ---------- core Stripe flow ----------

// Resolve gross pay in cents. shiftHours docs come from three rails that
// historically disagreed on field names: in-app submitShiftHours writes
// `grossPay` (dollars); the Cara MCP tool and care-notes completion write
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

  let transferId: string | undefined = shift.stripeTransferId;
  if (!transferId) {
    const transfer = await stripe.transfers.create({
      amount: grossCents,
      currency: shift.currency || 'usd',
      destination: caregiverStripeAccountId,
      transfer_group: appointmentId,
      metadata: { appointmentId, shiftHoursId: appointmentId },
    }, {
      idempotencyKey: attempt > 1 ? `shift-transfer-${appointmentId}-attempt-${attempt}` : `shift-transfer-${appointmentId}`,
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
export async function completeShiftPaymentAfterCharge(appointmentId: string): Promise<void> {
  const ref = db.collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const shift = snap.data()!;
  if (shift.status === 'paid' && shift.stripeTransferId) return; // already settled
  if (shift.paymentMethod === 'cash') return;                    // cash never transfers
  if (!shift.stripeChargeId) return;                             // no charge initiated

  const caregiverSnap = await db.collection('caregivers').doc(shift.caregiverId).get();
  const caregiverStripeAccountId = caregiverSnap.data()?.stripeAccountId;
  if (!caregiverStripeAccountId) return;

  const grossCents = computeGrossCents(shift);
  await settleShiftTransfer(appointmentId, shift, grossCents, caregiverStripeAccountId, (shift.paymentAttemptCount || 0));
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
  await stripe.transfers.createReversal(shift.stripeTransferId, {
    metadata: { appointmentId, reason: 'charge_failed_after_payout' },
  }, {
    idempotencyKey: `shift-reversal-${appointmentId}`,
  });
  return true;
}

export async function processShiftPayment(appointmentId: string, shift: any): Promise<{ ok: boolean; error?: string }> {
  const ref = db.collection('shiftHours').doc(appointmentId);
  const attempt = (shift.paymentAttemptCount || 0) + 1;
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
    const caregiverStripeAccountId = caregiverSnap.data()?.stripeAccountId;
    if (!caregiverStripeAccountId) {
      throw new Error('Caregiver has no Stripe Connect account');
    }

    // The Stripe customer id lives in customers/{clientId} (written when the
    // checkout session is created) AND is mirrored onto users/{clientId} by the
    // checkout webhook. Read customers first, then fall back to users so a
    // client subscribed via either path can be charged.
    let stripeCustomerId = (await db.collection('customers').doc(shift.clientId).get()).data()?.stripeCustomerId;
    if (!stripeCustomerId) {
      stripeCustomerId = (await db.collection('users').doc(shift.clientId).get()).data()?.stripeCustomerId;
    }
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
    const feeCents = Math.max(Math.round(grossCents * PLATFORM_FEE_RATE), Math.round(PLATFORM_FEE_MIN * 100));
    const totalChargeCents = grossCents + feeCents;

    // Charge the client, then capture whether it actually settled. An
    // off_session card charge usually returns 'succeeded' synchronously, but
    // some payment methods settle asynchronously ('processing'). We must NOT
    // pay the caregiver until the charge has truly settled — paying earlier
    // risks an un-recoverable payout if the charge later fails.
    let replacedTerminalChargeId: string | undefined;
    let chargeStatus: string;
    if (paymentIntentId) {
      const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
      chargeStatus = existing.status;
      if (isTerminalPaymentIntentStatus(chargeStatus)) {
        replacedTerminalChargeId = paymentIntentId;
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
        description: `CareConnex shift ${appointmentId}`,
        metadata: { appointmentId, shiftHoursId: appointmentId },
      }, {
        // Idempotency-keyed by appointmentId so re-firing the Firestore
        // trigger never creates a second charge for the same shift.
        idempotencyKey: replacedTerminalChargeId || shift.status === 'payment_failed'
          ? `shift-charge-${appointmentId}-attempt-${attempt}`
          : `shift-charge-${appointmentId}`,
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
        lastPaymentAttemptAt: now,
        updatedAt: now,
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
    if (paymentIntentId) updates.stripeChargeId = paymentIntentId;
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
 * Caregiver confirms they received cash payment for an approved cash shift.
 * Moves status from approved/auto_approved → paid and notifies both parties.
 */
export const confirmCashReceived = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }
  const { appointmentId } = data as { appointmentId: string };
  if (!appointmentId) {
    throw new functions.https.HttpsError('invalid-argument', 'appointmentId is required');
  }

  const ref = db.collection('shiftHours').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'Shift hours record not found');
  }

  const shift = snap.data()!;

  if (shift.caregiverId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'Only the caregiver can confirm cash receipt');
  }

  if (shift.paymentMethod !== 'cash') {
    throw new functions.https.HttpsError('failed-precondition', 'Shift is not a cash payment');
  }

  if (shift.status !== 'approved' && shift.status !== 'auto_approved') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Shift must be approved to confirm — current status: ${shift.status}`
    );
  }

  const now = nowIso();
  await ref.update({
    status: 'paid' as ShiftHoursStatus,
    paidMethod: 'cash',
    paidAt: now,
    cashConfirmedAt: now,
    updatedAt: now,
  });

  await pushNotification(
    shift.caregiverId,
    'shift_hours_paid',
    'Cash payment confirmed',
    `${shift.finalTotalHours}h · $${(shift.grossPay || 0).toFixed(2)} marked as received.`,
    { appointmentId }
  );
  await pushNotification(
    shift.clientId,
    'shift_hours_paid',
    'Hours settled',
    `${shift.caregiverName}'s ${shift.finalTotalHours}h cash shift is confirmed paid.`,
    { appointmentId }
  );

  return { success: true };
});

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
  const iMsgShift = snap.docs[0].data();
  const iMsgBasePay        = Math.round(iMsgShift.submittedTotalHours * iMsgShift.payRate * 100) / 100;
  const iMsgLineItems      = Array.isArray(iMsgShift.lineItems) ? iMsgShift.lineItems : [];
  const iMsgLineItemsTotal = Math.round(iMsgLineItems.reduce((s: number, li: any) => s + (Number(li.amount) || 0), 0) * 100) / 100;
  const iMsgGrossPay       = iMsgShift.grossPay ?? Math.round((iMsgBasePay + iMsgLineItemsTotal) * 100) / 100;
  await snap.docs[0].ref.update({
    status:          "approved",
    finalStartTime:  iMsgShift.submittedStartTime,
    finalEndTime:    iMsgShift.submittedEndTime,
    finalTotalHours: iMsgShift.submittedTotalHours,
    basePay:         iMsgBasePay,
    lineItems:       iMsgLineItems,
    lineItemsTotal:  iMsgLineItemsTotal,
    grossPay:        iMsgGrossPay,
    resolvedAt:      new Date().toISOString(),
    resolvedBy:      "client_imessage",
    approvedAt:      new Date().toISOString(),
    approvedBy:      "client_imessage",
    updatedAt:       new Date().toISOString(),
  });
}
