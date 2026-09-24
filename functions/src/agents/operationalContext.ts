import * as admin from "firebase-admin";
import { sanitizePromptContext, sanitizePromptContextValue } from "./promptContext";
import { selectNextAppointment, NEXT_APPOINTMENT_STATUSES } from "./careEvidence";
import { businessTodayStr } from "../utils/scheduledTime";

const db = admin.firestore();

interface PendingActionContext {
  id: string;
  preview?: string;
  toolName?: string;
  expiresAt?: string;
}

interface AlertContext {
  id: string;
  type?: string;
  severity?: string;
  message?: string;
  reason?: string;
  createdAt?: string;
}

interface FailedActionContext {
  id: string;
  actionType?: string;
  toolName?: string;
  targetDocId?: string;
  errorReason?: string;
  updatedAt?: string;
}

interface CaregiverStateContext {
  onboardingStatus?: string;
  verificationStatus?: string;
  backgroundCheckStatus?: string;
  accountStatus?: string;
  nextAppointment?: string;
  pendingShiftHours?: string;
  lastPayoutStatus?: string;
}

interface ClientStateContext {
  nextAppointment?: string;
  latestCareUpdate?: string;
  pendingInvoiceOrPayment?: string;
}

export type OperationalRecipeLeadRole = "client" | "caregiver";

export interface CaraOperationalContext {
  pendingActions: PendingActionContext[];
  openAlerts: AlertContext[];
  failedActions: FailedActionContext[];
  caregiverState?: CaregiverStateContext;
  clientState?: ClientStateContext;
}

function asString(value: unknown): string | undefined {
  return sanitizePromptContextValue(value);
}

function truncate(value: string | undefined, max = 160): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

async function safeDocs(queryPromise: Promise<FirebaseFirestore.QuerySnapshot>): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  try {
    const snap = await queryPromise;
    return snap.docs;
  } catch (err) {
    console.warn("cara operational context query failed", err instanceof Error ? err.message : err);
    return [];
  }
}

async function safeDoc(docPromise: Promise<FirebaseFirestore.DocumentSnapshot>): Promise<FirebaseFirestore.DocumentSnapshot | null> {
  try {
    return await docPromise;
  } catch (err) {
    console.warn("cara operational context doc read failed", err instanceof Error ? err.message : err);
    return null;
  }
}

function firstDocSummary(docs: FirebaseFirestore.QueryDocumentSnapshot[], fields: string[]): string | undefined {
  const doc = docs[0];
  if (!doc) return undefined;
  const data = doc.data();
  return fields
    .map((field) => asString(data[field]))
    .filter(Boolean)
    .join(" ")
    .trim() || undefined;
}

