import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "../linq/client";

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
    await sendMessage(chatId,
      `You're all set${d.name ? `, ${d.name as string}` : ""}.\n\n` +
      `Your profile is being reviewed — usually 24–48 hours.\n` +
      `I'll text you the moment you're approved and can start receiving job matches.\n\n` +
      `Questions? Just text me anytime.`
    );

    // Notify admin
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
  const lower = text.toLowerCase();

  const CLIENT_PERM_MAP: Record<string, keyof AgentPermissions> = {
    "weekly summar": "canSendWeeklyDigest",
    "weekly digest": "canSendWeeklyDigest",
    "health alert":  "canSendHealthAlerts",
    "book automaticall": "canBookAutomatically",
    "auto-book":     "canBookAutomatically",
    "auto book":     "canBookAutomatically",
  };

  const CAREGIVER_PERM_MAP: Record<string, keyof AgentPermissions> = {
    "auto-decline":      "canDeclineJobsAutomatically",
    "auto decline":      "canDeclineJobsAutomatically",
    "arrival notif":     "canSendArrivalNotifications",
    "share journal":     "canShareJournalWithFamily",
  };

  const turnOff = /stop|don't|dont|disable|turn off|no more/i.test(text);
  const turnOn  = /start|enable|turn on/i.test(text);
  const newVal  = turnOff ? false : turnOn ? true : null;
  if (newVal === null) return;

  const map = userType === "client" ? CLIENT_PERM_MAP : CAREGIVER_PERM_MAP;
  let matched: keyof AgentPermissions | null = null;
  for (const [keyword, field] of Object.entries(map)) {
    if (lower.includes(keyword)) { matched = field; break; }
  }

  if (!matched) return;

  const ref  = db.collection("agent_permissions").doc(userId);
  await ref.set({ [matched]: newVal, updatedAt: new Date().toISOString() }, { merge: true });

  const friendly: Record<string, string> = {
    canSendWeeklyDigest:         "weekly summaries",
    canSendHealthAlerts:         "health alerts",
    canBookAutomatically:        "automatic booking",
    canDeclineJobsAutomatically: "auto-declining jobs outside your availability",
    canSendArrivalNotifications: "arrival notifications",
    canShareJournalWithFamily:   "sharing journal entries with families",
  };

  const label = friendly[matched as string] ?? matched;
  if (newVal === false) {
    await sendMessage(chatId,
      `Got it. No more ${label}. Just text me if you change your mind.`
    );
  } else {
    const resumeLabel = label.includes("book") ? "asking before booking" : `sending ${label} again`;
    await sendMessage(chatId, `Sure thing. I'll go back to ${resumeLabel}.`);
  }
}
