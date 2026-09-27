import * as admin from "firebase-admin";
import { AgentSession } from "../linq/client";

// Live per-user state for the gate/awaiting steps. The static STEP_QUESTION_FACTS
// in onboardingConversation.ts describe the PROCESS; without the user's ACTUAL
// state a status question ("did my payment go through?", "where's my check?")
// gets a hedged, fact-free non-answer (founder report, 2026-07-09 — a caregiver
// at caregiver_awaiting_bgcheck asked their status and got the canned "if you've
// finished the form..." deflection). Each builder returns a
// "LIVE STATUS RIGHT NOW: …" fact for the LLM prompt, or "" (fail-soft — the
// static facts then stand alone). Builders are READ-ONLY and Firestore-only: no
// Stripe/Checkr network reads on the question path.

const db = admin.firestore();

// Several builders need a FRESH agent_sessions/{phone} read: the in-hand session
// can be stale if a webhook (Stripe/Checkr) raced the user's question — and that
// race is exactly when a live answer matters most (they just paid, then ask "did
// it go through?"). Fail-soft to the in-hand session on any read error.
async function readFreshSession(phone: string, fallback: AgentSession): Promise<AgentSession> {
  try {
    if (!phone) return fallback;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (snap.exists) return snap.data() as AgentSession;
  } catch (e) {
    console.warn("[liveGateFacts] fresh session read failed (using in-hand session):", e);
  }
  return fallback;
}

// ── Bg-check status (moved verbatim from onboardingConversation.ts, 2026-07-09) ─
// Reads the same caregivers/{id}.backgroundCheckData the get_background_check_status
// MCP tool reads, with the same summary mapping. Behavior unchanged from the
// original: uses the in-hand session's caregiverId (no fresh read).
export async function buildLiveBgcheckFact(session: AgentSession): Promise<string> {
  try {
    const caregiverId = session.caregiverId;
    if (!caregiverId) return "";
    const snap = await db.collection("caregivers").doc(caregiverId).get();
    if (!snap.exists) return "";
    const bg = (snap.data()?.backgroundCheckData ?? {}) as Record<string, unknown>;
    const status           = bg.status as string | undefined;
    const invitationStatus = bg.invitationStatus as string | undefined;
    const submitted        = !!bg.submittedAt || !!bg.checkrCandidateId;
    const submittedDay     = bg.submittedAt ? String(bg.submittedAt).slice(0, 10) : "";
    if (status === "clear") {
      return "LIVE STATUS RIGHT NOW: their background check CLEARED — they're approved.";
    }
    if (status === "consider" || status === "suspended") {
      return "LIVE STATUS RIGHT NOW: their check finished but needs a manual review — Evia's team is on it and " +
        "will text them directly. Do NOT speculate about the outcome or say anything alarming.";
    }
    if (invitationStatus === "expired" || invitationStatus === "canceled") {
      return `LIVE STATUS RIGHT NOW: their Checkr invitation ${invitationStatus} before they finished the form — ` +
        "they need a fresh link (Evia can re-send it if they ask).";
    }
    if (invitationStatus === "completed" || (submitted && bg.submittedAt)) {
      return "LIVE STATUS RIGHT NOW: Checkr HAS their finished form" +
        (submittedDay ? ` (submitted ${submittedDay})` : "") +
        " and the check is running — do NOT hedge with 'if you've finished the form', they already have. " +
        "Tell them it's in progress and Evia texts them the moment results land.";
    }
    if (submitted) {
      return "LIVE STATUS RIGHT NOW: their check is in progress with Checkr.";
    }
    return "LIVE STATUS RIGHT NOW: Checkr has NOT received their finished form yet — the secure link is in their " +
      "email from Checkr (Evia can text it again if they ask).";
  } catch (e) {
    console.warn("[buildLiveBgcheckFact] failed (fail-soft to static facts):", e);
    return "";
  }
}

// ── Membership (caregiver) ─────────────────────────────────────────────────────
// The caregiverSubscriptionId / mvrPaid / membershipCheckoutUrl flags all live on
// the SESSION doc (stamped by the caregiver_membership Stripe webhook — see
// stripe.ts). MUST NOT read caregivers/{caregiverId}: that doc doesn't exist yet
// at the membership step (caregiverId is first set at bg-check consent).
export async function buildLiveMembershipFact(phone: string, session: AgentSession): Promise<string> {
  try {
    const s = await readFreshSession(phone, session);
    const subId       = (s as any).caregiverSubscriptionId as string | undefined;
    const mvrPaid     = (s as any).mvrPaid === true;
    const checkoutUrl = (s as any).membershipCheckoutUrl as string | undefined;
    if (subId) {
      const step = (s.onboardingStep ?? "") as string;
      const advanced = step !== "caregiver_send_membership" && step !== "caregiver_awaiting_membership";
      return "LIVE STATUS RIGHT NOW: their membership payment WENT THROUGH" +
        (mvrPaid ? " (the Approved Driver add-on was paid too)" : "") +
        (advanced ? ", and the next step is already under way" : "") +
        " — do NOT ask them to pay again or tap the link; confirm it's done and reassure them.";
    }
    if (checkoutUrl) {
      return "LIVE STATUS RIGHT NOW: their membership payment hasn't come through yet — the checkout link Evia " +
        "already sent is the way (Evia can text it again if they ask).";
    }
    return "LIVE STATUS RIGHT NOW: the membership payment link hasn't been sent yet — Evia is about to send it.";
  } catch (e) {
    console.warn("[buildLiveMembershipFact] failed (fail-soft to static facts):", e);
    return "";
  }
}

