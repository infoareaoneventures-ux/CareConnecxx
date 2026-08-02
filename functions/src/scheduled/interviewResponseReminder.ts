import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendMessage, getOrCreateSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { toMillis } from "./pendingTimesheetNudge";

const db = admin.firestore();

// interviewAgent texts the caregiver once at creation and the request expires at
// 24h. Give them time to reply naturally, then send ONE reminder before it
// lapses so a missed first text doesn't silently lose the match.
export const MIN_AGE_MS = 10 * 60 * 60 * 1000;

// Statuses where the caregiver still owes a response (availability or accept/decline).
const AWAITING_CAREGIVER = ["awaiting_caregiver_availability", "awaiting_caregiver_response"];

/**
 * Pure decision: should this interview request get its one pre-expiry reminder?
 * Extracted so the timing/expiry guard is unit-tested without Firestore.
 */
export function shouldRemindInterview(p: {
  createdMs:       number | null;
  expiresMs:       number | null;
  alreadyReminded: boolean;
  nowMs:           number;
}): boolean {
  if (p.alreadyReminded) return false;                                  // one reminder only
  if (p.createdMs === null) return false;
  if (p.nowMs - p.createdMs < MIN_AGE_MS) return false;                 // give them time to reply first
  if (p.expiresMs !== null && p.nowMs >= p.expiresMs) return false;     // too late — expiry job owns it
  return true;
}

/**
 * Interview-response reminder. A caregiver who misses the initial interview
 * outreach currently just lapses at the 24h expiry — a lost match for both
 * sides. This sends one gentle nudge in between. Does NOT change interview state
 * (no accept/decline) — it only re-prompts and stamps a one-shot marker, so it
 * never double-sends and never races the expiry/booking flow.
 */
export const sendInterviewResponseReminders = functions.pubsub
  .schedule("0 */6 * * *") // every 6h — fits inside the 24h interview window
  .onRun(async () => {
    const nowMs = Date.now();

    const snap = await db.collection("interview_requests")
      .where("status", "in", AWAITING_CAREGIVER)
      .limit(300)
      .get();

    const remindedCaregivers = new Set<string>();

    for (const reqDoc of snap.docs) {
      const req = reqDoc.data();
      try {
        // Childcare U6 (plan 2026-07-22-002): SENIOR-ONLY EXPLICIT SKIP —
        // this reminder interpolates seniorName/relationship into SMS copy.
        // Childcare interviews live in video_interviews (vertical-stamped,
        // generic content); any childcare-stamped interview_requests row is
        // skipped, never processed by accident.
        if (req.careVertical === "child") continue;
        const caregiverId = req.caregiverId as string | undefined;
        if (!caregiverId || remindedCaregivers.has(caregiverId)) continue;

        if (!shouldRemindInterview({
          createdMs:       toMillis(req.createdAt),
          expiresMs:       toMillis(req.expiresAt),
          alreadyReminded: !!req.caregiverRemindedAt,
          nowMs,
        })) continue;

        const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
        const cgPhone = cgSnap.data()?.phone as string | undefined;
        if (!cgPhone) continue;

        // Respect opt-out before reaching out.
        const sessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
        if (sessionSnap.exists && sessionSnap.data()?.optedOut) continue;

        const firstName    = ((req.caregiverName ?? cgSnap.data()?.name ?? "there") as string).split(" ")[0] || "there";
        const seniorName   = (req.seniorName as string) ?? "a family";
        const relationship = (req.relationship as string) ?? "";
        const relPart      = relationship ? ` for their ${relationship}` : "";

        const session = await getOrCreateSession(cgPhone, { caregiverId });

        const message = await generateCaraMessage({
          audience: "caregiver",
          context:
            `Gently remind ${firstName} that a family is still hoping to meet them for a care position${relPart} (${seniorName}). ` +
            `It's been a little while since the first message. Ask if they're available for a short video call this week — reply with 2–3 times, or PASS to decline. Warm, brief, no pressure.`,
          fallback:
            `Hi ${firstName} — just circling back. A family is still hoping to meet you${relPart ? relPart : ""} (${seniorName}). ` +
            `Are you free for a quick video call this week? Reply with 2–3 times, or PASS.`,
        });

        await sendMessage(session.chatId, message);
        await reqDoc.ref.update({ caregiverRemindedAt: new Date().toISOString() }).catch(() => {});
        remindedCaregivers.add(caregiverId);
      } catch (err) {
        console.error(`[sendInterviewResponseReminders] error for request ${reqDoc.id}:`, err);
      }
    }
  });
