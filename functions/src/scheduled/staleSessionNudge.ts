import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { caregiverAnnualDisplay, clientMonthlyDisplay } from "../config/pricing";
import { AgentSession } from "../linq/client";
import { gateOptionalSend } from "./engineGate";
import { writeUserNotification } from "../notifications/userNotification";
import { humanLabelForStep } from "./onboardingStepLabels";
import { decideNudge, MAX_NUDGES } from "./onboardingNudgeCadence";
import {
  CAREGIVER_COLLECTION_STEPS, CLIENT_COLLECTION_STEPS, EXPERIENCE_BUCKETS,
  RATE_EXAMPLE, TRAVEL_RADIUS_OPTIONS, availabilityComplete, isFieldFilled, missingRequiredFields,
} from "../agents/onboardingContract";
import { SERVICE_LABELS } from "../agents/caregiverServiceLabels";

// The ONE onboarding reminder (caregiver sweep A8, founder 2026-10-11 — the
// 48h stale nudge, the 7-day stuck-gate resend and the daily re-engagement
// job were three overlapping schedules with model-written copy; "one per day
// is too much"). Now:
//   • cadence (onboardingNudgeCadence.ts): three texts per silence — about 2,
//     5 and 12 days after the person's last message — never two in one day,
//     nothing after 14 days of silence; a reply restarts the series.
//   • a nudge exists only because text has no open tab: it names the step the
//     person stopped at (the same label the website bell shows) and, for a
//     reply step, re-asks that step's question in fixed words; for a gate step
//     (membership checkout, background-check consent page, photo upload,
//     payout setup — and the family's payment / identity links) it carries the
//     link again through the same resend path the LINK keyword uses.
//   • never to a caregiver who finished the step on the website
//     (reconcileCaregiverOnboardingWithSite moves the cursor first), never to a
//     family whose website progress is already real (self-heals the session).
//   • the website bell gets the same reminder only when the text actually went.

const db = admin.firestore();

// Link-gate steps: the nudge re-delivers the link (resendStuckStep) instead of
// asking for a reply. caregiver_send_* / client_send_* are the same gates
// before their first delivery.
const LINK_GATE_STEPS: ReadonlySet<string> = new Set([
  "caregiver_send_membership", "caregiver_awaiting_membership",
  "caregiver_send_bgcheck", "caregiver_awaiting_bgcheck_consent", "caregiver_awaiting_bgcheck",
  "caregiver_send_stripe_connect", "caregiver_awaiting_stripe",
  "client_send_payment", "client_awaiting_payment", "client_awaiting_identity",
]);

/** The fixed fact line for a link gate — the link itself follows with its own intro. */
function gateLine(step: string): string {
  switch (step) {
    case "caregiver_send_membership":
    case "caregiver_awaiting_membership":
      return `Your ${caregiverAnnualDisplay()} membership includes your background check and unlocks applying to jobs.`;
    case "caregiver_send_bgcheck":
    case "caregiver_awaiting_bgcheck_consent":
      return "It's included in your membership and takes about a minute to authorize — Checkr then emails you a secure link to finish.";
    case "caregiver_awaiting_bgcheck":
      return "Checkr emailed you a secure link to finish (about 5 minutes). Families can't book you until it's complete.";
    case "caregiver_send_stripe_connect":
    case "caregiver_awaiting_stripe":
      return "It's how you get paid for your visits.";
    case "client_send_payment":
    case "client_awaiting_payment":
      return `Your ${clientMonthlyDisplay()} membership is what lets you message, interview and book care providers.`;
    case "client_awaiting_identity":
      return "It's a 30-second step that keeps every family on the platform safe.";
    default:
      return "";
  }
}