export async function loadCaraOperationalContext(params: {
  phone: string;
  userId?: string;
  caregiverId?: string;
}): Promise<CaraOperationalContext> {
  const { phone, userId, caregiverId } = params;
  const caregiverContextId = caregiverId ?? userId;

  const [
    pendingDocs,
    alertByPhoneDocs,
    alertByUserDocs,
    failedByPhoneDocs,
    caregiverDoc,
    caregiverShiftDocs,
    caregiverPayoutDocs,
    clientAppointmentDocs,
    clientCareDocs,
    invoiceDocs,
  ] = await Promise.all([
    safeDocs(db.collection("pending_actions")
      .where("phone", "==", phone)
      .where("status", "==", "awaiting")
      .orderBy("proposedAt", "desc")
      .limit(3)
      .get()),
    safeDocs(db.collection("admin_alerts")
      .where("resolved", "==", false)
      .where("phone", "==", phone)
      .orderBy("createdAt", "desc")
      .limit(3)
      .get()),
    userId
      ? safeDocs(db.collection("admin_alerts")
        .where("resolved", "==", false)
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(3)
        .get())
      : Promise.resolve([]),
    safeDocs(db.collection("agent_action_ledger")
      .where("phone", "==", phone)
      .where("status", "==", "failed")
      .orderBy("createdAt", "desc")
      .limit(3)
      .get()),
    caregiverContextId ? safeDoc(db.collection("caregivers").doc(caregiverContextId).get()) : Promise.resolve(null),
    caregiverContextId
      ? safeDocs(db.collection("shiftHours")
        .where("caregiverId", "==", caregiverContextId)
        .orderBy("submittedAt", "desc")
        .limit(3)
        .get())
      : Promise.resolve([]),
    caregiverContextId
      ? safeDocs(db.collection("caregivers")
        .doc(caregiverContextId)
        .collection("payouts")
        .orderBy("createdAt", "desc")
        .limit(2)
        .get())
      : Promise.resolve([]),
    // Next-visit candidates (U1/AE3): query from business-today FORWARD in
    // ascending order (contract Q27; same shape as qaAgent.getNextAppointment).
    // The old desc-ordered query fed a recent PAST visit into "Client next
    // visit" whenever no future one landed in the window.
    userId
      ? safeDocs(db.collection("appointments")
        .where("clientId", "==", userId)
        .where("status", "in", [...NEXT_APPOINTMENT_STATUSES])
        .where("date", ">=", businessTodayStr())
        .orderBy("date", "asc")
        .limit(10)
        .get())
      : Promise.resolve([]),
    userId
      ? safeDocs(db.collection("care_journal")
        .where("clientId", "==", userId)
        .orderBy("timestamp", "desc")
        .limit(2)
        .get())
      : Promise.resolve([]),
    userId
      ? safeDocs(db.collection("invoices")
        .where("clientId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(3)
        .get())
      : Promise.resolve([]),
  ]);

  const seenAlerts = new Set<string>();
  const openAlerts = [...alertByPhoneDocs, ...alertByUserDocs]
    .filter((doc) => {
      if (seenAlerts.has(doc.id)) return false;
      seenAlerts.add(doc.id);
      return true;
    })
    .slice(0, 4)
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        type: asString(data.type),
        severity: asString(data.severity),
        message: truncate(asString(data.message)),
        reason: truncate(asString(data.reason ?? data.error)),
        createdAt: asString(data.createdAt),
      };
    });

  const caregiverData = caregiverDoc?.exists ? caregiverDoc.data() : undefined;
  const pendingCaregiverShift = caregiverShiftDocs
    .map((doc): Record<string, unknown> & { id: string } => ({ id: doc.id, ...doc.data() as Record<string, unknown> }))
    .find((shift) => [
      "pending_client_review",
      "approved",
      "payment_failed",
      "correction_proposed",
      "disputed_admin_review",
      "disputed",
    ].includes(String(shift.status ?? "")));
  const lastPayout = caregiverPayoutDocs[0]?.data();

  // Earliest strictly-future start wins; same-day visits that already started
  // are excluded (U1/AE3). In-progress visits are active-visit context, not
  // "next visit", and are surfaced by their own loaders.
  const nextClientAppointment = selectNextAppointment(
    clientAppointmentDocs.map((doc): Record<string, unknown> & { id: string } => ({ id: doc.id, ...doc.data() as Record<string, unknown> })),
  );
  const latestCare = clientCareDocs[0]?.data();
  const pendingInvoice = invoiceDocs
    .map((doc): Record<string, unknown> & { id: string } => ({ id: doc.id, ...doc.data() as Record<string, unknown> }))
    .find((invoice) => ["pending", "sent", "awaiting_approval", "payment_failed"].includes(String(invoice.status ?? "")));

  const caregiverState: CaregiverStateContext | undefined = caregiverData ? {
    onboardingStatus: asString(caregiverData.onboardingStatus),
    verificationStatus: asString(caregiverData.verificationStatus),
    backgroundCheckStatus: asString(caregiverData.backgroundCheckData?.status),
    accountStatus: asString(caregiverData.status),
    nextAppointment: firstDocSummary(caregiverShiftDocs, ["appointmentId", "status", "date", "startTime"]),
    pendingShiftHours: pendingCaregiverShift
      ? `${pendingCaregiverShift.id}: ${String(pendingCaregiverShift.status ?? "unknown")}${pendingCaregiverShift.amountCents ? ` $${Number(pendingCaregiverShift.amountCents) / 100}` : ""}`
      : undefined,
    lastPayoutStatus: lastPayout ? `${asString(lastPayout.status) ?? "unknown"}${lastPayout.amount ? ` $${Number(lastPayout.amount) / 100}` : ""}` : undefined,
  } : undefined;

  const clientState: ClientStateContext | undefined = userId ? {
    nextAppointment: nextClientAppointment
      ? `${String(nextClientAppointment.id)} ${String(nextClientAppointment.status ?? "unknown")} ${String(nextClientAppointment.date ?? "")} ${String(nextClientAppointment.startTime ?? "")}`.trim()
      : undefined,
    latestCareUpdate: latestCare
      ? truncate(asString(latestCare.summary) ?? asString(latestCare.notes) ?? asString(latestCare.wellness), 220)
      : undefined,
    pendingInvoiceOrPayment: pendingInvoice
      ? `${String(pendingInvoice.id)} ${String(pendingInvoice.status ?? "unknown")}`
      : undefined,
  } : undefined;

  return {
    // pending_actions expire after 15 minutes (pendingActions.ts) but keep
    // status "awaiting" until something reads them — never surface an expired one.
    pendingActions: pendingDocs.filter((doc) => {
      const exp = asString(doc.data().expiresAt);
      return !exp || new Date(exp).getTime() > Date.now();
    }).map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        preview: truncate(asString(data.preview)),
        toolName: asString(data.toolName),
        expiresAt: asString(data.expiresAt),
      };
    }),
    openAlerts,
    failedActions: failedByPhoneDocs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        actionType: asString(data.actionType),
        toolName: asString(data.toolName),
        targetDocId: asString(data.targetDocId),
        errorReason: truncate(asString(data.errorReason)),
        updatedAt: asString(data.updatedAt),
      };
    }),
    caregiverState,
    clientState,
  };
}

