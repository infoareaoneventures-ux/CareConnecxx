import * as admin from "firebase-admin";
import { autoApproveAtIso } from "../config/slaConstants";
import { apptStartMs } from "../utils/scheduledTime";
import { normalizePaymentMethod } from "./paymentMethods";
import { BILLING_CURRENCY } from "./config";
import { evaluateShiftBillingPolicy } from "./shiftBillingPolicy";
import { ShiftLineItem, serviceFeeCentsFor, totalChargeCentsFor } from "./shiftBillingAmounts";

const db = admin.firestore();

export const BILLING_AUTHORITY_VERSION = "server-v1" as const;

// A caregiver clocking in a little early or clocking out a little late
// shouldn't get rejected outright — 15 minutes each side covers realistic
// early-arrival/late-departure timing without loosening the check enough to
// stop catching genuinely mismatched submissions (Hamse, 2026-08-24). Applied
// only at the reject-decision comparisons below, not inside bookedWindowMillis
// itself — that function's raw {start,end} is also used elsewhere (e.g.
// distinguishing an overnight window) where widening it would be wrong.
const SUBMISSION_GRACE_MS = 15 * 60 * 1000;

export class ValidatedShiftHoursError extends Error {
  constructor(
    public readonly code: "not_found" | "forbidden" | "not_billable" | "outside_booked_window" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ValidatedShiftHoursError";
  }
}

export function bookedWindowMillis(appointment: Record<string, unknown>): { start: number; end: number } | null {
  const date = typeof appointment.date === "string" ? appointment.date : "";
  const startTime = typeof appointment.startTime === "string"
    ? appointment.startTime
    : typeof appointment.time === "string" ? appointment.time : "";
  const endTime = typeof appointment.endTime === "string" ? appointment.endTime : "";
  if (!date || !startTime) return null;

  const start = apptStartMs(date, startTime);
  if (!Number.isFinite(start)) return null;
  if (endTime) {
    let end = apptStartMs(date, endTime);
    if (!Number.isFinite(end)) return null;
    if (end <= start) end += 24 * 60 * 60 * 1000;
    return { start, end };
  }

  const durationHours = Number(appointment.durationHours ?? appointment.duration ?? 0);
  if (!Number.isFinite(durationHours) || durationHours <= 0) return null;
  return { start, end: start + durationHours * 60 * 60 * 1000 };
}

