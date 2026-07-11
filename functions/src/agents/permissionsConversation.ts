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
const CLIENT_STEPS: Record<string, { desc: string; reask: string }> = {
  client_permissions_contact: {
    desc:  "Can Evia reach out to caregivers on your behalf to schedule interviews once you select someone?",
    reask: "So — can I reach out to caregivers on your behalf to schedule interviews once you select someone? Either way is fine.",
  },
  client_permissions_booking: {
    desc:  "Once you've approved a caregiver, can Evia book their first visits for you (always showing you what's booked and waiting for confirmation)?",
    reask: "So — once you've approved a caregiver after an interview, can I book their first visits for you? I'll always show you exactly what I'm booking and wait for your confirmation.",
  },
  client_permissions_autobook: {
    desc:  "For recurring visits with a caregiver you've already approved, can Evia book automatically without checking each time?",
    reask: "And for recurring visits with a caregiver you've already approved — want me to book those automatically, or always check with you first?",
  },
};

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
  // Client permissions
  canContactCaregivers:          boolean;
  canScheduleInterviews:         boolean;
  canBookWithConfirmation:       boolean;
  canBookAutomatically:          boolean;
  canCancelWithConfirmation:     boolean;
  canSendWeeklyDigest:           boolean;
  canSendHealthAlerts:           boolean;
  // Caregiver permissions
  canAcceptJobsWithConfirmation: boolean;
  canDeclineJobsAutomatically:   boolean;
  canSendArrivalNotifications:   boolean;
  canShareJournalWithFamily:     boolean;
}

// ── Read helper — used by action handlers to check before acting ──────────────

export async function getPermissions(userId: string): Promise<AgentPermissions | null> {
  const snap = await db.collection("agent_permissions").doc(userId).get();
  if (!snap.exists) return null;
  return snap.data() as AgentPermissions;
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
  if (userType === "caregiver") {
    return {
      ...(step === "caregiver_permissions_decline" ? { canDeclineJobsAutomatically: false } : {}),
      canSendArrivalNotifications:   false,
      canShareJournalWithFamily:     true,
      canAcceptJobsWithConfirmation: true,
    };
  }
  const fromContact = step === "client_permissions_contact";
  const fromBooking = fromContact || step === "client_permissions_booking";
  return {
    ...(fromContact ? { canContactCaregivers: false, canScheduleInterviews: false } : {}),
    ...(fromBooking ? {
      canBookWithConfirmation:   false,
      canCancelWithConfirmation: false,
      canSendWeeklyDigest:       true,
      canSendHealthAlerts:       true,
    } : {}),
    canBookAutomatically: false,
  };
}

// Find the client's latest intake and kick off matching (fire-and-forget).
// Shared by the normal autobook completion, the question-detour bailout, and
// the stale-permissions sweep.
async function kickOffClientMatching(phone: string, chatId: string): Promise<void> {
  const { runMatchingForClient } = await import("./matchingAgent");
  const intakeSnap = await db.collection("clientIntakes")
    .where("phone", "==", phone)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  if (!intakeSnap.empty) {
    const intake = intakeSnap.docs[0].data();
    runMatchingForClient(phone, chatId, intake).catch((err) =>
      console.error("runMatchingForClient error:", err)
    );
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
  } else {
    await kickOffClientMatching(phone, chatId);
  }
}

// ── CLIENT permissions flow ───────────────────────────────────────────────────

export async function sendClientPermissionsFlow(
  phone:   string,
  chatId:  string,
  session: AgentSession
): Promise<void> {
  const d = session.onboardingData ?? {};
  await db.collection("agent_sessions").doc(phone).update({
    onboardingStep:     "client_permissions_contact",
    permissionsContext: "client",
  });

  const msgPerm1 = await generateCaraMessage({
    audience: "family",
    context: `Evia has already started searching for caregivers for ${d.seniorName ?? "a loved one"}. Before sending matches, Evia needs to ask a couple of quick questions. Introduce this warmly and ask if Evia can reach out to caregivers on the family's behalf to schedule interviews once they select someone. End with that yes/no question itself — never a stiff "Reply YES or NO" instruction or a menu.`,
    fallback: `I'm already searching for caregivers for ${d.seniorName ?? "your loved one"}. Before I send you matches, two quick questions so I know how to best help you.\n\nCan I reach out to caregivers on your behalf to schedule interviews once you select someone?`,
  });
  await sendMessage(chatId, msgPerm1);
}

