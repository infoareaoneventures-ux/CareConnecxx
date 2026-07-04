// Evia commitment tracker — the guarantee behind "I'll get back to you."
//
// Every place Evia promises the user a follow-up ("I flagged it so it does
// not get lost", "I'll text you top matches within the hour") records a
// commitment here. The trigger engine sweeps overdue commitments every 5
// minutes and either fulfills the promise (re-runs the answer / matching
// pass) or sends an honest escalation and a high-severity admin alert. A
// promise is never dropped silently.
//
// Invariants:
//   • One open commitment per (phone, kind) — the doc ID is `${phone}_${kind}`,
//     so repeated failures dedupe into the earliest promise instead of
//     stacking new ones (this also breaks the failure→promise→failure loop).
//   • The sweep queries the single `sweepAfter` field, which is removed on
//     resolution — no composite index required.
//   • One automated re-attempt per commitment. If that also fails, a human
//     takes over: the user gets an honest message and ops gets a `high`
//     admin_alert. Silence is never an outcome.

import * as admin from "firebase-admin";

const db = admin.firestore();

export type CommitmentKind = "qa_answer" | "matching";

// Shared fallback copy. qaAgent sends these; the sweep compares a re-run's
// reply against them to know whether it produced a real answer or another stall.
export const SNAG_ANSWER_COPY =
  "I hit a snag answering that, and I flagged it so it does not get lost.";
export const CHECKING_COPY =
  "I'm checking that now and will text you here with the answer.";

export interface PendingCommitment {
  phone:        string;
  chatId:       string;
  kind:         CommitmentKind;
  /** What Evia told the user (the promise being tracked). */
  promiseText:  string;
  /** qa_answer: the original user text to re-run through the QA agent. */
  question?:    string;
  userId?:      string;
  seniorId?:    string;
  userType?:    "client" | "caregiver";
  caregiverId?: string;
  zepThreadId?: string;
  /** Code path that made the promise, e.g. "qaAgent:catch". */
  source:       string;
  status:       "open" | "fulfilled" | "escalated" | "cancelled";
  attempts:     number;
  createdAt:    string;
  dueAt:        string;
  /** Present only while open — the sweep's single-field range query key. */
  sweepAfter?:  string;
  lastAttemptAt?: string;
  resolvedAt?:  string;
  resolution?:  string;
}

function commitmentDocId(phone: string, kind: CommitmentKind): string {
  // Phones are E.164 ("+14085551234") — safe as a Firestore doc ID segment.
  return `${phone}_${kind}`;
}

const normalizeQuestion = (t: string): string => t.trim().toLowerCase().slice(0, 500);

/**
 * Record a follow-up promise. Never throws — returns the commitment doc ID,
 * or null if the write failed (callers should then avoid promising copy).
 * If an open commitment already exists for this (phone, kind), it is kept
 * as-is (earliest promise wins) and its ID is returned.
 */
export async function recordCommitment(input: {
  phone:        string;
  chatId:       string;
  kind:         CommitmentKind;
  promiseText:  string;
  source:       string;
  dueInMs:      number;
  question?:    string;
  userId?:      string;
  seniorId?:    string;
  userType?:    "client" | "caregiver";
  caregiverId?: string;
  zepThreadId?: string;
}): Promise<string | null> {
  try {
    const id  = commitmentDocId(input.phone, input.kind);
    const ref = db.collection("pending_commitments").doc(id);
    const existing = await ref.get();
    if (existing.exists && existing.data()?.status === "open") return id;

    const now   = new Date();
    const dueAt = new Date(now.getTime() + input.dueInMs).toISOString();
    const doc: PendingCommitment = {
      phone:       input.phone,
      chatId:      input.chatId,
      kind:        input.kind,
      promiseText: input.promiseText.slice(0, 300),
      source:      input.source,
      status:      "open",
      attempts:    0,
      createdAt:   now.toISOString(),
      dueAt,
      sweepAfter:  dueAt,
      // Firestore rejects undefined values — add optional fields conditionally.
      ...(input.question    ? { question: input.question.slice(0, 500) } : {}),
      ...(input.userId      ? { userId: input.userId }           : {}),
      ...(input.seniorId    ? { seniorId: input.seniorId }       : {}),
      ...(input.userType    ? { userType: input.userType }       : {}),
      ...(input.caregiverId ? { caregiverId: input.caregiverId } : {}),
      ...(input.zepThreadId ? { zepThreadId: input.zepThreadId } : {}),
    };
    await ref.set(doc);
    return id;
  } catch (err) {
    console.error("[commitmentTracker] recordCommitment failed:", err);
    return null;
  }
}

