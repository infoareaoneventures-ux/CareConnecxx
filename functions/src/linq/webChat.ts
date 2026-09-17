// Web → Evia unified-thread turn (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md, U2).
//
// Ordered send invariant: rate check → resolve session → onboarding guard →
// idempotency claim → per-phone lock → FRESH session re-read (opt-out + chatId
// recomputed post-lock; active-SMS-flow guard) → await user-message mirror →
// agent → (skipSend branch only) manual reply mirror → release lock.
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
  status:       "ok" | "rateLimited" | "notSetUp" | "finishSetup" | "caraBusy" | "smsFlowActive" | "duplicate";
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
  // Re-bound to a fresh re-read after the lock is held (see the TOCTOU note at
  // the lock site); the pre-lock copy is used only for the identity / onboarding
  // guards, which are stable across the ~3s the lock can take to resolve.
  let session = sessionSnap.data()!;

  // Bind the resolved phone session to the authenticated Firebase identity.
  // users/{uid}.phone is owner-editable legacy data, so it cannot authorize a
  // session by itself. A missing binding may self-heal only when Firebase Auth
  // supplied the verified phone_number claim for this exact phone.
  if (session.userId !== uid) {
    if (!session.userId && tokenPhone === phone) {
      await sessionRef.update({ userId: uid });
      session.userId = uid;
    } else {
      console.error("webChat: auth/session identity mismatch", {
        uid,
        hasTokenPhone: Boolean(tokenPhone),
        sessionHasUserId: Boolean(session.userId),
      });
      return {
        available: false,
        status: "notSetUp",
        reply: "Please complete your account setup to chat with Evia.",
      };
    }
  }

  // Mid-onboarding conversations are driven by the onboarding flow on the SMS
  // path; running the QA agent here would advance a parallel conversation and
  // clobber session flags. The web thread stays read-only until setup is done.
  // Completed sessions carry onboardingStep: "complete" PERMANENTLY, so only a
  // set-and-not-"complete" step is mid-onboarding — same canonical test the SMS
  // router uses (webhooks.ts:1435). Legacy sessions with no onboardingStep at
  // all are treated as done.
  if (session.onboardingStep && session.onboardingStep !== "complete") {
    return {
      available: false,
      status:    "finishSetup",
      reply:     "Finish setting up with Evia over text first — this chat unlocks right after.",
    };
  }

  // R1 (memory-grounding U2): the turn is ACCEPTED — rate, session, identity
  // binding, and onboarding guards all passed. Mark session activity for
  // nightly memory selection now, BEFORE the model runs, so an agent failure
  // still leaves the turn counted. Best-effort inside markSessionActivity; the
  // rejected paths above must never reach this line.
  const { markSessionActivity } = await import("../memory/conversationMemory");
  await markSessionActivity(phone, db);

  // NOTE: optedOut / chatId are deliberately NOT captured here — they are
  // recomputed from the FRESH post-lock re-read below. A STOP processed while
  // this turn waited on the lock must flip the send off (TCPA), and a chatId
  // that appeared/vanished mid-wait must be honored.

  // ── Turn idempotency (U3) ──────────────────────────────────────────────────
  // A retried web turn (same clientMessageId) must not re-run a turn that fired
  // side effects or double-send SMS. Validate the id at the callable boundary —
  // a crafted id with "/" would break ref.create() and the fail-open catch would
  // silently disable idempotency — and treat a present-but-malformed id like a
  // missing one (bypass the ledger; never block the turn). Claim BEFORE the lock
  // so a duplicate short-circuits without contending. The claim is released on
  // EVERY pre-agent early return so a same-id retry is not wedged for 10 minutes.
  const { claimWebhookEvent, settleWebhookEvent, WEB_TURN_CLAIMS_COLLECTION } =
    await import("../utils/webhookLedger");
  const claimKey =
    clientMessageId && /^[A-Za-z0-9_.-]{1,200}$/.test(clientMessageId)
      ? `${phone}_${clientMessageId}`
      : undefined;
  const releaseClaim = async () => {
    if (claimKey) await settleWebhookEvent(WEB_TURN_CLAIMS_COLLECTION, claimKey, "failed");
  };
  if (claimKey) {
    const claim = await claimWebhookEvent(WEB_TURN_CLAIMS_COLLECTION, claimKey);
    if (claim === "duplicate") {
      // Deterministic response, no agent run, no send (ONE VOICE — a retry must
      // not produce a second SMS). Status "duplicate" (NOT "ok"): the client's
      // "ok" branch waits for a mirrored doc that will never arrive on this
      // path — the UI must clear its pending bubble and show the reply as a
      // notice instead of dead air.
      return {
        available:   true,
        status:      "duplicate",
        reply:       "I already got that one — no need to resend.",
        showMatches: false,
        toolsCalled: [],
        ...(session.optedOut === true ? { optedOut: true } : {}),
        ...withId,
      };
    }
  }

  // Serialize with SMS turns: claim the same per-phone lock the Linq webhook
  // holds, so a web send and a simultaneous text can't race on session state.
  const { claimInboundProcessing, releaseInboundProcessing, hasActiveSmsFlow, describeInterruptedFlow } =
    await import("../utils/sessionState");
  let locked = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !locked; attempt++) {
    locked = await claimInboundProcessing(phone, db);
    if (!locked) await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
  if (!locked) {
    await releaseClaim(); // same-id retry must not be blocked for the stale window
    return {
      available: true,
      status:    "caraBusy",
      reply:     "Evia is still replying to your last message — try again in a moment.",
      ...withId,
    };
  }

  const toolsCalled: string[] = [];
  try {
    // ── Post-lock fresh re-read (TOCTOU) ─────────────────────────────────────
    // The pre-lock snapshot was read ~3s before the lock resolved; an SMS turn
    // can set a flag (or process a STOP) in that window. Re-read now, INSIDE
    // the try — a throw here must not leak the lock or the claim (the catch
    // deletes the zero-tool claim, the finally releases the lock).
    session = (await sessionRef.get()).data() ?? session;

    // Recompute send facts from the FRESH session: a STOP processed while this
    // turn waited on the lock must kill the Linq send (TCPA), so the pre-lock
    // optedOut/chatId must never be trusted here.
    const optedOut = session.optedOut === true;
    const chatId   = (session.chatId as string | undefined) ?? "";

    // ── Active-SMS-flow guard (U2), evaluated on the fresh re-read ──────────
    // Defer if a fresh flow is in flight. Read-only — the web path never
    // clears or stamps flags.
    if (hasActiveSmsFlow(session)) {
      // Release the CLAIM first — its stale window (10 min) dwarfs the lock's
      // 90s TTL, so the expensive resource goes first. The finally below then
      // releases the lock exactly once.
      await releaseClaim();
      const flow = describeInterruptedFlow(session);
      return {
        available: true,
        status:    "smsFlowActive",
        reply:     flow
          ? `Looks like we're in the middle of ${flow} over text — let's finish that there, then this chat picks right back up.`
          : "We've got something in progress over text right now — let's wrap that up there first, then I'm all yours here.",
        showMatches: false,
        ...(optedOut ? { optedOut: true } : {}),
        ...withId,
      };
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
      // HELP sent a reply (side effect); a retry must not re-send it.
      if (claimKey) await settleWebhookEvent(WEB_TURN_CLAIMS_COLLECTION, claimKey, "processed");
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
        // U4: web turn identity for lifecycle checkpoints (only when the
        // client sent a stable message id — retried turns share it).
        ...(clientMessageId
          ? { sourceTurn: { conversationId: chatId || uid, messageId: clientMessageId } }
          : {}),
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

    // ── Completed-turn memory parity (memory-grounding plan U3, R8/R9) ──────
    // Web turns now share the SMS default tail's ONE persistence boundary:
    // persistCompletedTurn ADOPTS the durable history pair qaAgent already
    // wrote (saveConversationTurn), creates the reference-only turn_sync
    // operation keyed on the validated clientMessageId, and the worker
    // dispatches the Zep transcript + client-only learned-fact extraction.
    // Typed non-throwing outcome: a persistence failure must never fail a
    // reply that already went out, and never re-drives committed tools (R8).
    if (reply?.trim()) {
      const { persistCompletedTurn } = await import("../memory/conversationMemory");
      const persisted = await persistCompletedTurn({
        channel:       "web",
        // claimKey exists only for a validated clientMessageId — reuse that
        // judgment; an invalid/missing id gets no idempotency promise.
        sourceKey:     claimKey ? clientMessageId! : "",
        phone,
        userId:        (session.userId as string | undefined) ?? uid,
        userText:      message,
        assistantText: reply,
        // R8 parity with the SMS tail: family-fact extraction is CLIENT-only.
        extractFacts:  session.userType !== "caregiver",
        adoptExistingRows: true,
      }).catch((err: unknown) => ({
        ok: false as const,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      }));
      if (!persisted.ok) {
        // R21: aggregate/enum-only log — channel + error class, nothing else.
        console.warn(JSON.stringify({
          memory_turn_persistence_skipped: true,
          channel:     "web",
          error_class: persisted.errorClass,
          timestamp:   new Date().toISOString(),
        }));
      }
    }

    const MATCH_TOOLS  = new Set(["find_nearby_caregivers", "get_callout_backups"]);
    const showMatches  = toolsCalled.some((t) => MATCH_TOOLS.has(t));

    // Turn succeeded: stamp the claim permanent so a retry short-circuits.
    if (claimKey) await settleWebhookEvent(WEB_TURN_CLAIMS_COLLECTION, claimKey, "processed");

    return {
      available:   true,
      status:      "ok",
      reply,
      showMatches,
      toolsCalled,
      ...(optedOut ? { optedOut: true } : {}),
      ...withId,
    };
  } catch (err) {
    // Agent turns are NOT internally idempotent. If a WRITE tool executed before
    // the failure, booking/SMS side effects may already be committed — settle
    // "processed" so a same-id retry returns the deterministic duplicate reply
    // instead of re-firing them. Read-only tools (get_* / list_*) have no side
    // effects, so a failure after ONLY reads deletes the claim — the retry can
    // safely reprocess instead of the user being stonewalled with a duplicate
    // notice for a turn that never answered. Then rethrow the original error
    // unchanged (AgentUnavailableError for the qaAgent case) — the caller's
    // contract.
    if (claimKey) {
      const firedSideEffects = toolsCalled.some((t) => !/^(get_|list_)/.test(t));
      await settleWebhookEvent(
        WEB_TURN_CLAIMS_COLLECTION,
        claimKey,
        firedSideEffects ? "processed" : "failed",
      );
    }
    throw err;
  } finally {
    await releaseInboundProcessing(phone, db);
  }
}
