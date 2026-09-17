import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { describeWhoIsWho } from "../agents/careRecipients";
import { toMillis } from "./pendingTimesheetNudge";
import { gateOptionalSend } from "./engineGate";

const db = admin.firestore();

// Give a new family a few days to book on their own before nudging.
export const MIN_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Don't suddenly cold-nudge long-dormant never-booked accounts (e.g. on first
// deploy) — only families still in the activation window.
export const MAX_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Pure decision: should this family get the one-time "book your first visit"
 * activation nudge? Extracted so the cohort logic is unit-tested without
 * Firestore. One-shot — `alreadyNudged` permanently retires a family from this.
 */
export function shouldNudgeFirstVisit(p: {
  onboardingComplete: boolean;
  hasBooked:          boolean;
  alreadyNudged:      boolean;
  accountAgeMs:       number | null;
}): boolean {
  if (!p.onboardingComplete) return false;
  if (p.hasBooked) return false;                       // they've booked — not an activation case
  if (p.alreadyNudged) return false;                   // one nudge only
  if (p.accountAgeMs === null) return false;
  if (p.accountAgeMs < MIN_ACCOUNT_AGE_MS) return false; // give them time first
  if (p.accountAgeMs > MAX_ACCOUNT_AGE_MS) return false;  // past the activation window
  return true;
}

/**
 * First-visit activation. noVisitCheck re-engages families who lapse on an
 * ACTIVE recurring schedule; onboardingReengagement chases INCOMPLETE onboarding.
 * Neither catches the family who finished onboarding (paying) but never booked a
 * first visit — the clearest activation/churn gap. This sends one warm offer to
 * help get that first visit on the calendar.
 *
 * Read-only except the send + a one-shot marker. The global daily cap + opt-out
 * apply at the send path. Broader cohort scan than the actionable-item nudges
 * (it walks client sessions), so it's bounded by limit + in-memory pre-filters
 * before the per-client appointments read.
 */
export const sendFirstVisitActivation = functions.pubsub
  .schedule("0 15 * * *") // once daily, mid-afternoon UTC; DND/cap handled at send path
  .onRun(async () => {
    const nowMs = Date.now();

    const snap = await db.collection("agent_sessions")
      .where("userType", "==", "client")
      .limit(1000)
      .get();
    if (snap.size === 1000) {
      console.warn("[firstVisitActivation] hit the 1000-session scan cap — some families may be skipped this run");
    }

    for (const sessionDoc of snap.docs) {
      const s = sessionDoc.data();
      try {
        // Cheap in-memory gates first, before the per-client appointments read.
        if (s.optedOut) continue;
        if (s.onboardingStep !== "complete") continue;
        if (s.firstVisitNudgedAt) continue;

        const createdMs    = toMillis(s.createdAt);
        const accountAgeMs = createdMs === null ? null : nowMs - createdMs;
        if (accountAgeMs === null || accountAgeMs < MIN_ACCOUNT_AGE_MS || accountAgeMs > MAX_ACCOUNT_AGE_MS) continue;

        const clientId = (s.userId ?? "") as string;
        if (!clientId) continue;

        // "Ever booked anything" — no status filter (even a cancelled visit
        // means they've engaged with booking before), so this checks
        // existence directly rather than going through queryVisits
        // (which requires a status list).
        const [apptSnap, shiftSnap] = await Promise.all([
          db.collection("appointments").where("clientId", "==", clientId).limit(1).get(),
          db.collection("shifts").where("clientId", "==", clientId).limit(1).get(),
        ]);
        const hasBooked = !apptSnap.empty || !shiftSnap.empty;

        if (!shouldNudgeFirstVisit({
          onboardingComplete: true,
          hasBooked,
          alreadyNudged:      false,
          accountAgeMs,
        })) continue;

        const phone      = (s.phone ?? sessionDoc.id) as string;

        // U8 engine gate (KTD15): optional activation nudge — submit as a
        // PolicyCandidate instead of sending directly. A lost pass re-enters on
        // the next daily run (firstVisitNudgedAt is only stamped after a send).
        const day = new Date(nowMs).toISOString().slice(0, 10);
        const g = await gateOptionalSend({
          phone,
          candidate: {
            source: "firstVisitActivation",
            category: "re_engagement",
            urgency: 2,
            evidenceCount: 1,
            dedupeKey: `fva:${clientId}:${day}`,
          },
        });
        if (!g.allowed) {
          console.info("firstVisitActivation.policy", { userId: clientId, disposition: g.disposition, reason: g.reason });
          continue;
        }

        const seniorName = (s.seniorName ?? s.onboardingData?.seniorName ?? "your loved one") as string;
        // R11 (hallucination hardening 2026-07-17): the reader is the ACCOUNT
        // HOLDER; the visit is for the care recipient — ground who's who so the
        // model never writes "book <account holder>'s first visit".
        const whoIsWho = describeWhoIsWho({
          ...((s.onboardingData ?? {}) as Record<string, unknown>),
          seniorName: s.onboardingData?.seniorName ?? s.seniorName,
        });

        const message = await generateCaraMessage({
          audience: "family",
          context:
            (whoIsWho ? whoIsWho + " " : "") +
            `The family finished signing up a few days ago but hasn't booked a first visit for ${seniorName} yet. ` +
            `Warmly offer to find a caregiver and get a first visit on the calendar. One or two inviting sentences, no pressure or guilt.`,
          fallback:
            `You're all set up! Want me to find a caregiver and get a first visit on the calendar for ${seniorName}? Just tell me what you need.`,
          maxTokens: 90,
        });

        await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "first_visit_activation",
          canDrop:     true,
        });

        await sessionDoc.ref.update({ firstVisitNudgedAt: new Date().toISOString() }).catch(() => {});
      } catch (err) {
        console.error(`[firstVisitActivation] error for ${sessionDoc.id}:`, err);
      }
    }
  });