export function formatCaraOperationalContext(ctx: CaraOperationalContext): string {
  const lines: string[] = [];
  const safe = (value: unknown, max = 160) => sanitizePromptContext(value, max);

  for (const pending of ctx.pendingActions) {
    lines.push(`- Awaiting confirmation: ${safe(pending.preview ?? pending.toolName ?? pending.id)}${pending.expiresAt ? ` (expires ${safe(pending.expiresAt, 80)})` : ""}.`);
  }
  for (const alert of ctx.openAlerts) {
    const detail = safe(alert.message ?? alert.reason ?? "No detail provided", 220);
    lines.push(`- Open admin alert: [${safe(alert.severity ?? "medium", 40)}] ${safe(alert.type ?? alert.id, 80)}: ${detail}.`);
  }
  for (const failed of ctx.failedActions) {
    lines.push(`- Recent failed action: ${safe(failed.actionType ?? "action", 80)}${failed.toolName ? ` via ${safe(failed.toolName, 80)}` : ""}${failed.errorReason ? ` (${safe(failed.errorReason, 220)})` : ""}.`);
  }
  if (ctx.caregiverState) {
    const c = ctx.caregiverState;
    const bits = [
      c.onboardingStatus ? `onboarding=${safe(c.onboardingStatus, 60)}` : undefined,
      c.verificationStatus ? `verification=${safe(c.verificationStatus, 60)}` : undefined,
      c.backgroundCheckStatus ? `checkr=${safe(c.backgroundCheckStatus, 60)}` : undefined,
      c.accountStatus ? `status=${safe(c.accountStatus, 60)}` : undefined,
    ].filter(Boolean).join(", ");
    if (bits) lines.push(`- Caregiver state: ${bits}.`);
    if (c.nextAppointment) lines.push(`- Caregiver upcoming/shift context: ${safe(c.nextAppointment, 180)}.`);
    if (c.pendingShiftHours) lines.push(`- Caregiver shift payment context: ${safe(c.pendingShiftHours, 180)}.`);
    if (c.lastPayoutStatus) lines.push(`- Caregiver last payout: ${safe(c.lastPayoutStatus, 140)}.`);
  }
  if (ctx.clientState) {
    const c = ctx.clientState;
    if (c.nextAppointment) lines.push(`- Client next visit: ${safe(c.nextAppointment, 180)}.`);
    if (c.latestCareUpdate) lines.push(`- Latest care update: ${safe(c.latestCareUpdate, 240)}.`);
    if (c.pendingInvoiceOrPayment) lines.push(`- Pending invoice/payment: ${safe(c.pendingInvoiceOrPayment, 120)}.`);
  }

  if (lines.length === 0) return "";

  // Lines are appended in priority order above — pending confirmations, open
  // admin alerts, and failed actions first, then caregiver/client state — so the
  // cap keeps the highest-severity items. Raised from 8 to 16 so a busy account's
  // critical items aren't silently dropped, while still bounding token cost.
  return [
    "EVIA OPERATIONS CONTEXT:",
    ...lines.slice(0, 16),
    "Use this silently. If the user asks about one of these items, acknowledge the current status accurately. Never claim a pending, failed, or admin-flagged action succeeded.",
  ].join("\n");
}

export function buildOperationalRecipeLead(
  ctx: CaraOperationalContext,
  role: OperationalRecipeLeadRole,
): string | undefined {
  const pending = ctx.pendingActions[0];
  if (pending?.preview || pending?.toolName) {
    return `You've got something waiting on your reply: ${pending.preview ?? pending.toolName}.`;
  }

  const failed = ctx.failedActions[0];
  if (failed) {
    const target = failed.actionType ?? failed.toolName ?? "action";
    return `I can help recover a failed action: ${target}.`;
  }

  const alert = ctx.openAlerts[0];
  if (alert) {
    return `There is an open ${alert.type ?? "care"} alert I can help track.`;
  }

  if (role === "caregiver") {
    if (ctx.caregiverState?.pendingShiftHours) {
      return "I can check the hours or payment status from your latest shift.";
    }
    if (ctx.caregiverState?.lastPayoutStatus) {
      return "I can check your latest payout status.";
    }
    if (ctx.caregiverState?.nextAppointment) {
      return "I can pull up your next shift and what needs to happen.";
    }
  }

  if (role === "client" && ctx.clientState?.pendingInvoiceOrPayment) {
    return "You have a payment or invoice item waiting; I can pull it up.";
  }

  if (ctx.clientState?.nextAppointment) {
    return "Your next visit is on the books; I can pull up who is coming.";
  }
  if (ctx.clientState?.latestCareUpdate) {
    return "I can catch you up on the latest care update.";
  }

  return undefined;
}
