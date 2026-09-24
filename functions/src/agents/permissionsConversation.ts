import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { quickComplete } from "../utils/openaiClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { buildHelpSmsReply } from "./capabilityDiscovery";
import { languageFromSession } from "../utils/language";
import { appLink, getAppUrl } from "../config/appUrl";
import { LIVE_GATE_FACT_BUILDERS } from "./liveGateFacts";

async function askClaude(system: string, userText: string): Promise<string> {
  try {
    const res = await getSharedClient().messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 100,
      system, messages: [{ role: "user", content: userText }],
    });
    return ((res.content[0] as { text: string }).text ?? "").trim();
  } catch { return "__error__"; }
}

// Classify a reply to a YES/NO permission question. Strict tokens short-circuit
// (CLAUDE.md allows === for explicit "Reply YES or NO" prompts); everything else
// goes to the LLM, which crucially distinguishes a QUESTION ("what if I change
// my mind?") from a decline — without this, any non-YES reply was silently
// recorded as NO, denying a permission the user never declined.
export async function classifyPermissionReply(text: string): Promise<"yes" | "no" | "question"> {
  const norm = text.trim().toUpperCase();
  if (["YES", "Y", "1", "YEP", "YEAH", "SURE", "OK", "OKAY"].includes(norm)) return "yes";
  if (["NO", "N", "2", "NOPE", "NAH"].includes(norm)) return "no";
  const raw = await quickComplete(
    "A care assistant asked the user a YES/NO permission question. Classify their reply as one word: " +
      "YES (they agree/approve), NO (they decline), or QUESTION (they're asking something, unsure, or " +
      "anything that isn't a clear yes/no). Reply with only YES, NO, or QUESTION.",
    text,
    { maxTokens: 5 },
  ).catch(() => "QUESTION");
  const v = raw.trim().toUpperCase();
  if (v.startsWith("YES")) return "yes";
  if (v.startsWith("NO")) return "no";
  return "question";
}

// Live-state grounding for permission-step answers. Without it the model
// invents profile state — the founder's "what's missing in my profile?" at
// caregiver_permissions_decline (2026-07-10) got a fabricated list of missing
// availability fields when nothing was missing at all. Fail-soft: "" leaves
// the answer ungrounded rather than blocking it.
async function permissionsLiveFact(step: string, phone: string, session: AgentSession): Promise<string> {
  try {
    const builder = LIVE_GATE_FACT_BUILDERS[step];
    return builder ? await builder(phone, session) : "";
  } catch (e) {
    console.warn("[permissionsLiveFact] builder failed (ungrounded answer):", e);
    return "";
  }
}

// Answer a mid-flow question without recording a permission, then re-ask the
// current question so the user can still answer it.
async function answerPermissionQuestion(
  audience: "family" | "caregiver",
  chatId:   string,
  userText: string,
  desc:     string,
  reask:    string,
  liveFact: string,
): Promise<void> {
  const who = audience === "family" ? "the family" : "the caregiver";
  const answer = await generateCaraMessage({
    audience,
    context: `${liveFact ? `${liveFact} Ground your answer in this live status and NEVER assert a state that contradicts it. ` : ""}` +
      `During permissions setup, ${who} was asked: "${desc}". Instead of answering yes/no they said: ` +
      `"${userText}". Answer their question or concern briefly, warmly, and honestly. Do NOT include the ` +
      `yes/no prompt — it is appended separately.`,
    fallback: "Good question — happy to clarify.",
  });
  await sendMessage(chatId, `${answer}\n\n${reask}`);
}

// Count a question-detour on the session. The permissions flow follows the
// repo's "max ONE re-ask" confirm-handler rule: the first question gets an
// answer + re-ask; a second detour bails out with safe defaults so the session
// can never be trapped at a permissions step (every inbound text is consumed
// by this state machine until onboardingStep reaches "complete").
async function bumpPermissionsDetourCount(phone: string, session: AgentSession): Promise<number> {
  const detours = Number((session as any).permissionsDetourCount ?? 0) + 1;
  await db.collection("agent_sessions").doc(phone)
    .update({ permissionsDetourCount: detours })
    .catch(() => {/* non-critical */});
  return detours;
}