// ── Profile photo (caregiver) ──────────────────────────────────────────────────
// onboardingData.profilePhoto is set by advanceOnboardingStep("photo_upload").
// Session-only — caregivers/{caregiverId} isn't created yet at the photo step.
export async function buildLivePhotoFact(phone: string, session: AgentSession): Promise<string> {
  try {
    const s = await readFreshSession(phone, session);
    const d = (s.onboardingData ?? {}) as Record<string, unknown>;
    if (d.profilePhoto) {
      return "LIVE STATUS RIGHT NOW: their profile photo is IN — Evia already has it. Do NOT ask them to upload " +
        "it again; confirm it's received (next up is job type and availability, like the site's wizard).";
    }
    return "LIVE STATUS RIGHT NOW: no profile photo received yet — the upload link Evia sent is the way (Evia can " +
      "send it again if they ask).";
  } catch (e) {
    console.warn("[buildLivePhotoFact] failed (fail-soft to static facts):", e);
    return "";
  }
}

// ── Bg-check consent (caregiver_awaiting_bgcheck_consent) ──────────────────────
// This step sits between the /bgcheck consent link and the caregiver authorizing.
// caregiverId + backgroundCheckData are created by confirmBgcheckConsent the
// instant they authorize — so a fresh read can flip this from "not yet" to
// "already authorized" if a submit raced the question. Reading caregivers/{id}
// IS allowed here (unlike membership/photo/documents): by the time it exists,
// consent has been given.
export async function buildLiveBgcheckConsentFact(phone: string, session: AgentSession): Promise<string> {
  try {
    const s = await readFreshSession(phone, session);
    const caregiverId = s.caregiverId;
    if (caregiverId) {
      const snap = await db.collection("caregivers").doc(caregiverId).get();
      if (snap.exists) {
        const bg = (snap.data()?.backgroundCheckData ?? {}) as Record<string, unknown>;
        if (bg.consentGiven === true || bg.checkrCandidateId) {
          return "LIVE STATUS RIGHT NOW: they ALREADY reviewed and authorized their background check — Checkr has " +
            "emailed them a secure link to finish. Do NOT re-send the consent/authorization page; point them to the " +
            "Checkr email (Evia can re-text that link if they ask).";
        }
      }
    }
    return "LIVE STATUS RIGHT NOW: they haven't authorized their background check yet — the link Evia sent opens " +
      "Evia's secure page to review the disclosure and authorize it (about a minute).";
  } catch (e) {
    console.warn("[buildLiveBgcheckConsentFact] failed (fail-soft to static facts):", e);
    return "";
  }
}

// ── Payout setup / Stripe Connect (caregiver) ──────────────────────────────────
// By this step caregiverId IS set. Reads the caregivers/{id} Connect flags the
// stripeConnectWebhook stamps (stripeAccountId / detailsSubmitted / payoutsEnabled
// / stripeOnboardingComplete).
export async function buildLivePayoutSetupFact(phone: string, session: AgentSession): Promise<string> {
  try {
    const caregiverId = session.caregiverId;
    if (!caregiverId) return "";
    const snap = await db.collection("caregivers").doc(caregiverId).get();
    if (!snap.exists) return "";
    const { getCaregiverPayoutFields } = await import("../caregiverPrivate");
    const cg = await getCaregiverPayoutFields(caregiverId, (snap.data() ?? {}) as Record<string, unknown>);
    if (cg.stripeOnboardingComplete === true || cg.payoutsEnabled === true) {
      return "LIVE STATUS RIGHT NOW: their payouts are LIVE — earnings pay out daily automatically and instant " +
        "payouts are free. Congratulate them; do NOT nudge them to finish setup.";
    }
    if (!cg.stripeAccountId) {
      return "LIVE STATUS RIGHT NOW: their payout setup hasn't been started yet — the link Evia sent opens Stripe " +
        "to set up how they get paid after each visit.";
    }
    if (cg.detailsSubmitted === true) {
      return "LIVE STATUS RIGHT NOW: Stripe has their details and is finishing its review — they're nearly there. " +
        "Do NOT ask them to redo the form; reassure them it's almost done. No speculation about timing.";
    }
    return "LIVE STATUS RIGHT NOW: they started payout setup but haven't finished Stripe's form — the link Evia " +
      "sent resumes right where they left off.";
  } catch (e) {
    console.warn("[buildLivePayoutSetupFact] failed (fail-soft to static facts):", e);
    return "";
  }
}

