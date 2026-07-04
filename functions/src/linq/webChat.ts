// Web → Evia unified-thread turn (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md, U2).
//
// Ordered send invariant: rate check → resolve session → onboarding guard →
// opt-out check → per-phone lock → await user-message mirror → agent →
// (skipSend branch only) manual reply mirror → release lock.
//
// With a live Linq chat the agent runs WITHOUT skipSend, so sendSplit delivers
// the reply over SMS/iMessage and sendMessage auto-mirrors it into
// threads/cara_{uid} — one thread everywhere. Manual reply-mirroring on that
// branch is forbidden (double-write). Rejections before the mirror never leave
// an unanswered user bubble in the web thread.

import * as admin from "firebase-admin";

/** Thrown when the agent loop itself fails; the callable wrapper converts it
 *  to an HttpsError so the client sees a clean `internal` failure. */
export class AgentUnavailableError extends Error {
  constructor(public readonly clientMessageId?: string) {
    super("Evia agent turn failed");
    this.name = "AgentUnavailableError";
  }
}

export interface WebChatResult {
  available:    boolean;
  status:       "ok" | "rateLimited" | "notSetUp" | "finishSetup" | "caraBusy";
  reply:        string;
  rateLimited?: boolean;
  showMatches?: boolean;
  toolsCalled?: string[];
  optedOut?:    boolean;
  clientMessageId?: string;
}

const LOCK_ATTEMPTS      = 6;
const LOCK_RETRY_MS      = 500;
const RATE_WINDOW_MS     = 60_000;
const RATE_MAX_PER_WINDOW = 10;
// Server-side guard — the client trims/sanitizes, but the callable must not
// trust it. Caps agent-token and Firestore-write cost per message.
const MAX_MESSAGE_CHARS  = 2_000;