export async function handleClientPermissionsReply(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession,
  userId:  string
): Promise<void> {
  const step = (session as any).onboardingStep ?? "";

  // Answer a mid-flow question instead of silently recording it as a denial.
  const verdict = await classifyPermissionReply(text);
  if (verdict === "question" && CLIENT_STEPS[step]) {
    const liveFact = await permissionsLiveFact(step, phone, session);
    const detours  = await bumpPermissionsDetourCount(phone, session);
    if (detours >= 2) {
      // Max ONE re-ask: answer their question, default the remaining
      // permissions OFF, and complete — matching starts either way, and they
      // can change any setting later by texting.
      const answer = await generateCaraMessage({
        audience: "family",
        context: `${liveFact ? `${liveFact} ` : ""}During permissions setup, the family was asked: "${CLIENT_STEPS[step].desc}". ` +
          `Instead of yes/no they asked: "${text}". Answer their question briefly, warmly, and honestly. Then let them know ` +
          `they're ALL SET — Evia has left these optional settings off for now (Evia will always check with them first), ` +
          `Evia is already finding caregivers and will text the top matches, and they can change any setting anytime just ` +
          `by texting. Do NOT re-ask the yes/no question.`,
        fallback: "Good question! For now I've left these optional settings off — I'll always check with you first — and you're all set. I'm finding caregivers now and will text you the top matches. Text me anytime to change anything.",
      });
      await sendMessage(chatId, answer);
      await finalizePermissionsWithDefaults(phone, chatId, "client", userId, step);
      return;
    }
    await answerPermissionQuestion("family", chatId, text, CLIENT_STEPS[step].desc, CLIENT_STEPS[step].reask, liveFact);
    return;
  }
  const isYes = verdict === "yes";

  if (step === "client_permissions_contact") {
    await setPermissions(phone, userId, "client", {
      canContactCaregivers:  isYes,
      canScheduleInterviews: isYes,
    });
    await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "client_permissions_booking" });
    const msgPerm2 = await generateCaraMessage({
      audience: "family",
      context: "Evia just received the family's answer about scheduling interviews. Acknowledge their reply, then ask: once they've approved a caregiver after an interview, can Evia book the first visits for them? Mention that Evia will always show exactly what's being booked and wait for confirmation before scheduling anything. End with that yes/no question itself — never a stiff \"Reply YES or NO\" instruction or a menu.",
      fallback: "Got it.\n\nOnce you've approved a caregiver after an interview, can I book their first visits for you? I'll always show you exactly what I'm booking and wait for your confirmation before anything is scheduled.",
    });
    await sendMessage(chatId, msgPerm2);
    return;
  }

  if (step === "client_permissions_booking") {
    await setPermissions(phone, userId, "client", {
      canBookWithConfirmation:   isYes,
      canCancelWithConfirmation: isYes,
      canSendWeeklyDigest:       true,
      canSendHealthAlerts:       true,
    });
    await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "client_permissions_autobook" });
    const msgPerm3 = await generateCaraMessage({
      audience: "family",
      context: "Evia just received the family's answer about booking visits. Acknowledge, then ask: for recurring visits with a caregiver they've already approved, would they like Evia to book automatically, or always check with them first? End with that question itself — never a stiff \"Reply YES or NO\" instruction or a numbered menu.",
      fallback: "Got it.\n\nOne more thing — for recurring visits with a caregiver you've already approved, want me to book those automatically, or always check with you first?",
    });
    await sendMessage(chatId, msgPerm3);
    return;
  }

  if (step === "client_permissions_autobook") {
    await setPermissions(phone, userId, "client", {
      canBookAutomatically: isYes,
    });
    await db.collection("agent_sessions").doc(phone).update({
      onboardingStep: "complete",
      optedIn:        true,
    });
    const msgPerm4 = await generateCaraMessage({
      audience: "family",
      context: `Evia just finished the permissions setup for a family. They ${isYes ? "said YES to automatic booking" : "said NO — they want to make final calls themselves"}. Send a warm closing message acknowledging their choice, let them know Evia is still searching and will text the top caregiver matches within the hour, and invite them to text anytime with questions.`,
      fallback: `Perfect. I'll handle all the coordination${isYes ? " and book automatically" : " — you make the final calls"}.\n\nI'm still searching for caregivers — I'll text you the top matches within the hour.\n\nQuestions? Just text me anytime.`,
    });
    await sendMessage(chatId, msgPerm4);

    // Capability discovery: now that onboarding is complete, tell the family
    // what Evia can actually do in care-work terms, not a chatbot menu.
    await sendMessage(chatId, buildHelpSmsReply("client", undefined,
      languageFromSession(session as unknown as Record<string, unknown>)));

    // Kick off matching
    await kickOffClientMatching(phone, chatId);
    return;
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
    context: `Evia is starting the permissions setup for caregiver ${caregiverName}. Ask a couple of quick questions so Evia can work best for them. First question: can Evia automatically decline job requests that are outside their stated availability? Mention it saves them time on requests they can't take. End with that yes/no question itself — never a stiff "Reply YES or NO" instruction or a menu.`,
    fallback: `A couple of quick questions so I can work best for you, ${caregiverName}:\n\nIs it OK if I automatically pass on job requests that fall outside your stated availability? It saves you time on requests you can't take.`,
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
  const d    = session.onboardingData ?? {};

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
        fallback: "Good question! For now I've left these optional auto-settings off and you're all set — your profile is complete and live. Text me anytime to turn on auto-declining jobs or arrival notifications.",
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
      canDeclineJobsAutomatically: isYes,
    });
    await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "caregiver_permissions_arrival" });
    const msgPerm6 = await generateCaraMessage({
      audience: "caregiver",
      context: "Evia just received a caregiver's answer about auto-declining jobs. Acknowledge it, then ask: when they arrive at a client's home, would they like Evia to automatically notify the family? Families love knowing their caregiver has arrived. End with that yes/no question itself — never a stiff \"Reply YES or NO\" instruction or a menu.",
      fallback: "Got it.\n\nWhen you arrive at a client's home, want me to automatically let the family know you're there? They love knowing their caregiver has arrived.",
    });
    await sendMessage(chatId, msgPerm6);
    return;
  }

  if (step === "caregiver_permissions_arrival") {
    await setPermissions(phone, caregiverId, "caregiver", {
      canSendArrivalNotifications:   isYes,
      canShareJournalWithFamily:     true,
      canAcceptJobsWithConfirmation: true,
    });
    await db.collection("agent_sessions").doc(phone).update({
      onboardingStep: "complete",
      optedIn:        true,
    });
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
): Promise<void> {
  const permOptions = userType === "client"
    ? "canSendWeeklyDigest (weekly summaries/digest), canSendHealthAlerts (health alerts), canBookAutomatically (auto-booking)"
    : "canDeclineJobsAutomatically (auto-decline jobs), canSendArrivalNotifications (arrival notifications), canShareJournalWithFamily (share journal with family)";

  const raw = await askClaude(
    `The user is changing a notification or feature permission. ` +
    `Available permissions for a ${userType}: ${permOptions}. ` +
    `Determine: (1) which permission they mean, (2) whether they want to enable or disable it. ` +
    `Reply in JSON: {"permission":"<permissionKey>","action":"enable|disable"}. ` +
    `If the message is not a permission change request, reply with the literal word: none`,
    text
  );

  if (raw === "__error__" || raw === "none" || !raw.startsWith("{")) return;

  let permission: string, action: string;
  try {
    const parsed = JSON.parse(raw);
    permission = parsed.permission ?? "";
    action     = parsed.action     ?? "";
  } catch { return; }

  const validPerms: (keyof AgentPermissions)[] = [
    "canSendWeeklyDigest", "canSendHealthAlerts", "canBookAutomatically",
    "canDeclineJobsAutomatically", "canSendArrivalNotifications", "canShareJournalWithFamily",
  ];
  const matched = validPerms.find(p => p === permission);
  if (!matched || (action !== "enable" && action !== "disable")) return;

  const newVal = action === "enable";
  const ref = db.collection("agent_permissions").doc(userId);
  await ref.set({ [matched]: newVal, updatedAt: new Date().toISOString() }, { merge: true });

  const friendly: Record<string, string> = {
    canSendWeeklyDigest:         "weekly summaries",
    canSendHealthAlerts:         "health alerts",
    canBookAutomatically:        "automatic booking",
    canDeclineJobsAutomatically: "auto-declining jobs outside your availability",
    canSendArrivalNotifications: "arrival notifications",
    canShareJournalWithFamily:   "sharing journal entries with families",
  };
  const label = friendly[matched] ?? matched;
  if (!newVal) {
    await sendMessage(chatId, `Got it. No more ${label}. Just text me if you change your mind.`);
  } else {
    const resumeLabel = label.includes("book") ? "asking before booking" : `sending ${label} again`;
    await sendMessage(chatId, `Sure thing. I'll go back to ${resumeLabel}.`);
  }
}