/** Mark the open commitment for (phone, kind) fulfilled. Never throws. */
export async function resolveCommitment(
  phone: string,
  kind: CommitmentKind,
  resolution = "fulfilled"
): Promise<void> {
  try {
    const ref  = db.collection("pending_commitments").doc(commitmentDocId(phone, kind));
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.status !== "open") return;
    await ref.update({
      status:     "fulfilled",
      resolution,
      resolvedAt: new Date().toISOString(),
      sweepAfter: admin.firestore.FieldValue.delete(),
    });
  } catch (err) {
    console.error("[commitmentTracker] resolveCommitment failed:", err);
  }
}

/**
 * Resolve the open qa_answer commitment if the question just answered matches
 * the committed one (the qa_retry trigger re-enters runQaAgent with identical
 * text, so a successful retry resolves its own commitment here).
 */
export async function resolveIfMatchingQuestion(phone: string, answeredText: string): Promise<void> {
  try {
    const ref  = db.collection("pending_commitments").doc(commitmentDocId(phone, "qa_answer"));
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.status !== "open") return;
    const committed = (snap.data()?.question ?? "") as string;
    if (committed && normalizeQuestion(committed) === normalizeQuestion(answeredText)) {
      await ref.update({
        status:     "fulfilled",
        resolution: "answered",
        resolvedAt: new Date().toISOString(),
        sweepAfter: admin.firestore.FieldValue.delete(),
      });
    }
  } catch (err) {
    console.error("[commitmentTracker] resolveIfMatchingQuestion failed:", err);
  }
}

// ── Sweep — called from runTriggerEngine every 5 minutes ─────────────────────

export async function sweepOverdueCommitments(): Promise<void> {
  const nowIso = new Date().toISOString();
  const snap = await db.collection("pending_commitments")
    .where("sweepAfter", "<=", nowIso)
    .limit(10)
    .get();
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const c = doc.data() as PendingCommitment;
    try {
      if (c.status !== "open") {
        // Stale sweep marker on an already-resolved doc — clear it.
        await doc.ref.update({ sweepAfter: admin.firestore.FieldValue.delete() });
        continue;
      }

      const sessionSnap = await db.collection("agent_sessions").doc(c.phone).get();
      const session = (sessionSnap.data() ?? {}) as Record<string, unknown>;
      if (session.optedOut) {
        await doc.ref.update({
          status:     "cancelled",
          resolution: "user_opted_out",
          resolvedAt: nowIso,
          sweepAfter: admin.firestore.FieldValue.delete(),
        });
        continue;
      }

      // Fulfilled by another path since the promise was made?
      if (c.kind === "matching") {
        const setAt = session.pendingMatchesSetAt as string | undefined;
        if (setAt && setAt > c.createdAt) {
          await markFulfilled(doc.ref, "matches_already_sent");
          continue;
        }
      }

      // One automated re-attempt per commitment; after that a human takes over.
      if ((c.attempts ?? 0) >= 1) {
        if (c.kind === "qa_answer" && !(await isFollowUpStillOwed(c))) {
          await markFulfilled(doc.ref, "resolved_in_conversation");
          continue;
        }
        await escalateCommitment(doc.ref, c);
        continue;
      }

      // Claim the attempt BEFORE running so a crash mid-attempt cannot loop —
      // if this attempt hangs or dies, the next sweep escalates instead.
      await doc.ref.update({
        attempts:      admin.firestore.FieldValue.increment(1),
        lastAttemptAt: nowIso,
        sweepAfter:    new Date(Date.now() + 10 * 60_000).toISOString(),
      });

      if (c.kind === "matching") {
        await attemptMatchingFulfillment(doc.ref, c, session);
      } else {
        await attemptAnswerFulfillment(doc.ref, c, session);
      }
    } catch (err) {
      console.error(`[commitmentTracker] sweep failed for ${doc.id}:`, err);
    }
  }
}

