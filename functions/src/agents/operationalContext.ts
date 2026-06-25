import * as admin from "firebase-admin";

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
  familyGroupStatus?: string;
  pendingInvoiceOrPayment?: string;
}

export interface CaraOperationalContext {
  pendingActions: PendingActionContext[];
  openAlerts: AlertContext[];
  failedActions: FailedActionContext[];
  caregiverState?: CaregiverStateContext;
  clientState?: ClientStateContext;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
}): Promise<CaraOperationalContext> {
  const { phone, userId } = params;

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
    familyGroupDocs,
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
    userId ? safeDoc(db.collection("caregivers").doc(userId).get()) : Promise.resolve(null),
    userId
      ? safeDocs(db.collection("shiftHours")
        .where("caregiverId", "==", userId)
        .orderBy("submittedAt", "desc")
        .limit(3)
        .get())
      : Promise.resolve([]),
    userId
      ? safeDocs(db.collection("caregivers")
        .doc(userId)
        .collection("payouts")
        .orderBy("createdAt", "desc")
        .limit(2)
        .get())
      : Promise.resolve([]),
    userId
      ? safeDocs(db.collection("appointments")
        .where("clientId", "==", userId)
        .orderBy("date", "desc")
        .limit(3)
        .get())
      : Promise.resolve([]),
    userId
      ? safeDocs(db.collection("care_journal")
        .where("clientId", "==", userId)
        .orderBy("timestamp", "desc")
        .limit(2)
        .get())
      : Promise.resolve([]),
    phone
      ? safeDocs(db.collection("family_groups")
        .where("phones", "array-contains", phone)
        .limit(1)
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
    .find((shift) => ["pending_client_review", "approved", "payment_failed", "disputed"].includes(String(shift.status ?? "")));
  const lastPayout = caregiverPayoutDocs[0]?.data();

  const nextClientAppointment = clientAppointmentDocs
    .map((doc): Record<string, unknown> & { id: string } => ({ id: doc.id, ...doc.data() as Record<string, unknown> }))
    .find((appt) => ["confirmed", "pending", "pending_caregiver_confirmation", "in-progress"].includes(String(appt.status ?? "")));
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
    familyGroupStatus: familyGroupDocs.length
      ? `family group active with ${Array.isArray(familyGroupDocs[0].data().phones) ? familyGroupDocs[0].data().phones.length : "some"} phone(s)`
      : undefined,
    pendingInvoiceOrPayment: pendingInvoice
      ? `${String(pendingInvoice.id)} ${String(pendingInvoice.status ?? "unknown")}`
      : undefined,
  } : undefined;

  return {
    pendingActions: pendingDocs.map((doc) => {
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

  for (const pending of ctx.pendingActions) {
    lines.push(`- Awaiting confirmation: ${pending.preview ?? pending.toolName ?? pending.id}${pending.expiresAt ? ` (expires ${pending.expiresAt})` : ""}.`);
  }
  for (const alert of ctx.openAlerts) {
    const detail = alert.message ?? alert.reason ?? "No detail provided";
    lines.push(`- Open admin alert: [${alert.severity ?? "medium"}] ${alert.type ?? alert.id}: ${detail}.`);
  }
  for (const failed of ctx.failedActions) {
    lines.push(`- Recent failed action: ${failed.actionType ?? "action"}${failed.toolName ? ` via ${failed.toolName}` : ""}${failed.errorReason ? ` (${failed.errorReason})` : ""}.`);
  }
  if (ctx.caregiverState) {
    const c = ctx.caregiverState;
    const bits = [
      c.onboardingStatus ? `onboarding=${c.onboardingStatus}` : undefined,
      c.verificationStatus ? `verification=${c.verificationStatus}` : undefined,
      c.backgroundCheckStatus ? `checkr=${c.backgroundCheckStatus}` : undefined,
      c.accountStatus ? `status=${c.accountStatus}` : undefined,
    ].filter(Boolean).join(", ");
    if (bits) lines.push(`- Caregiver state: ${bits}.`);
    if (c.nextAppointment) lines.push(`- Caregiver upcoming/shift context: ${c.nextAppointment}.`);
    if (c.pendingShiftHours) lines.push(`- Caregiver shift payment context: ${c.pendingShiftHours}.`);
    if (c.lastPayoutStatus) lines.push(`- Caregiver last payout: ${c.lastPayoutStatus}.`);
  }
  if (ctx.clientState) {
    const c = ctx.clientState;
    if (c.nextAppointment) lines.push(`- Client next visit: ${c.nextAppointment}.`);
    if (c.latestCareUpdate) lines.push(`- Latest care update: ${c.latestCareUpdate}.`);
    if (c.familyGroupStatus) lines.push(`- Family group: ${c.familyGroupStatus}.`);
    if (c.pendingInvoiceOrPayment) lines.push(`- Pending invoice/payment: ${c.pendingInvoiceOrPayment}.`);
  }

  if (lines.length === 0) return "";

  // Lines are appended in priority order above — pending confirmations, open
  // admin alerts, and failed actions first, then caregiver/client state — so the
  // cap keeps the highest-severity items. Raised from 8 to 16 so a busy account's
  // critical items aren't silently dropped, while still bounding token cost.
  return [
    "CARA OPERATIONS CONTEXT:",
    ...lines.slice(0, 16),
    "Use this silently. If the user asks about one of these items, acknowledge the current status accurately. Never claim a pending, failed, or admin-flagged action succeeded.",
  ].join("\n");
}