// ── Client membership payment ──────────────────────────────────────────────────
// stripeSubscriptionId / stripeCustomerId land on the session (client_payment_setup
// Stripe webhook). Corroborate with users/{uid}.membershipStatus when uid is set —
// but never call admin.auth().getUserByPhoneNumber on the question path.
export async function buildLiveClientPaymentFact(phone: string, session: AgentSession): Promise<string> {
  try {
    const s = await readFreshSession(phone, session);
    let landed = !!((s as any).stripeSubscriptionId || (s as any).stripeCustomerId);
    if (!landed && s.userId) {
      const u = await db.collection("users").doc(s.userId).get();
      // Matches the website's own gate exactly (hooks/useAccessGates.tsx):
      // active OR trialing OR subscriptionActive — this only checked
      // "active" before, so a trialing subscription (not used by Evia's own
      // checkout today, but a real value the shared webhook can still write)
      // would have under-reported "hasn't landed" while the site already
      // showed the client unlocked.
      const ud = u.exists ? u.data() : null;
      if (ud?.subscriptionActive === true || ud?.membershipStatus === "active" || ud?.membershipStatus === "trialing") landed = true;
    }
    if (landed) {
      return "LIVE STATUS RIGHT NOW: their membership payment WENT THROUGH — do NOT ask them to pay again or tap " +
        "the link; confirm it's active and that Evia is already finding caregivers.";
    }
    return "LIVE STATUS RIGHT NOW: their membership payment hasn't come through yet — the checkout link Evia sent " +
      "is the way (it takes about 30 seconds).";
  } catch (e) {
    console.warn("[buildLiveClientPaymentFact] failed (fail-soft to static facts):", e);
    return "";
  }
}

// ── Client identity verification ───────────────────────────────────────────────
// onboardingData.needsIdentityVerification flips to false (+ identityVerifiedAt is
// stamped) by the Stripe Identity webhook; corroborate with
// users/{uid}.identityCheckStatus === "verified" when uid is set.
export async function buildLiveClientIdentityFact(phone: string, session: AgentSession): Promise<string> {
  try {
    const s = await readFreshSession(phone, session);
    const d = (s.onboardingData ?? {}) as Record<string, unknown>;
    let verified = d.needsIdentityVerification === false || !!d.identityVerifiedAt;
    if (!verified && s.userId) {
      const u = await db.collection("users").doc(s.userId).get();
      if (u.exists && u.data()?.identityCheckStatus === "verified") verified = true;
    }
    if (verified) {
      return "LIVE STATUS RIGHT NOW: their identity check is VERIFIED — do NOT ask them to redo it; confirm it's " +
        "done (next is the membership/payment step).";
    }
    return "LIVE STATUS RIGHT NOW: their identity check hasn't cleared yet — the secure Stripe Identity link Evia " +
      "sent is the way (about 30 seconds).";
  } catch (e) {
    console.warn("[buildLiveClientIdentityFact] failed (fail-soft to static facts):", e);
    return "";
  }
}

// At caregiver_awaiting_bgcheck_consent both the bg-check builder (#5) and the
// consent builder (#4) apply: run the bg-check one first (if they've authorized,
// its Checkr state is the richer answer), fall back to the consent builder when
// it returns "" (they haven't authorized yet).
async function buildLiveBgcheckConsentComposite(phone: string, session: AgentSession): Promise<string> {
  const primary = await buildLiveBgcheckFact(session);
  if (primary) return primary;
  return buildLiveBgcheckConsentFact(phone, session);
}

// Map from onboardingStep → live-fact builder. answerQuestionMidFlow and the
// inline other-branches / resend helpers / staleSessionNudge all consult this so
// grounding stays in one place (a builder may be registered under several keys).
export const LIVE_GATE_FACT_BUILDERS: Record<string, (phone: string, session: AgentSession) => Promise<string>> = {
  caregiver_send_membership:          buildLiveMembershipFact,
  caregiver_awaiting_membership:      buildLiveMembershipFact,
  caregiver_send_bgcheck:             (_p, s) => buildLiveBgcheckFact(s),
  caregiver_awaiting_bgcheck_consent: buildLiveBgcheckConsentComposite,
  caregiver_awaiting_bgcheck:         (_p, s) => buildLiveBgcheckFact(s),
  caregiver_send_stripe_connect:      buildLivePayoutSetupFact,
  caregiver_awaiting_stripe:          buildLivePayoutSetupFact,
  client_send_payment:                buildLiveClientPaymentFact,
  client_awaiting_payment:            buildLiveClientPaymentFact,
  client_awaiting_identity:           buildLiveClientIdentityFact,
};