// ── Dropped-turn watchdog ────────────────────────────────────────────────────
// webhooks.ts stamps turn_watch/{chatId} on every inbound; any outbound send
// to that chat deletes it (linq/client.ts sendOneMessage). A marker that
// survives past dueAt means the user texted and got NOTHING back — the case
// the webhook-retry safety net misses when the turn dies after the 200-ack.
// Convert it into a tracked qa_answer commitment (due immediately) so the
// normal commitment machinery re-answers or escalates.

export async function sweepDroppedTurns(): Promise<void> {
  const nowIso = new Date().toISOString();
  const snap = await db.collection("turn_watch")
    .where("dueAt", "<=", nowIso)
    .limit(10)
    .get();
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const w = doc.data() as {
      phone?: string; chatId?: string; text?: string;
      userId?: string | null; userType?: "client" | "caregiver";
    };
    try {
      if (w.phone && w.chatId) {
        const sessionSnap = await db.collection("agent_sessions").doc(w.phone).get();
        if (!sessionSnap.data()?.optedOut) {
          console.warn("[commitmentTracker] dropped turn detected — tracking commitment", {
            phone: w.phone, preview: (w.text ?? "").slice(0, 60),
          });
          await recordCommitment({
            phone:       w.phone,
            chatId:      w.chatId,
            kind:        "qa_answer",
            promiseText: "(dropped turn — user got no reply)",
            question:    w.text || "(the user's last message)",
            ...(w.userId ? { userId: w.userId } : {}),
            ...(w.userType ? { userType: w.userType } : {}),
            source:      "turnWatch:dropped_turn",
            dueInMs:     0, // already overdue — next sweep acts immediately
          });
        }
      }
    } catch (err) {
      console.error(`[commitmentTracker] sweepDroppedTurns failed for ${doc.id}:`, err);
    } finally {
      // Always consume the marker — a failed conversion must not loop forever.
      await doc.ref.delete().catch(() => {});
    }
  }
}

async function markFulfilled(
  ref: FirebaseFirestore.DocumentReference,
  resolution: string
): Promise<void> {
  await ref.update({
    status:     "fulfilled",
    resolution,
    resolvedAt: new Date().toISOString(),
    sweepAfter: admin.firestore.FieldValue.delete(),
  });
}

// Re-run the matching pass. runMatchingForClient messages the user in every
// internal path (matches gallery OR the honest no-match message) except its
// own catch, which returns "failed" — in that case it has renewed the promise
// itself (with a fresh tracked commitment via dedupe), and the NEXT sweep
// escalates to a human since attempts >= 1.
async function attemptMatchingFulfillment(
  ref: FirebaseFirestore.DocumentReference,
  c: PendingCommitment,
  session: Record<string, unknown>
): Promise<void> {
  const { runMatchingForClient } = await import("./matchingAgent");
  const result = await runMatchingForClient(c.phone, c.chatId, session, session)
    .catch((err: unknown) => {
      console.error("[commitmentTracker] matching re-attempt threw:", err);
      return "failed" as const;
    });
  if (result === "failed") return; // stays open; escalated on the next sweep
  await markFulfilled(ref, result === "matched" ? "matches_sent" : "no_match_handled");
}