// The wizard's questions, field by field, in fixed words (= the site's
// CaregiverOnboardingWizard steps / the family's ClientJobPostingWizard).
const CAREGIVER_FIELD_QUESTIONS: Record<string, string> = {
  name:           "What's your first and last name?",
  street:         "What's your street address and ZIP code?",
  zipCode:        "What's your street address and ZIP code?",
  city:           "What's your street address and ZIP code?",
  state:          "What's your street address and ZIP code?",
  jobType:        "What kind of work are you looking for — occasional shifts, part-time, or full-time?",
  availability:   "Which days of the week and times of day (morning, afternoon, evening, overnight) are you available?",
  specialties:    `Which care services do you offer? ${SERVICE_LABELS.join(", ")}.`,
  yearsExperience: `How many years of care experience do you have? (${EXPERIENCE_BUCKETS.join(", ")})`,
  hourlyRate:     `What's your hourly rate? For example $${RATE_EXAMPLE}.`,
  serviceRadius:  `How far are you willing to travel for work? (${TRAVEL_RADIUS_OPTIONS.join(", ")} miles)`,
  email:          "What's your email address?",
  bio:            "Tell families a bit about yourself — a few lines about your experience and how you care for people.",
};
const CLIENT_FIELD_QUESTIONS: Record<string, string> = {
  careFrequency:        "How often do you need care — occasional, part-time, or full-time?",
  homeStreet:           "What's your home street address and ZIP code?",
  homeZipCode:          "What's your home street address and ZIP code?",
  sameAsHomeAddress:    "Will the care take place at your home address?",
  city:                 "What's the ZIP code where care will take place?",
  zipCode:              "What's the ZIP code where care will take place?",
  startDate:            "When would you like care to start, and which days of the week?",
  selectedDays:         "When would you like care to start, and which days of the week?",
  relationship:         "What's your relationship to the person needing care, and their name? (Or just say it's for you)",
  seniorName:           "What's your relationship to the person needing care, and their name? (Or just say it's for you)",
  emergencyContactName: "Who should we list as the emergency contact? (Name and phone number)",
  emergencyContactPhone: "Who should we list as the emergency contact? (Name and phone number)",
  careNeeds:            "What kind of help do they need day to day?",
  rate:                 "What hourly rate are you planning to pay?",
  email:                "What's your email address?",
  firstName:            "What's your first name?",
};
// The scripted family steps after collection (onboardingConversation.ts), same words.
const CLIENT_STEP_QUESTIONS: Record<string, string> = {
  client_confirm_intake: "Does that all look right? Say yes and I'll show you who can help, or tell me what to fix.",
  client_ask_needs:      "What kind of help does your loved one need day to day?",
  client_ask_schedule:   "How often do they need someone, and what times of day work best?",
  client_ask_senior:     "Who are you looking for care for? (Their name and your relationship — or just say it's for you)",
  client_ask_name:       "What's your first and last name?",
};

/** Does the caregiver's own record already hold this wizard field (filled on the website)? */
function caregiverRecordHas(cg: Record<string, unknown> | undefined, field: string): boolean {
  if (!cg) return false;
  switch (field) {
    case "profilePhoto": return isFieldFilled(cg.photo) || isFieldFilled(cg.profilePhoto) || isFieldFilled(cg.photoURL)
      || isFieldFilled((cg.documents as Record<string, unknown> | undefined)?.profilePhoto);
    case "specialties":  return isFieldFilled(cg.skills) || isFieldFilled(cg.services) || isFieldFilled(cg.primaryServices);
    case "yearsExperience": return isFieldFilled(cg.yearsExperience) || isFieldFilled(cg.experience);
    case "jobType":      return isFieldFilled(cg.jobType) || isFieldFilled(cg.jobTypes);
    case "availability": {
      const grid = cg.weeklyAvailability as Record<string, unknown> | undefined;
      return (!!grid && typeof grid === "object" && Object.keys(grid).length > 0) || availabilityComplete(cg.availability);
    }
    default: return isFieldFilled(cg[field]);
  }
}

interface NudgePlan {
  text: string;
  /** "resend" = resendStuckStep (the LINK keyword's path); "photo" = the tokened upload link. */
  link?: "resend" | "photo";
}

