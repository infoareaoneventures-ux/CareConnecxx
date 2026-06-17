import * as admin from "firebase-admin";
import { getSharedClient } from "../utils/claudeClient";
import { sendMessage, AgentSession } from "../linq/client";
import { generateCaraMessage } from "../utils/caraMessage";
import { getAppUrl } from "../config/appUrl";

async function askClaude(system: string, userText: string): Promise<string> {
  try {
    const res = await getSharedClient().messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 100,
      system, messages: [{ role: "user", content: userText }],
    });
    return ((res.content[0] as { text: string }).text ?? "").trim();
  } catch { return "__error__"; }
}

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
    context: `Cara has already started searching for caregivers for ${d.seniorName ?? "a loved one"}. Before sending matches, Cara needs to ask a couple of quick questions. Introduce this warmly and ask if Cara can reach out to caregivers on the family's behalf to schedule interviews once they select someone.`,
    fallback: `I'm already searching for caregivers for ${d.seniorName ?? "your loved one"}. Before I send you matches, two quick questions so I know how to best help you.\n\nCan I reach out to caregivers on your behalf to schedule interviews once you select someone?`,
  });
  await sendMessage(chatId, `${msgPerm1}\n\nReply YES or NO`);
}

export async function handleClientPermissionsReply(
  phone:   string,
  chatId:  string,
  text:    string,
  session: AgentSession,
  userId:  string
): Promise<void> {
  const norm  = text.trim().toUpperCase();
  const step  = (session as any).onboardingStep ?? "";
  const isYes = norm === "YES" || norm === "Y";

  if (step === "client_permissions_contact") {
    await setPermissions(phone, userId, "client", {
      canContactCaregivers:  isYes,
      canScheduleInterviews: isYes,
    });
    await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "client_permissions_booking" });
    const msgPerm2 = await generateCaraMessage({
      audience: "family",
      context: "Cara just received the family's answer about scheduling interviews. Acknowledge their reply, then ask: once they've approved a caregiver after an interview, can Cara book the first visits for them? Mention that Cara will always show exactly what's being booked and wait for confirmation before scheduling anything.",
      fallback: "Got it.\n\nOnce you've approved a caregiver after an interview, can I book their first visits for you? I'll always show you exactly what I'm booking and wait for your confirmation before anything is scheduled.",
    });
    await sendMessage(chatId, `${msgPerm2}\n\nReply YES or NO`);
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
      context: "Cara just received the family's answer about booking visits. Acknowledge, then ask: for recurring visits with a caregiver they've already approved, can Cara book automatically without checking each time?",
      fallback: "Got it.\n\nOne more thing — for recurring visits with a caregiver you've already approved, can I go ahead and book automatically without checking each time?",
    });
    await sendMessage(chatId,
      `${msgPerm3}\n\n` +
      `1️⃣ Yes, book automatically\n` +
      `2️⃣ No, always ask me first`
    );
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
      context: `Cara just finished the permissions setup for a family. They ${isYes ? "said YES to automatic booking" : "said NO — they want to make final calls themselves"}. Send a warm closing message acknowledging their choice, let them know Cara is still searching and will text the top caregiver matches within the hour, and invite them to text anytime with questions.`,
      fallback: `Perfect. I'll handle all the coordination${isYes ? " and book automatically" : " — you make the final calls"}.\n\nI'm still searching for caregivers — I'll text you the top matches within the hour.\n\nQuestions? Just text me anytime.`,
    });
    await sendMessage(chatId, msgPerm4);

    // Kick off matching
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
    context: `Cara is starting the permissions setup for caregiver ${caregiverName}. Ask a couple of quick questions so Cara can work best for them. First question: can Cara automatically decline job requests that are outside their stated availability? Mention it saves them time on requests they can't take.`,
    fallback: `A couple of quick questions so I can work best for you, ${caregiverName}:\n\nCan I automatically decline job requests that are outside your stated availability?\n(Saves you time on requests you can't take)`,
  });
  await sendMessage(chatId, `${msgPerm5}\n\nReply YES or NO`);
}

export async function handleCaregiverPermissionsReply(
  phone:       string,
  chatId:      string,
  text:        string,
  session:     AgentSession,
  caregiverId: string
): Promise<void> {
  const norm  = text.trim().toUpperCase();
  const step  = (session as any).onboardingStep ?? "";
  const isYes = norm === "YES" || norm === "Y";
  const d     = session.onboardingData ?? {};

  if (step === "caregiver_permissions_decline") {
    await setPermissions(phone, caregiverId, "caregiver", {
      canDeclineJobsAutomatically: isYes,
    });
    await db.collection("agent_sessions").doc(phone).update({ onboardingStep: "caregiver_permissions_arrival" });
    const msgPerm6 = await generateCaraMessage({
      audience: "caregiver",
      context: "Cara just received a caregiver's answer about auto-declining jobs. Acknowledge it, then ask: when they arrive at a client's home, would they like Cara to automatically notify the family? Families love knowing their caregiver has arrived.",
      fallback: "Got it.\n\nWhen you arrive at a client's home, want me to automatically notify the family?\nThey love knowing their caregiver has arrived.",
    });
    await sendMessage(chatId, `${msgPerm6}\n\nReply YES or NO`);
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
      context: `Caregiver ${d.name ? String(d.name) : ""}${city ? ` based${city}` : ""} just completed onboarding and permissions setup. Their profile is now live and they're ready to be matched with families. Celebrate this warmly, let them know what happens next (Cara will text job details when a family needs someone with their skills, including the care plan and directions before every visit).`,
      fallback: `You're all set${name}! Your profile is live and you're ready to be matched with families${city}.\n\nWhen a family needs someone with your skills, I'll text you the job details — including the care plan and directions before every visit.`,
    });
    await sendMessage(chatId, `${msgPerm7}\n\nView your profile: ${appUrl}/caregiver/${caregiverId}`);

    // Notify admin for final review
    await db.collection("admin_alerts").add({
      type:        "caregiver_pending_review",
      caregiverId,
      name:        d.name,
      phone,
      createdAt:   new Date().toISOString(),
      resolved:    false,
    });
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