// Per-step question text + re-ask line, used to answer a mid-flow question and
// then re-pose the exact question the user was on. Voice contract (2026-07-11):
// natural questions, no stiff "Reply YES or NO" instruction and no numbered
// menus — classifyPermissionReply already understands "yes"/"sure"/"always ask
// me first"/etc., and "1"/"2" still parse for anyone who replies with numbers.
const CAREGIVER_STEPS: Record<string, { desc: string; reask: string }> = {
  caregiver_permissions_decline: {
    desc:  "Can Evia automatically decline job requests that are outside your stated availability?",
    reask: "So — is it OK if I automatically pass on job requests that fall outside your stated availability? It saves you time on requests you can't take, and you can change this anytime.",
  },
  caregiver_permissions_arrival: {
    desc:  "When you arrive at a client's home, do you want Evia to automatically notify the family?",
    reask: "And when you arrive at a client's home, want me to automatically let the family know you're there? They love knowing their caregiver has arrived.",
  },
};

const db = admin.firestore();

export interface AgentPermissions {
  userId:                        string;
  userType:                      "client" | "caregiver";
  updatedAt:                     string;
  // Caregiver permissions
  canAcceptJobsWithConfirmation: boolean;
  canDeclineJobsAutomatically:   boolean;
  canSendArrivalNotifications:   boolean;
  canShareJournalWithFamily:     boolean;
}

async function setPermissions(
  phone: string,
  userId: string,
  userType: "client" | "caregiver",
  perms: Partial<AgentPermissions>
): Promise<void> {
  const ref  = db.collection("agent_permissions").doc(userId);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() as AgentPermissions) : {};
  await ref.set({
    ...existing,
    ...perms,
    userId,
    userType,
    updatedAt: new Date().toISOString(),
  });

  // Track last permissions question in session
  await db.collection("agent_sessions").doc(phone).update({
    permissionsStep: perms,
  }).catch(() => {/* non-critical */});
}

// Defaults for every permission question from `step` onward — deny-by-default
// for anything the user never explicitly answered (never grant a permission
// the user didn't give), plus the unconditional grants the normal completion
// path always sets. All of these are changeable later via updatePermissionFromText.
function remainingPermissionDefaults(
  userType: "client" | "caregiver",
  step: string,
): Partial<AgentPermissions> {
  if (userType !== "caregiver") return {};
  {
    return {
      ...(step === "caregiver_permissions_decline" ? { canDeclineJobsAutomatically: false } : {}),
      // Arrival notifications are standard behavior (founder, 2026-07-15) —
      // the family is always notified on ARRIVED; this flag is never read by
      // any sender, so it defaults granted for consistency with reality.
      canSendArrivalNotifications:   true,
      canShareJournalWithFamily:     true,
      canAcceptJobsWithConfirmation: true,
    };
  }
}

// Complete the permissions flow with safe defaults for everything unanswered
// and unblock the session. Used by (a) the question-detour bailout in the two
// reply handlers and (b) the 7-day stale sweep in staleSessionNudge — a session
// must never be permanently trapped at a permissions step, because the router
// consumes EVERY inbound text while onboardingStep is one of these steps.
export async function finalizePermissionsWithDefaults(
  phone:    string,
  chatId:   string,
  userType: "client" | "caregiver",
  userId:   string,
  step:     string,
): Promise<void> {
  await setPermissions(phone, userId, userType, remainingPermissionDefaults(userType, step));
  await db.collection("agent_sessions").doc(phone).update({
    onboardingStep: "complete",
    optedIn:        true,
  });
  if (userType === "caregiver") {
    // Same completion notice the normal path sends — the profile is live and
    // matchable either way; the note flags that permissions were defaulted.
    await db.collection("admin_alerts").add({
      type:        "caregiver_onboarding_complete",
      caregiverId: userId,
      phone,
      note:        "Caregiver completed onboarding — optional permissions defaulted OFF (setup questions unanswered); profile is live.",
      createdAt:   new Date().toISOString(),
      resolved:    false,
    });
    import("../triggers/caregiverJobMatch")
      .then((m) => m.notifyNewCaregiverOfJobs(userId))
      .catch((err) => console.error("notifyNewCaregiverOfJobs error:", err));
  }
}

// ── CAREGIVER permissions flow ─────────────────────────────────────────────────