/** Compose the fixed nudge for where the person stopped. */
async function planNudge(session: Record<string, unknown>, nudgeNumber: number): Promise<NudgePlan> {
  const step      = (session.onboardingStep as string | undefined) ?? "ask_role";
  const data      = (session.onboardingData ?? {}) as Record<string, unknown>;
  const firstName = String(data.firstName ?? data.name ?? "").trim().split(/\s+/)[0] ?? "";
  const greeting  = firstName ? `Hey ${firstName}!` : "Hey there!";
  const userType  = session.userType as string | undefined;
  const last      = nudgeNumber >= MAX_NUDGES ? " This is my last reminder. Text me whenever you're ready and we'll pick up right here." : "";

  if (!userType || step === "ask_role" || step === "verify_phone") {
    const namePart = firstName ? ` ${firstName}` : "";
    return { text: `Hi${namePart}, still thinking about care? Whenever you're ready, just tell me — are you looking for care for someone, or are you a care provider yourself?${last}` };
  }

  const label = humanLabelForStep(step);
  if (LINK_GATE_STEPS.has(step)) {
    return { text: `${greeting} You stopped at ${label}. ${gateLine(step)}${last} Here's your link again:`, link: "resend" };
  }

  if (userType === "caregiver") {
    if (CAREGIVER_COLLECTION_STEPS.includes(step)) {
      const uid = (session.caregiverId ?? session.userId) as string | undefined;
      let cg: Record<string, unknown> | undefined;
      if (uid) cg = (await db.collection("caregivers").doc(uid).get().catch(() => null))?.data() as Record<string, unknown> | undefined;
      const missing = missingRequiredFields("caregiver", data).filter((f) => !caregiverRecordHas(cg, f));
      const field = missing[0];
      if (field === "profilePhoto") {
        return { text: `${greeting} Your care provider profile stopped at your profile photo — families see it first.${last} Here's your upload link again:`, link: "photo" };
      }
      const q = field ? CAREGIVER_FIELD_QUESTIONS[field] : undefined;
      if (q) return { text: `${greeting} Your care provider profile stopped at ${label}. ${q}${last}` };
    }
    return { text: `${greeting} Your care provider profile stopped at ${label}. Just text me back and I'll pick up right there.${last}` };
  }

  // family
  if (CLIENT_COLLECTION_STEPS.includes(step)) {
    const field = missingRequiredFields("client", data)[0];
    const q = field ? CLIENT_FIELD_QUESTIONS[field] : undefined;
    if (q) return { text: `${greeting} You stopped at ${label}. ${q}${last}` };
  }
  const stepQ = CLIENT_STEP_QUESTIONS[step];
  if (stepQ) return { text: `${greeting} You stopped at ${label}. ${stepQ}${last}` };
  return { text: `${greeting} You stopped at ${label}. Just text me back and I'll pick up right there.${last}` };
}

// The same reminder in the website's notification bell (founder, 2026-09-26:
// "add it to the notification bell" — both doors see the same thing at the
// same moment), written only when the text actually went. Idempotent per
// session per day; a session with no account yet has no bell to write.
async function writeReminderBell(phone: string, session: Record<string, unknown>): Promise<void> {
  const uid = (session.caregiverId ?? session.userId) as string | undefined;
  if (!uid) return;
  const step = (session.onboardingStep as string | undefined) ?? "";
  await writeUserNotification({
    sourcePath:     `agent_sessions/${phone}`,
    eventId:        `stale_nudge:${new Date().toISOString().slice(0, 10)}`,
    recipientId:    uid,
    transitionType: "stale_nudge",
    type:           "onboarding_reminder",
    title:          session.userType === "caregiver" ? "Finish your care provider setup" : "Finish setting up care",
    body:           `You stopped at ${humanLabelForStep(step)} — pick up on your dashboard whenever you're ready.`,
    data:           { step },
  }).catch((err) => console.error(`[staleSessionNudge] bell write failed (non-fatal) for …${phone.slice(-4)}:`, err));
}

