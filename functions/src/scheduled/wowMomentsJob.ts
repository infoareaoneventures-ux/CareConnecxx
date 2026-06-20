import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { pickWowCandidate, type WowContext, type FireRecord } from "../agents/wowMoments";
import { sendViaInteractionAgent } from "../agents/caraAgent";

// Wires the wowMoments registry (delightful proactive messages) into a daily
// scheduled send. The registry was fully built but had ZERO production callers
// — proactive delight is exactly the best-in-class differentiator we want, so
// this turns it on. Ships behind WOW_MOMENTS_ENABLED so it starts dark / small.

const db = admin.firestore();

// FireRecords live in a single doc per user: { [momentName]: firedAtISO }.
export async function loadRecentFires(userId: string): Promise<FireRecord[]> {
  const snap = await db.collection("wow_fires").doc(userId).get();
  if (!snap.exists) return [];
  const data = snap.data() ?? {};
  return Object.entries(data).map(([name, firedAt]) => ({ name, firedAt: String(firedAt) }));
}

export async function recordWowFire(userId: string, name: string, firedAt: string): Promise<void> {
  await db.collection("wow_fires").doc(userId).set({ [name]: firedAt }, { merge: true });
}

// Testable orchestration core. Picks ONE eligible, not-in-cooldown moment and
// sends + records it. Dependency-injected send/record keep it pure of I/O.
export async function maybeSendWowMoment(params: {
  ctx:         WowContext;
  recentFires: FireRecord[];
  send:        (message: string) => Promise<void>;
  record:      (name: string, firedAt: string) => Promise<void>;
}): Promise<string | null> {
  const candidate = pickWowCandidate(params.ctx, params.recentFires);
  if (!candidate) return null;
  await params.send(candidate.message);
  await params.record(candidate.name, params.ctx.now.toISOString());
  return candidate.name;
}

// Assemble a WowContext snapshot for one client from their appointments + session.
export async function buildWowContextForClient(
  userId:  string,
  session: Record<string, unknown>,
  now:     Date,
): Promise<WowContext> {
  const apptSnap = await db.collection("appointments").where("clientId", "==", userId).get().catch(() => null);
  const appts = apptSnap ? apptSnap.docs.map((d) => d.data()) : [];
  const completed = appts.filter((a) => a.status === "completed");
  const completedSorted = [...completed].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  const firstDate = completedSorted[0]?.date;
  const onboardingData = (session.onboardingData ?? {}) as Record<string, unknown>;
  // These come from untyped Firestore docs — only treat them as the strings the
  // WowContext expects when they actually are strings; otherwise leave undefined
  // so a non-string value can't silently flow through as a bogus name/date.
  const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  return {
    clientName:         asString(onboardingData.name),
    seniorName:         asString(session.seniorName) ?? asString(onboardingData.seniorName),
    clientJoinedAt:     asString(session.createdAt),
    firstVisitAt:       firstDate ? new Date(String(firstDate)).toISOString() : undefined,
    completedVisits:    completed.length,
    recentEvents:       appts
      .filter((a) => a.status === "confirmed" || a.status === "completed")
      .map((a) => ({
        type:      a.status === "completed" ? "visit_completed" as const : "booking_confirmed" as const,
        timestamp: String(a.confirmedAt ?? a.date ?? now.toISOString()),
      }))
      .slice(-20),
    recentCaregiverIds: [...completedSorted].reverse().map((a) => a.caregiverId).filter(Boolean).slice(0, 5) as string[],
    now,
  };
}

// Daily at 10am PT (17:00 UTC) — a friendly hour; canDrop + the send path's DND
// guard keep it inside quiet hours per family.
export const wowMomentsDaily = functions.pubsub
  .schedule("0 17 * * *")
  .onRun(async () => {
    if (process.env.WOW_MOMENTS_ENABLED !== "true") {
      console.log("wowMomentsDaily: disabled — set WOW_MOMENTS_ENABLED=true to enable");
      return;
    }
    const now = new Date();
    const snap = await db.collection("agent_sessions")
      .where("onboardingStep", "==", "complete")
      .where("optedOut", "==", false)
      .get();

    let sent = 0;
    for (const doc of snap.docs) {
      const session = doc.data();
      if (session.userType && session.userType !== "client") continue;
      const userId = (session.userId ?? doc.id) as string;
      const phone = doc.id;
      try {
        const ctx = await buildWowContextForClient(userId, session, now);
        const recentFires = await loadRecentFires(userId);
        const fired = await maybeSendWowMoment({
          ctx,
          recentFires,
          send: (message) => sendViaInteractionAgent(phone, {
            content: message, urgency: "low", sourceAgent: "wow_moment", canDrop: true,
          }),
          record: (name, firedAt) => recordWowFire(userId, name, firedAt),
        });
        if (fired) sent++;
      } catch (err) {
        console.error("wowMomentsDaily: error for", userId, err);
      }
    }
    console.log(`wowMomentsDaily: sent ${sent} delight message(s)`);
  });
