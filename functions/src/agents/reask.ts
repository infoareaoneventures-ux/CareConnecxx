// "Sorry, I'm not sure I followed. <the same question>" — sent once, never twice.
//
// All thirteen scripted flows answer a reply they can't read by repeating their question. Said twice in a row that is a broken
// record (live 2026-11-23: the same canned line three times, then a made-up reply). The first miss keeps the familiar wording
// exactly; the second asks it a simpler way and shows the way out; from the third on it stops asking and says how to stop or
// carry on, so a person is never handed the same sentence again.
import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";

const WINDOW_MS = 5 * 60_000;

export type ReaskStage = 1 | 2 | 3;

export function reaskText(stage: ReaskStage, didntCatch: string, question: string): string {
  if (stage === 1) return `${didntCatch} ${question}`;
  if (stage === 2) return `That's still not clear to me, so let me ask it a simpler way. ${question} (Reply "cancel" to stop.)`;
  return `Let's pause this one so I don't keep asking. Say "cancel" to stop, or tell me the answer in a few words whenever you're ready.`;
}

/** How many times in a row (within five minutes) this chat has been re-asked THIS question, counting this one. */
export function nextReaskStage(prev: { q?: unknown; n?: unknown; at?: unknown } | undefined, question: string, now: number): ReaskStage {
  const same = prev && prev.q === question && typeof prev.n === "number" && typeof prev.at === "number" && now - (prev.at as number) < WINDOW_MS;
  const n = same ? (prev!.n as number) + 1 : 1;
  return (n >= 3 ? 3 : n) as ReaskStage;
}

/** Send the re-ask for `question`, escalating if this chat has just been re-asked the same thing. Fails open to the plain first wording. */
export async function reaskOnce(chatId: string, didntCatch: string, question: string): Promise<void> {
  let stage: ReaskStage = 1;
  try {
    const ref = admin.firestore().collection("flow_reask").doc(chatId);
    const snap = await ref.get();
    const now = Date.now();
    stage = nextReaskStage(snap.exists ? (snap.data() as Record<string, unknown>) : undefined, question, now);
    const n = stage === 3 ? ((snap.exists && typeof snap.data()?.n === "number" ? (snap.data()!.n as number) : 2) + 1) : stage;
    await ref.set({ q: question, n, at: now });
  } catch { /* fail open: the plain first-time wording */ }
  await sendMessage(chatId, reaskText(stage, didntCatch, question));
}
