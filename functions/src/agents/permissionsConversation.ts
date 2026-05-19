import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import { sendMessage, AgentSession } from "../linq/client";

let _claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!_claude) _claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _claude;
}

async function askClaude(system: string, userText: string): Promise<string> {
  try {
    const res = await getClaude().messages.create({
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

  await sendMessage(chatId,
    `I'm already searching for caregivers for ${d.seniorName ?? "your loved one"}.\n\n` +
    `Before I send you matches, two quick questions so I know how to best help you.\n\n` +
    `Can I reach out to caregivers on your behalf to schedule interviews once you select someone?\n\n` +
    `Reply YES or NO`
  );
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
    await sendMessage(chatId,
      `Got it.\n\n` +
      `Once you've approved a caregiver after an interview, can I book their first visits for you?\n` +
      `I'll always show you exactly what I'm booking and wait for your confirmation before anything is scheduled.\n\n` +
      `Reply YES or NO`
    );
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
    await sendMessage(chatId,
      `Got it.\n\n` +
      `One more thing — for recurring visits with a caregiver you've already approved, ` +
      `can I go ahead and book automatically without checking each time?\n\n` +
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
    await sendMessage(chatId,
      `Perfect. I'll handle all the coordination${isYes ? " and book automatically" : " — you make the final calls"}.\n\n` +
      `I'm still searching for caregivers — I'll text you the top matches within the hour.\n\n` +
      `Questions? Just text me anytime.`
    );

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
  await sendMessage(chatId,
    `A couple of quick questions so I can work best for you, ${caregiverName}:\n\n` +
    `Can I automatically decline job requests that are outside your stated availability?\n` +
    `(Saves you time on requests you can't take)\n\n` +
    `Reply YES or NO`
  );
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
    await sendMessage(chatId,
      `Got it.\n\n` +
      `When you arrive at a client's home, want me to automatically notify the family?\n` +
      `They love knowing their caregiver has arrived.\n\n` +
      `Reply YES or NO`
    );
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
    const appUrl  = process.env.APP_URL ?? "https://cara.app";
    const name    = d.name    ? `, ${d.name as string}` : "";
    const city    = d.city    ? ` in ${d.city as string}` : "";

    await sendMessage(chatId,
      `You're all set${name}! 🎉\n\n` +
      `Your profile is live and you're ready to be matched with families${city}.\n\n` +
      `When a family needs someone with your skills, I'll text you the job details — ` +
      `including the care plan and directions before every visit.\n\n` +
      `View your profile: ${appUrl}/caregiver/${caregiverId}`
    );

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