// Re-run the original question through the QA agent with skipSend so this
// sweep fully controls what the user receives: a real answer is delivered,
// another stall/snag is NOT re-sent — it escalates to a human instead.
async function attemptAnswerFulfillment(
  ref: FirebaseFirestore.DocumentReference,
  c: PendingCommitment,
  session: Record<string, unknown>
): Promise<void> {
  if (!(await isFollowUpStillOwed(c))) {
    await markFulfilled(ref, "resolved_in_conversation");
    return;
  }

  const { runQaAgent, sendSplit } = await import("./qaAgent");
  try {
    const reply = await runQaAgent({
      text:     c.question ?? c.promiseText,
      phone:    c.phone,
      chatId:   c.chatId,
      userId:   c.userId ?? ((session.userId as string) ?? ""),
      seniorId: c.seniorId ?? ((session.seniorId as string) ?? ""),
      userType: c.userType ?? ((session.userType as "client" | "caregiver") ?? "client"),
      ...(c.caregiverId ? { caregiverId: c.caregiverId } : {}),
      ...(c.zepThreadId ? { zepThreadId: c.zepThreadId } : {}),
      session,
      isRetry:  true,
      skipSend: true,
      sourceChannel:
        "[SYSTEM: promised follow-up — you told the user you would get back to them " +
        "on this and have not yet. Answer it now, opening with a brief acknowledgment " +
        "that you are circling back.]",
    });

    const trimmed = (reply ?? "").trim();
    if (!trimmed || trimmed === SNAG_ANSWER_COPY || trimmed === CHECKING_COPY) {
      await escalateCommitment(ref, c);
      return;
    }
    await sendSplit(c.chatId, trimmed);
    await markFulfilled(ref, "answer_sent");
  } catch (err) {
    console.error("[commitmentTracker] answer re-attempt threw:", err);
    await escalateCommitment(ref, c);
  }
}

// Has the conversation since the promise already covered it? Cheap quick-tier
// YES/NO. Defaults to "still owed" on any failure — keeping the promise beats
// silence, and the QA re-run sees full history so it recovers gracefully.
async function isFollowUpStillOwed(c: PendingCommitment): Promise<boolean> {
  try {
    const msgs = await db.collection("agent_conversations").doc(c.phone)
      .collection("messages")
      .orderBy("timestamp", "desc")
      .limit(6)
      .get();
    const createdMs = new Date(c.createdAt).getTime();
    const since = msgs.docs
      .map((d) => d.data())
      .filter((m) => ((m.timestamp as number) ?? 0) > createdMs)
      .reverse();
    if (since.length === 0) return true; // nothing happened since the promise

    const { quickComplete } = await import("../utils/openaiClient");
    const transcript = since
      .map((m) => `${m.role}: ${String(m.content ?? "").slice(0, 200)}`)
      .join("\n");
    const verdict = await quickComplete(
      "Evia (a care assistant) promised to get back to a user about something and has not confirmed doing so.\n" +
        "Given the conversation since that promise, decide if the user STILL needs the follow-up.\n" +
        "Reply YES if the question/task was never actually addressed. Reply NO only if the conversation shows it was fully answered or is now moot.\n" +
        "One word: YES or NO.",
      `Promise: ${c.promiseText}\nOriginal question: ${c.question ?? "(unknown)"}\n\nConversation since:\n${transcript}`,
      { maxTokens: 3 }
    );
    return verdict.trim().toUpperCase() !== "NO";
  } catch {
    return true;
  }
}

// The automated attempts are exhausted — close out honestly: tell the user a
// real person is taking over, and page ops with a high-severity alert.
async function escalateCommitment(
  ref: FirebaseFirestore.DocumentReference,
  c: PendingCommitment
): Promise<void> {
  const now = new Date().toISOString();
  const content = c.kind === "matching"
    ? "I'm sorry — pulling caregiver matches is taking longer than I promised. " +
      "I've escalated this to our care team, and a real person will follow up with your matches shortly."
    : "I'm sorry — I still owe you an answer on what you asked earlier, and it's taking longer than it should. " +
      "I've escalated it to our care team, and a real person will follow up with you shortly.";

  try {
    const { sendViaInteractionAgent } = await import("./caraAgent");
    await sendViaInteractionAgent(c.phone, {
      content,
      urgency:     "standard",
      sourceAgent: "commitment_tracker",
      canDrop:     false,
    });
  } catch (err) {
    console.error("[commitmentTracker] escalation send failed:", err);
  }

  await db.collection("admin_alerts").add({
    type:        "commitment_unfulfilled",
    phone:       c.phone,
    userId:      c.userId ?? null,
    kind:        c.kind,
    promiseText: c.promiseText,
    question:    c.question ?? null,
    promisedAt:  c.createdAt,
    attempts:    c.attempts ?? 0,
    severity:    "high",
    createdAt:   now,
    resolved:    false,
  }).catch(() => {});

  await ref.update({
    status:     "escalated",
    resolution: "escalated_to_team",
    resolvedAt: now,
    sweepAfter: admin.firestore.FieldValue.delete(),
  });
}