export async function createValidatedShiftHours(input: {
  appointmentId: string;
  actorUid: string;
  submittedStartTime: string;
  submittedEndTime: string;
  source: "web" | "mcp" | "care_note" | "agent" | "recurring";
  lineItems?: ShiftLineItem[];
}): Promise<{
  appointmentId: string;
  status: string;
  alreadyExisted: boolean;
  requiresExplicitApproval: boolean;
  totalHours: number;
  grossPayCents: number;
}> {
  const appointmentRef = db.collection("appointments").doc(input.appointmentId);
  const shiftHoursRef = db.collection("shiftHours").doc(input.appointmentId);
  const outboxRef = db.collection("billingApprovalOutbox").doc(`${input.appointmentId}:approval-request:v1`);

  return db.runTransaction(async (transaction) => {
    const [appointmentSnap, existingSnap] = await Promise.all([
      transaction.get(appointmentRef),
      transaction.get(shiftHoursRef),
    ]);
    if (!appointmentSnap.exists) {
      throw new ValidatedShiftHoursError("not_found", "Appointment not found");
    }
    const appointment = appointmentSnap.data()!;
    if (appointment.caregiverId !== input.actorUid) {
      throw new ValidatedShiftHoursError("forbidden", "Appointment is not assigned to this caregiver");
    }
    if (typeof appointment.clientId !== "string" || !appointment.clientId) {
      throw new ValidatedShiftHoursError("not_billable", "Appointment has no verified client");
    }
    if (appointment.status !== "completed") {
      throw new ValidatedShiftHoursError("not_billable", "Appointment is not completed");
    }
    if (existingSnap.exists) {
      const existing = existingSnap.data()!;
      if (existing.caregiverId !== input.actorUid || existing.clientId !== appointment.clientId) {
        throw new ValidatedShiftHoursError("forbidden", "Existing timesheet does not match the appointment");
      }
      const sameInterval = Date.parse(String(existing.submittedStartTime ?? "")) === Date.parse(input.submittedStartTime) &&
        Date.parse(String(existing.submittedEndTime ?? "")) === Date.parse(input.submittedEndTime);
      if (!sameInterval) {
        throw new ValidatedShiftHoursError("conflict", "Different hours were already submitted for this appointment");
      }
      return {
        appointmentId: input.appointmentId,
        status: String(existing.status),
        alreadyExisted: true,
        requiresExplicitApproval: existing.requiresExplicitApproval === true,
        totalHours: Number(existing.submittedTotalHours ?? existing.finalTotalHours ?? 0),
        grossPayCents: Number(existing.amountCents ?? Math.round(Number(existing.grossPay ?? 0) * 100)),
      };
    }

    // A caregiver running early/late doesn't get blocked outright (Hamse,
    // 2026-08-24) — real worked hours always go through. Beyond the grace
    // window (or with no derivable scheduled window at all), it's treated the
    // same way a line item already is: forces requiresExplicitApproval below
    // instead of the normal 24h auto-approve, so the client — who can already
    // see the scheduled window next to the actual clocked times on the review
    // screen — has to actually look at it rather than never being blocked or
    // silently auto-approved either way.
    const bookedWindow = bookedWindowMillis(appointment);
    const submittedStart = new Date(input.submittedStartTime).getTime();
    const submittedEnd = new Date(input.submittedEndTime).getTime();
    const outsideScheduledWindow = !bookedWindow
      || submittedStart < bookedWindow.start - SUBMISSION_GRACE_MS
      || submittedEnd   > bookedWindow.end   + SUBMISSION_GRACE_MS;

    const bookedRate = Number(appointment.rate ?? appointment.hourlyRate);
    const lineItems = input.lineItems ?? [];
    const approvedLineItemsTotalCents = lineItems.reduce(
      (total, lineItem) => total + Math.round(lineItem.amount * 100),
      0,
    );
    const policy = evaluateShiftBillingPolicy({
      startTime: input.submittedStartTime,
      endTime: input.submittedEndTime,
      bookedRateDollars: bookedRate,
      approvedLineItemsTotalCents,
    });
    const requiresExplicitApproval = policy.requiresExplicitApproval || outsideScheduledWindow;
    const trustedAppointment = appointment.billingAuthority === BILLING_AUTHORITY_VERSION;
    const status = trustedAppointment ? "pending_client_review" : "requires_admin_review";
    const submittedAt = new Date().toISOString();
    const autoApproveAt = trustedAppointment && !requiresExplicitApproval ? autoApproveAtIso() : null;

    transaction.create(shiftHoursRef, {
      id: input.appointmentId,
      appointmentId: input.appointmentId,
      caregiverId: appointment.caregiverId,
      caregiverName: appointment.caregiverName ?? "Caregiver",
      clientId: appointment.clientId,
      clientName: appointment.clientName ?? "Client",
      // Multi-recipient attribution rides along from the appointment (fail-soft:
      // absent = the household's sole recipient).
      ...(appointment.seniorName ? { seniorName: appointment.seniorName } : {}),
      ...(appointment.recipientKey ? { recipientKey: appointment.recipientKey } : {}),
      payRate: bookedRate,
      currency: BILLING_CURRENCY,
      paymentMethod: normalizePaymentMethod(appointment.paymentMethod),
      paymentMethodSnapshotAt: submittedAt,
      submittedStartTime: input.submittedStartTime,
      submittedEndTime: input.submittedEndTime,
      submittedTotalHours: policy.totalHours,
      lineItems,
      lineItemsTotal: policy.lineItemsTotalCents / 100,
      basePay: policy.basePayCents / 100,
      grossPay: policy.grossPayCents / 100,
      amountCents: policy.grossPayCents,
      serviceFeeCents: serviceFeeCentsFor(policy.grossPayCents),
      totalChargeCents: totalChargeCentsFor(policy.grossPayCents),
      requiresExplicitApproval,
      billingAuthority: trustedAppointment ? BILLING_AUTHORITY_VERSION : "unverified",
      billingSource: input.source,
      approvalNoticeState: trustedAppointment ? "pending" : "not_required",
      autoApproveAt,
      paymentGeneration: 1,
      paymentAttemptCount: 0,
      status,
      submittedAt,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    });

    transaction.create(outboxRef, {
      operationKey: `${input.appointmentId}:approval-request:v1`,
      appointmentId: input.appointmentId,
      recipientUid: appointment.clientId,
      templateVersion: "shift-approval-v1",
      // Everything the Timesheets card shows, so the family's text says the same (2026-09-17).
      payloadSnapshot: {
        caregiverName: appointment.caregiverName ?? "Caregiver",
        date: appointment.date ?? null,
        totalHours: policy.totalHours,
        bookedRate,
        lineItems,
        grossPayCents: policy.grossPayCents,
        basePayCents: policy.basePayCents,
        lineItemsTotalCents: policy.lineItemsTotalCents,
        submittedStartTime: input.submittedStartTime,
        submittedEndTime: input.submittedEndTime,
        scheduledStartMs: bookedWindow?.start ?? null,
        scheduledEndMs: bookedWindow?.end ?? null,
        requiresExplicitApproval,
        outsideScheduledWindow,
        autoApproveAt,
      },
      state: trustedAppointment ? "pending" : "requires_admin_review",
      attemptCount: 0,
      nextAttemptAt: trustedAppointment ? submittedAt : null,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerMessageId: null,
      providerOperationId: null,
      providerStatus: null,
      completedAt: null,
      createdAt: submittedAt,
      updatedAt: submittedAt,
      lastErrorCode: null,
    });

    return {
      appointmentId: input.appointmentId,
      status,
      alreadyExisted: false,
      requiresExplicitApproval,
      totalHours: policy.totalHours,
      grossPayCents: policy.grossPayCents,
    };
  });
}