export async function handleWebChatTurn(args: {
  uid:              string;
  message:          string;
  tokenPhone?:      string;
  clientMessageId?: string;
}): Promise<WebChatResult> {
  const { uid, tokenPhone, clientMessageId } = args;
  const message = (args.message ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) throw new Error("message is required"); // callable wrapper validates; guard for direct callers
  const db = admin.firestore();
  const withId = clientMessageId ? { clientMessageId } : {};

  // Per-user sliding window. Runs before any thread write so a rate-limited
  // send never shows an unanswered bubble.
  const rateRef  = db.collection("rate_limits").doc(`web_${uid}`);
  const rateSnap = await rateRef.get();
  const now      = Date.now();
  const rateData = rateSnap.data() ?? { count: 0, windowStart: now };
  if (!rateSnap.exists || rateData.windowStart < now - RATE_WINDOW_MS) {
    // Fresh window (or first-ever call — update() on a missing doc throws).
    await rateRef.set({ count: 1, windowStart: now });
  } else if ((rateData.count as number) >= RATE_MAX_PER_WINDOW) {
    return {
      available:   true,
      status:      "rateLimited",
      rateLimited: true,
      reply:       "I'm getting a lot of messages right now — give me a moment before trying again.",
      showMatches: false,
      ...withId,
    };
  } else {
    await rateRef.update({ count: admin.firestore.FieldValue.increment(1) });
  }

  // Resolve phone: the OTP-verified token phone is authoritative (E.164);
  // the users-doc phone covers legacy accounts whose token lacks the claim.
  let phone = tokenPhone;
  if (!phone) {
    const userSnap = await db.collection("users").doc(uid).get();
    phone = userSnap.data()?.phone as string | undefined;
  }
  if (!phone) {
    return {
      available: false,
      status:    "notSetUp",
      reply:     "Please complete your account setup to chat with Evia.",
    };
  }

  const sessionRef  = db.collection("agent_sessions").doc(phone);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    return {
      available: false,
      status:    "notSetUp",
      reply:     "Your Evia account isn't set up yet. Finish onboarding first.",
    };
  }
  const session = sessionSnap.data()!;

  // Mid-onboarding conversations are driven by the onboarding flow on the SMS
  // path; running the QA agent here would advance a parallel conversation and
  // clobber session flags. The web thread stays read-only until setup is done.
  if (session.onboardingStep) {
    return {
      available: false,
      status:    "finishSetup",
      reply:     "Finish setting up with Evia over text first — this chat unlocks right after.",
    };
  }

  const optedOut = session.optedOut === true;
  const chatId   = (session.chatId as string | undefined) ?? "";

  // Serialize with SMS turns: claim the same per-phone lock the Linq webhook
  // holds, so a web send and a simultaneous text can't race on session state.
  const { claimInboundProcessing, releaseInboundProcessing } = await import("../utils/sessionState");
  let locked = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !locked; attempt++) {
    locked = await claimInboundProcessing(phone, db);
    if (!locked) await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
  if (!locked) {
    return {
      available: true,
      status:    "caraBusy",
      reply:     "Evia is still replying to your last message — try again in a moment.",
      ...withId,
    };
  }

  const toolsCalled: string[] = [];
  try {
    // Self-heal the caregiver session gap: web auth proves this uid owns the
    // phone, so a session missing userId gets it stamped here (keeps the
    // outbound auto-mirror working for caregivers onboarded before the fix).
    if (!session.userId) {
      await sessionRef.update({ userId: uid }).catch(() => {});
      session.userId = uid;
    }

    // Mirror the user's message BEFORE the agent runs so the reply always
    // lands after it. A retry with the same clientMessageId must not
    // duplicate the bubble.
    const { mirrorToWebThread } = await import("./threadMirror");
    let alreadyMirrored = false;
    if (clientMessageId) {
      const dup = await db.collection("threads").doc(`cara_${uid}`)
        .collection("messages")
        .where("clientMessageId", "==", clientMessageId)
        .limit(1)
        .get();
      alreadyMirrored = !dup.empty;
    }
    if (!alreadyMirrored) {
      await mirrorToWebThread({
        userId:    uid,
        direction: "inbound",
        text:      message,
        source:    "cara_web",
        clientMessageId,
      });
    }

    const deliverViaLinq = Boolean(chatId) && !optedOut;

    // ── /help: capability discovery (web parity with routeIntent.ts) ────────
    // The SMS path answers the exact-string commands via the classifier's
    // command bypass (intentClassifier.ts) -> routeIntent's HELP branch; the
    // web callable skips the classifier entirely and used to fall through to
    // the full agent loop. Answer the same way here: a static, side-effect-free,
    // role-aware capability reply. Only an exact match (trimmed, any case)
    // triggers it - "help me find a caregiver" still goes to the agent.
    const HELP_COMMANDS = new Set(["HELP", "/HELP", "CAPABILITIES", "/CAPABILITIES"]);
    if (HELP_COMMANDS.has(message.trim().toUpperCase())) {
      const { buildHelpSmsReply } = await import("../agents/capabilityDiscovery");
      const { loadCaraOperationalContext, buildOperationalRecipeLead } =
        await import("../agents/operationalContext");
      const role = session.userType === "caregiver"
        ? ("caregiver" as const)
        : session.isSecondaryMember
          ? ("family-secondary" as const)
          : ("client" as const);
      const ops = await loadCaraOperationalContext({
        phone,
        userId:      session.userId as string | undefined,
        caregiverId: session.caregiverId as string | undefined,
      }).catch(() => null);
      const helpReply = buildHelpSmsReply(
        role,
        ops ? buildOperationalRecipeLead(ops, role) : undefined,
        session.preferredLanguage === "es" ? "es" : "en",
      );
      if (deliverViaLinq) {
        // sendMessage auto-mirrors the outbound into threads/cara_{uid} - same
        // one-thread invariant as the agent branch. Manual mirror is forbidden here.
        const { sendMessage } = await import("./client");
        await sendMessage(chatId, helpReply);
      } else {
        await mirrorToWebThread({ userId: uid, direction: "outbound", text: helpReply, source: "cara_web" });
      }
      return {
        available:   true,
        status:      "ok",
        reply:       helpReply,
        showMatches: false,
        toolsCalled,
        ...(optedOut ? { optedOut: true } : {}),
        ...withId,
      };
    }

    const { runQaAgent } = await import("../agents/qaAgent");
    let reply: string;
    try {
      reply = await runQaAgent({
        text:          message,
        phone,
        chatId:        deliverViaLinq ? chatId : "",
        userId:        (session.userId as string | undefined) ?? uid,
        seniorId:      session.seniorId as string,
        zepThreadId:   session.zepThreadId as string | undefined,
        ...(session.userType === "caregiver"
          ? { userType: "caregiver" as const, caregiverId: session.caregiverId as string | undefined }
          : {}),
        session,
        skipSend:      !deliverViaLinq,
        _toolCallsOut: toolsCalled,
        sourceChannel: "[USER]",
      });
    } catch (err) {
      console.error("webChat: qaAgent threw", err);
      throw new AgentUnavailableError(clientMessageId);
    }

    // skipSend branch is the only place the reply is mirrored manually — the
    // Linq branch already mirrored it inside sendMessage.
    if (!deliverViaLinq && reply) {
      await mirrorToWebThread({ userId: uid, direction: "outbound", text: reply, source: "cara_web" });
    }

    const MATCH_TOOLS  = new Set(["find_replacement_caregivers", "request_booking"]);
    const showMatches  = toolsCalled.some((t) => MATCH_TOOLS.has(t));

    return {
      available:   true,
      status:      "ok",
      reply,
      showMatches,
      toolsCalled,
      ...(optedOut ? { optedOut: true } : {}),
      ...withId,
    };
  } finally {
    await releaseInboundProcessing(phone, db);
  }
}