export async function sendCaregiverPermissionsFlow(
  phone:        string,
  chatId:       string,
  _session:     AgentSession,
  caregiverName: string
): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    onboardingStep: "caregiver_permissions_decline",
  });
  const msgPerm5 = await generateCaraMessage({
    audience: "caregiver",
    context: `Evia is starting the permissions setup for caregiver ${caregiverName}. There is exactly ONE quick question: can Evia automatically decline job requests that are outside their stated availability? Mention it saves them time on requests they can't take. End with that yes/no question itself — never a stiff "Reply YES or NO" instruction or a menu.`,
    fallback: `One quick question so I can work best for you, ${caregiverName}:\n\nIs it OK if I automatically pass on job requests that fall outside your stated availability? It saves you time on requests you can't take.`,
  });
  await sendMessage(chatId, msgPerm5);
}

export async function handleCaregiverPermissionsReply(
  phone:       string,
  chatId:      string,
  text:        string,
  session:     AgentSession,
  caregiverId: string
): Promise<void> {
  const step = (session as any).onboardingStep ?? "";

  // Answer a mid-flow question instead of silently recording it as a denial.
  const verdict = await classifyPermissionReply(text);
  if (verdict === "question" && CAREGIVER_STEPS[step]) {
    const liveFact = await permissionsLiveFact(step, phone, session);
    const detours  = await bumpPermissionsDetourCount(phone, session);
    if (detours >= 2) {
      // Max ONE re-ask: answer their question, default the remaining
      // permissions OFF, and complete — the profile is already live and
      // matchable, and they can change any setting later by texting.
      const answer = await generateCaraMessage({
        audience: "caregiver",
        context: `${liveFact ? `${liveFact} ` : ""}During permissions setup, the caregiver was asked: "${CAREGIVER_STEPS[step].desc}". ` +
          `Instead of yes/no they asked: "${text}". Answer their question briefly, warmly, and honestly. Then let them know ` +
          `they're ALL SET — their profile is complete and live, Evia has left these optional auto-settings off for now, ` +
          `and they can turn them on anytime just by texting. Do NOT re-ask the yes/no question.`,
        fallback: "Good question! For now I've left auto-declining jobs off and you're all set — your profile is complete and live. Text me anytime to turn it on.",
      });
      await sendMessage(chatId, answer);
      await finalizePermissionsWithDefaults(phone, chatId, "caregiver", caregiverId, step);
      return;
    }
    await answerPermissionQuestion("caregiver", chatId, text, CAREGIVER_STEPS[step].desc, CAREGIVER_STEPS[step].reask, liveFact);
    return;
  }
  const isYes = verdict === "yes";

  if (step === "caregiver_permissions_decline") {
    await setPermissions(phone, caregiverId, "caregiver", {
      canDeclineJobsAutomatically:   isYes,
      // Arrival notifications are standard behavior, not an opt-in (founder,
      // 2026-07-15): the family is always told when a caregiver texts ARRIVED
      // (handleArrived notifies unconditionally — no sender ever read this
      // flag). The old opt-in question was pure copy, and while a caregiver
      // sat parked on it, it hijacked their job-alert replies (seen live
      // 07-14: "Interested tell me more" answered with an auto-notify speech).
      canSendArrivalNotifications:   true,
      canShareJournalWithFamily:     true,
      canAcceptJobsWithConfirmation: true,
    });
    await completeCaregiverPermissions(phone, chatId, session, caregiverId);
    return;
  }

  // Legacy: sessions already parked at the removed arrival question — honor
  // their answer and complete normally. New sessions never enter this step.
  if (step === "caregiver_permissions_arrival") {
    await setPermissions(phone, caregiverId, "caregiver", {
      canSendArrivalNotifications:   isYes,
      canShareJournalWithFamily:     true,
      canAcceptJobsWithConfirmation: true,
    });
    await completeCaregiverPermissions(phone, chatId, session, caregiverId);
    return;
  }
}

