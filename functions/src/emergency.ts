// One family-emergency path for both doors (2026-09-23): the website's red
// Emergency button (v1-triggerFamilyEmergency, components/client/FamilyEmergency.tsx)
// and Evia's trigger_emergency_alert tool call THIS. It writes the
// emergency_alerts doc the site's EmergencyAlertBanner reads, texts the
// caregiver on the current visit, and pages the team. The old button read the
// retired `appointments` collection and could not find a real visit.
import * as admin from "firebase-admin";

const db = admin.firestore();

export interface RaiseFamilyEmergencyInput {
  clientId: string;
  /** The visit in question (shifts/{id}); when absent, today's in-progress/scheduled visit is used. */
  shiftId?: string | null;
  note?: string | null;
  location?: { lat: number; lng: number } | null;
  source: "site" | "cara";
}

export interface RaiseFamilyEmergencyResult {
  alertId: string;
  status: "active";
  deduped: boolean;
  caregiverNotified: boolean;
}

const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

async function findVisit(clientId: string, shiftId?: string | null): Promise<{ id: string; data: Record<string, unknown> } | null> {
  if (shiftId) {
    const snap = await db.collection("shifts").doc(shiftId).get();
    const data = snap.data();
    if (snap.exists && data && data.clientId === clientId) return { id: snap.id, data };
  }
  // Single-equality query (no composite index on the emergency path); the
  // family's shift list is small. In-progress first, then a visit today.
  const q = await db.collection("shifts").where("clientId", "==", clientId).limit(200).get();
  const today = new Date().toISOString().slice(0, 10);
  const docs = q.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  return docs.find((d) => d.data.status === "in-progress")
    ?? docs.find((d) => d.data.status === "scheduled" && d.data.date === today)
    ?? null;
}

export async function raiseFamilyEmergency(input: RaiseFamilyEmergencyInput): Promise<RaiseFamilyEmergencyResult> {
  const nowIso = new Date().toISOString();

  // A retry / double tap must not page the team twice for one emergency.
  const recent = await db.collection("emergency_alerts").where("initiatorId", "==", input.clientId).limit(50).get();
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  const active = recent.docs.find((d) => {
    const a = d.data();
    const ts = Date.parse(String(a.timestamp ?? ""));
    return a.status === "active" && !Number.isNaN(ts) && ts >= cutoff;
  });
  if (active) return { alertId: active.id, status: "active", deduped: true, caregiverNotified: Array.isArray(active.data().notifiedContacts) && active.data().notifiedContacts.length > 0 };

  const visit = await findVisit(input.clientId, input.shiftId);
  const caregiverId = (visit?.data.caregiverId as string | undefined) ?? null;

  // The doc the site's EmergencyAlertBanner listens to (initiatorId + status).
  const alertRef = await db.collection("emergency_alerts").add({
    initiatorId:      input.clientId,
    initiatorType:    "client",
    timestamp:        nowIso,
    status:           "active",
    notifiedContacts: [],
    source:           input.source,
    ...(visit ? { shiftId: visit.id } : {}),
    ...(caregiverId ? { caregiverId } : {}),
    ...(input.note ? { note: String(input.note).slice(0, 500) } : {}),
    ...(input.location ? { location: input.location } : {}),
  });

  // Text the caregiver on the visit (life-critical — SMS, never dropped). The
  // alert doc + admin page above are the guaranteed parts; this is best-effort.
  let caregiverNotified = false;
  if (caregiverId) {
    try {
      const { resolveCaregiverPhone } = await import("./utils/caregiverPhone");
      const { sendViaInteractionAgent } = await import("./agents/caraAgent");
      const phone = await resolveCaregiverPhone(caregiverId);
      if (phone) {
        const clientName = (visit?.data.clientName as string | undefined) || "The family";
        const who = (visit?.data.careRecipients as Array<{ name?: string }> | undefined)?.[0]?.name || "your client";
        caregiverNotified = await sendViaInteractionAgent(phone, {
          content: `🚨 EMERGENCY: ${clientName} needs immediate help. Please check on ${who} right away and call 911 if needed.`,
          urgency: "immediate",
          sourceAgent: "family_emergency",
          canDrop: false,
          preferredService: "SMS",
        });
        if (caregiverNotified) await alertRef.update({ notifiedContacts: [caregiverId] }).catch(() => {});
      }
    } catch (err) {
      console.error("raiseFamilyEmergency: caregiver text failed", err instanceof Error ? err.message : err);
    }
  }

  await db.collection("admin_alerts").add({
    type:        "family_emergency",
    severity:    "critical",
    title:       "🚨 Family emergency alert",
    clientId:    input.clientId,
    alertId:     alertRef.id,
    shiftId:     visit?.id ?? null,
    caregiverId,
    caregiverNotified,
    note:        input.note ?? "",
    source:      input.source,
    createdAt:   nowIso,
    resolved:    false,
  }).catch((err) => console.error("raiseFamilyEmergency: admin alert failed", err));

  return { alertId: alertRef.id, status: "active", deduped: false, caregiverNotified };
}