// Legacy pipeline (website booking_requests -> onBookingAccepted -> shifts,
// functions/src/scheduled/shiftGenerator.ts): a shift created this way never
// gets a matching appointments doc or an appointmentId field — it never has,
// going back to when this pipeline was first built. submitShiftHours's normal
// appointments-keyed path (createValidatedShiftHours above) can't validate
// against these, so before 2026-08-24 it just rejected them outright. This is
// the restored "submit straight from the shift" capability that existed
// before the 2026-07-13 appointments-centric rewrite (f46bc44) — same
// validated-billing machinery (line items, requiresExplicitApproval, the
// shared shiftHours/billingApprovalOutbox shape), just sourced from the
// shifts doc's own fields instead of a linked appointment. Deliberately does
// NOT make shiftGenerator.ts start writing an appointments doc (the founder's
// call — restore the old capability, don't push the legacy pipeline further
// into the appointments model).
export async function createValidatedShiftHoursFromShift(input: {
  shiftId: string;
  actorUid: string;
  submittedStartTime: string;
  submittedEndTime: string;
  source: "web" | "mcp" | "care_note" | "agent" | "recurring";
  lineItems?: ShiftLineItem[];
}): Promise<{
  appointmentId: string;
  status: string;
  alreadyExisted: boolean;
  requiresExplicitApproval: boolean;
  totalHours: number;
  grossPayCents: number;
}> {
  const shiftRef      = db.collection("shifts").doc(input.shiftId);
  const shiftHoursRef = db.collection("shiftHours").doc(input.shiftId);
  const outboxRef      = db.collection("billingApprovalOutbox").doc(`${input.shiftId}:approval-request:v1`);

  return db.runTransaction(async (transaction) => {
    const [shiftSnap, existingSnap] = await Promise.all([
      transaction.get(shiftRef),
      transaction.get(shiftHoursRef),
    ]);
    if (!shiftSnap.exists) {
      throw new ValidatedShiftHoursError("not_found", "Shift not found");
    }
    const shift = shiftSnap.data()!;
    if (shift.caregiverId !== input.actorUid) {
      throw new ValidatedShiftHoursError("forbidden", "Shift is not assigned to this caregiver");
    }
    if (typeof shift.clientId !== "string" || !shift.clientId) {
      throw new ValidatedShiftHoursError("not_billable", "Shift has no verified client");
    }
    if (shift.status !== "completed") {
      throw new ValidatedShiftHoursError("not_billable", "Shift is not completed");
    }
    if (existingSnap.exists) {
      const existing = existingSnap.data()!;
      if (existing.caregiverId !== input.actorUid || existing.clientId !== shift.clientId) {
        throw new ValidatedShiftHoursError("forbidden", "Existing timesheet does not match the shift");
      }
      const sameInterval = Date.parse(String(existing.submittedStartTime ?? "")) === Date.parse(input.submittedStartTime) &&
        Date.parse(String(existing.submittedEndTime ?? "")) === Date.parse(input.submittedEndTime);
      if (!sameInterval) {
        throw new ValidatedShiftHoursError("conflict", "Different hours were already submitted for this shift");
      }
      return {
        appointmentId: input.shiftId,
        status: String(existing.status),
        alreadyExisted: true,
        requiresExplicitApproval: existing.requiresExplicitApproval === true,
        totalHours: Number(existing.submittedTotalHours ?? existing.finalTotalHours ?? 0),
        grossPayCents: Number(existing.amountCents ?? Math.round(Number(existing.grossPay ?? 0) * 100)),
      };
    }

    // Same "never block real hours, just require explicit approval when
    // something's outside the grace window" treatment as the appointments
    // path above (Hamse, 2026-08-24).
    const bookedWindow = bookedWindowMillis(shift);
    const submittedStart = new Date(input.submittedStartTime).getTime();
    const submittedEnd = new Date(input.submittedEndTime).getTime();
    const outsideScheduledWindow = !bookedWindow
      || submittedStart < bookedWindow.start - SUBMISSION_GRACE_MS
      || submittedEnd   > bookedWindow.end   + SUBMISSION_GRACE_MS;

    const bookedRate = Number(shift.rate);
    const lineItems = input.lineItems ?? [];
    const approvedLineItemsTotalCents = lineItems.reduce(
      (total, lineItem) => total + Math.round(lineItem.amount * 100),
      0,
    );
    const policy = evaluateShiftBillingPolicy({
      startTime: input.submittedStartTime,
      endTime: input.submittedEndTime,
      bookedRateDollars: bookedRate,
      approvedLineItemsTotalCents,
    });
    const requiresExplicitApproval = policy.requiresExplicitApproval || outsideScheduledWindow;
    // Shifts are 100% server-generated by onBookingAccepted — never
    // client-created — so unlike appointments there's no "unverified source"
    // case to gate on; always trusted.
    const status = "pending_client_review";
    const submittedAt = new Date().toISOString();
    const autoApproveAt = !requiresExplicitApproval ? autoApproveAtIso() : null;

    transaction.create(shiftHoursRef, {
      id: input.shiftId,
      appointmentId: input.shiftId, // backward-compat key, matches the pre-2026-07-13 shape
      shiftId: input.shiftId,
      bookingRequestId: shift.bookingRequestId ?? null,
      caregiverId: shift.caregiverId,
      caregiverName: shift.caregiverName ?? "Caregiver",
      clientId: shift.clientId,
      clientName: shift.clientName ?? "Client",
      payRate: bookedRate,
      currency: BILLING_CURRENCY,
      paymentMethod: normalizePaymentMethod(shift.paymentMethod),
      paymentMethodSnapshotAt: submittedAt,
      submittedStartTime: input.submittedStartTime,
      submittedEndTime: input.submittedEndTime,
      submittedTotalHours: policy.totalHours,
      lineItems,
      lineItemsTotal: policy.lineItemsTotalCents / 100,
      basePay: policy.basePayCents / 100,
      grossPay: policy.grossPayCents / 100,
      amountCents: policy.grossPayCents,
      serviceFeeCents: serviceFeeCentsFor(policy.grossPayCents),
      totalChargeCents: totalChargeCentsFor(policy.grossPayCents),
      requiresExplicitApproval,
      billingAuthority: BILLING_AUTHORITY_VERSION,
      billingSource: "web_legacy_shift",
      approvalNoticeState: "pending",
      autoApproveAt,
      paymentGeneration: 1,
      paymentAttemptCount: 0,
      status,
      submittedAt,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    });

    transaction.create(outboxRef, {
      operationKey: `${input.shiftId}:approval-request:v1`,
      appointmentId: input.shiftId,
      recipientUid: shift.clientId,
      templateVersion: "shift-approval-v1",
      payloadSnapshot: {
        caregiverName: shift.caregiverName ?? "Caregiver",
        date: shift.date ?? null,
        totalHours: policy.totalHours,
        bookedRate,
        lineItems,
        grossPayCents: policy.grossPayCents,
        basePayCents: policy.basePayCents,
        lineItemsTotalCents: policy.lineItemsTotalCents,
        submittedStartTime: input.submittedStartTime,
        submittedEndTime: input.submittedEndTime,
        scheduledStartMs: bookedWindow?.start ?? null,
        scheduledEndMs: bookedWindow?.end ?? null,
        requiresExplicitApproval,
        outsideScheduledWindow,
        autoApproveAt,
      },
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: submittedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerMessageId: null,
      providerOperationId: null,
      providerStatus: null,
      completedAt: null,
      createdAt: submittedAt,
      updatedAt: submittedAt,
      lastErrorCode: null,
    });

    return {
      appointmentId: input.shiftId,
      status,
      alreadyExisted: false,
      requiresExplicitApproval,
      totalHours: policy.totalHours,
      grossPayCents: policy.grossPayCents,
    };
  });
}