// Runs daily at 10 AM PT (17:00 UTC)
export const sendStaleSessionNudges = functions.pubsub
  .schedule("0 17 * * *")
  .onRun(async () => {
    const now = Date.now();
    const snap = await db.collection("agent_sessions")
      .where("onboardingStep", "!=", "complete")
      .get();

    for (const doc of snap.docs) {
      let session = doc.data() as Record<string, unknown>;
      if (session.optedOut || !session.chatId) continue;

      const decision = decideNudge(session, now);
      if (decision.due === 0) continue;

      try {
        // Live check before any text: the website may have finished the step.
        if (session.userType === "caregiver") {
          const { reconcileCaregiverOnboardingWithSite } = await import("../agents/caregiverSiteSync");
          session = (await reconcileCaregiverOnboardingWithSite(doc.id, session as unknown as AgentSession)) as unknown as Record<string, unknown>;
          if (session.onboardingStep === "complete") continue;
        } else if (session.userId) {
          // A family who finished on the website keeps a stale cursor here
          // forever (2026-08-30) — self-heal so the session stops surfacing.
          const userSnap = await db.collection("users").doc(session.userId as string).get();
          if (userSnap.exists) {
            const { userHasRealOnboardingProgress } = await import("../linq/webhooks");
            if (await userHasRealOnboardingProgress(session.userId as string, userSnap.data()!)) {
              await doc.ref.update({ onboardingStep: "complete" });
              continue;
            }
          }
        }

        // U8 engine gate (KTD15): an OPTIONAL discretionary send — a lost pass
        // re-enters on the next daily run (the cadence is "on or after" a day).
        const g = await gateOptionalSend({
          phone: doc.id,
          candidate: {
            source: "staleSessionNudge",
            category: "re_engagement",
            urgency: 1,
            evidenceCount: 1,
            dedupeKey: `stale:${doc.id}:${new Date(now).toISOString().slice(0, 10)}`,
          },
        });
        if (!g.allowed) {
          console.info("staleSessionNudge.policy", { phone: doc.id, disposition: g.disposition, reason: g.reason });
          continue;
        }

        const plan = await planNudge(session, decision.due);
        const step = (session.onboardingStep as string | undefined) ?? "";

        const textWent = await sendViaInteractionAgent(doc.id, {
          content:     plan.text,
          urgency:     "low",
          sourceAgent: "stale_nudge",
          canDrop:     false,
        });

        let linkWent = false;
        if (plan.link === "resend") {
          const { resendStuckStep } = await import("../agents/onboardingConversation");
          linkWent = await resendStuckStep(doc.id);
          if (linkWent) {
            // The re-delivered link opens the SAME per-step resend cooldown the
            // inbound `other` path uses — otherwise a nudge followed by an
            // immediate "hm ok" reply delivers two link cards within a minute.
            const { isGateLinkKeywordStep, stampGateLinkResent } = await import("../agents/gateLinkCooldown");
            if (isGateLinkKeywordStep(step)) await stampGateLinkResent(doc.id, step);
          }
        } else if (plan.link === "photo") {
          const { sendOnboardingLink } = await import("../agents/onboardingConversation");
          linkWent = (await sendOnboardingLink(doc.id, "caregiver_photo")).success;
        }

        if (!textWent && !linkWent) {
          console.info("staleSessionNudge.notSent", { phone: doc.id, step, nudge: decision.due });
          continue; // nothing reached them — no bell, no count; the cadence retries tomorrow
        }

        await writeReminderBell(doc.id, session);
        await doc.ref.update({
          nudgeSentAt:   new Date(now).toISOString(),
          nudgeCount:    decision.countSoFar + 1,
          nudgeAnchorAt: decision.anchorAt,
        });
        console.log(`[staleSessionNudge] nudge ${decision.due}/${MAX_NUDGES} for …${doc.id.slice(-4)} (step: ${step}, link: ${plan.link ?? "none"})`);
      } catch (err) {
        console.error("staleSessionNudge error for", doc.id, err);
      }
    }
  });