// Shared permissions-flow completion: celebrates, sends the capability menu,
// alerts admin, and fans out job invites. Reached from the decline step (the
// only question since the arrival opt-in was removed) and from legacy sessions
// still parked at the old arrival step.
async function completeCaregiverPermissions(
  phone:       string,
  chatId:      string,
  session:     AgentSession,
  caregiverId: string,
): Promise<void> {
  const d = session.onboardingData ?? {};
  await db.collection("agent_sessions").doc(phone).update({
    onboardingStep: "complete",
    optedIn:        true,
  });
  {
    const appUrl  = getAppUrl();
    const name    = d.name    ? `, ${d.name as string}` : "";
    const city    = d.city    ? ` in ${d.city as string}` : "";

    const msgPerm7 = await generateCaraMessage({
      audience: "caregiver",
      context: `Caregiver ${d.name ? String(d.name) : ""}${city ? ` based${city}` : ""} just completed onboarding and permissions setup. Their profile is now live and they're ready to be matched with families. Celebrate this warmly, let them know what happens next (Evia will text job details when a family needs someone with their skills, including the care plan and directions before every visit).`,
      fallback: `You're all set${name}! Your profile is live and you're ready to be matched with families${city}.\n\nWhen a family needs someone with your skills, I'll text you the job details — including the care plan and directions before every visit.`,
    });
    await sendMessage(chatId, `${msgPerm7}\n\nView your profile: ${appUrl}/p/${caregiverId}\n\nLog in anytime to manage your profile, availability, and payouts: ${appLink("/login")}`);

    // Capability discovery: onboarding is complete — tell the caregiver what
    // Evia can do in care-work terms, not a chatbot menu.
    await sendMessage(chatId, buildHelpSmsReply("caregiver", undefined,
      languageFromSession(session as unknown as Record<string, unknown>)));

    // Notify admin that this caregiver finished onboarding — the profile is live
    // and matchable at this point (background check already cleared, permissions
    // set), so this is a completion notice, NOT a pending-review request.
    await db.collection("admin_alerts").add({
      type:        "caregiver_onboarding_complete",
      caregiverId,
      name:        d.name,
      phone,
      note:        "Caregiver completed onboarding — profile is live and ready to match.",
      createdAt:   new Date().toISOString(),
      resolved:    false,
    });

    // U10 job fan-out — moved here from the stripe_connect completion handler
    // (2026-07-10): it used to fire ~1 minute BEFORE the permissions questions,
    // so the job invite's "Reply YES or NO" and the permission's "Reply YES or
    // NO" raced, and while onboardingStep was a permissions step the router fed
    // the caregiver's YES to the permissions machine — silently dropping the
    // job application. Now the session is "complete" (normal routing handles
    // pendingJobId) before any job invite goes out.
    import("../triggers/caregiverJobMatch")
      .then((m) => m.notifyNewCaregiverOfJobs(caregiverId))
      .catch((err) => console.error("notifyNewCaregiverOfJobs error:", err));
    return;
  }
}

// ── Permission updates via text ───────────────────────────────────────────────

export async function updatePermissionFromText(
  userId:   string,
  userType: "client" | "caregiver",
  phone:    string,
  chatId:   string,
  text:     string
): Promise<boolean> {
  // Caregiver-only (2026-09-23): the client permission questions were removed —
  // the site has no equivalent setting, so clients fall through to the QA agent.
  if (userType !== "caregiver") return false;
  const permOptions = "canDeclineJobsAutomatically (auto-decline jobs), canSendArrivalNotifications (arrival notifications), canShareJournalWithFamily (share journal with family)";

  const raw = await askClaude(
    `The user is changing a notification or feature permission. ` +
    `Available permissions for a ${userType}: ${permOptions}. ` +
    `Determine: (1) which permission they mean, (2) whether they want to enable or disable it. ` +
    `Reply in JSON: {"permission":"<permissionKey>","action":"enable|disable"}. ` +
    `If the message is not a permission change request, reply with the literal word: none`,
    text
  );

  if (raw === "__error__" || raw === "none" || !raw.startsWith("{")) return false;

  let permission: string, action: string;
  try {
    const parsed = JSON.parse(raw);
    permission = parsed.permission ?? "";
    action     = parsed.action     ?? "";
  } catch { return false; }

  const validPerms: (keyof AgentPermissions)[] = [
    "canDeclineJobsAutomatically", "canSendArrivalNotifications", "canShareJournalWithFamily",
  ];
  const matched = validPerms.find(p => p === permission);
  if (!matched || (action !== "enable" && action !== "disable")) return false;

  const newVal = action === "enable";
  const ref = db.collection("agent_permissions").doc(userId);
  await ref.set({ [matched]: newVal, updatedAt: new Date().toISOString() }, { merge: true });

  const friendly: Record<string, string> = {
    canDeclineJobsAutomatically: "auto-declining jobs outside your availability",
    canSendArrivalNotifications: "arrival notifications",
    canShareJournalWithFamily:   "sharing journal entries with families",
  };
  const label = friendly[matched] ?? matched;
  if (!newVal) {
    await sendMessage(chatId, `Got it. No more ${label}. Just text me if you change your mind.`);
  } else {
    await sendMessage(chatId, `Sure thing. I'll go back to ${label}.`);
  }
  return true;
}
