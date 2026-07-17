import * as admin from "firebase-admin";
import { autoApproveAtIso } from "../config/slaConstants";
import { apptStartMs } from "../utils/scheduledTime";
import { normalizePaymentMethod } from "./paymentMethods";
import { BILLING_CURRENCY } from "./config";
import { evaluateShiftBillingPolicy } from "./shiftBillingPolicy";

const db = admin.firestore();

export const BILLING_AUTHORITY_VERSION = "server-v1" as const;

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

    const bookedWindow = bookedWindowMillis(appointment);
    const submittedStart = new Date(input.submittedStartTime).getTime();
    const submittedEnd = new Date(input.submittedEndTime).getTime();
    if (!bookedWindow || submittedStart < bookedWindow.start || submittedEnd > bookedWindow.end) {
      throw new ValidatedShiftHoursError("outside_booked_window", "Submitted hours must stay within the booked appointment window");
    }

    const bookedRate = Number(appointment.rate ?? appointment.hourlyRate);
    const policy = evaluateShiftBillingPolicy({
      startTime: input.submittedStartTime,
      endTime: input.submittedEndTime,
      bookedRateDollars: bookedRate,
    });
    const trustedAppointment = appointment.billingAuthority === BILLING_AUTHORITY_VERSION;
    const status = trustedAppointment ? "pending_client_review" : "requires_admin_review";
    const submittedAt = new Date().toISOString();
    const autoApproveAt = trustedAppointment && !policy.requiresExplicitApproval ? autoApproveAtIso() : null;

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
      lineItems: [],
      lineItemsTotal: 0,
      basePay: policy.basePayCents / 100,
      grossPay: policy.grossPayCents / 100,
      amountCents: policy.grossPayCents,
      requiresExplicitApproval: policy.requiresExplicitApproval,
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
      payloadSnapshot: {
        caregiverName: appointment.caregiverName ?? "Caregiver",
        date: appointment.date ?? null,
        totalHours: policy.totalHours,
        bookedRate,
        lineItems: [],
        grossPayCents: policy.grossPayCents,
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
      requiresExplicitApproval: policy.requiresExplicitApproval,
      totalHours: policy.totalHours,
      grossPayCents: policy.grossPayCents,
    };
  });
}
