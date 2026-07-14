import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

// ── inferActiveHours — learn each user's quiet window from behavior ────────────
//
// Quiet hours used to exist only if the user explicitly set them
// (update_preferences). This weekly job learns them: build an hour-of-day
// histogram of when each user actually sends messages (in their timezone) and,
// when there's a long contiguous stretch they have NEVER been active, record it
// as `inferredQuietHours` on user_preferences. isInDND honors the inferred
// window ONLY when explicit DND is off — user-set preferences always win, and
// the inferred field never touches dndEnabled/dndStart/dndEnd.

export const MIN_MESSAGES_FOR_INFERENCE = 20;
export const MIN_QUIET_RUN_HOURS = 6;
const SESSION_BATCH = 300;
const MESSAGES_PER_USER = 200;

/**
 * Pure: given a 24-slot count histogram, return the longest contiguous
 * (circular) run of zero-activity hours as an {start,end} HH:00 window, or
 * null when the longest run is under the minimum. `end` is exclusive.
 */
export function inferQuietWindow(hourCounts: number[]): { start: string; end: string } | null {
  if (hourCounts.length !== 24) return null;
  // Walk the circle twice to catch runs that wrap midnight.
  let bestStart = -1, bestLen = 0, runStart = -1, runLen = 0;
  for (let i = 0; i < 48; i++) {
    const h = i % 24;
    if (hourCounts[h] === 0) {
      if (runLen === 0) runStart = i;
      runLen++;
      // Cap at 24 — an all-quiet histogram is "no signal", not a 48h window.
      if (runLen > bestLen && runLen <= 24) { bestLen = runLen; bestStart = runStart; }
    } else {
      runLen = 0;
    }
  }
  if (bestLen >= 24) return null; // zero activity everywhere = no signal
  if (bestLen < MIN_QUIET_RUN_HOURS) return null;
  const startHour = bestStart % 24;
  const endHour   = (startHour + bestLen) % 24;
  const hh = (n: number) => `${String(n).padStart(2, "0")}:00`;
  return { start: hh(startHour), end: hh(endHour) };
}

/** Hour-of-day (0-23) of a ms timestamp in an IANA timezone. */
export function hourInTz(ms: number, timezone: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit", hour12: false, timeZone: timezone,
    }).formatToParts(new Date(ms)).find((p) => p.type === "hour")?.value ?? "0";
    return parseInt(h, 10) % 24;
  } catch {
    return new Date(ms).getUTCHours();
  }
}

export interface InferActiveHoursResult {
  scanned: number;
  inferred: number;
  skippedLowSignal: number;
}

export async function runInferActiveHours(): Promise<InferActiveHoursResult> {
  const db = admin.firestore();
  const result: InferActiveHoursResult = { scanned: 0, inferred: 0, skippedLowSignal: 0 };

  const sessions = await db.collection("agent_sessions").limit(SESSION_BATCH).get();
  for (const doc of sessions.docs) {
    const session = doc.data();
    if (session.optedOut) continue;
    const userId = (session.userId as string | undefined) ?? "";
    if (!userId) continue;
    result.scanned++;

    try {
      const prefSnap = await db.collection("user_preferences").doc(userId).get();
      const prefs = prefSnap.data() ?? {};
      const tz = (prefs.timezone as string | undefined) || "America/Los_Angeles";

      const msgs = await db.collection("agent_conversations").doc(doc.id)
        .collection("messages")
        .orderBy("timestamp", "desc")
        .limit(MESSAGES_PER_USER)
        .get();

      const hourCounts = new Array<number>(24).fill(0);
      let userMsgCount = 0;
      for (const m of msgs.docs) {
        const data = m.data();
        if (data.role !== "user") continue;
        const ts = data.timestamp as number | undefined;
        if (typeof ts !== "number") continue;
        hourCounts[hourInTz(ts, tz)]++;
        userMsgCount++;
      }

      if (userMsgCount < MIN_MESSAGES_FOR_INFERENCE) { result.skippedLowSignal++; continue; }

      const window = inferQuietWindow(hourCounts);
      if (!window) { result.skippedLowSignal++; continue; }

      await db.collection("user_preferences").doc(userId).set({
        inferredQuietHours: {
          ...window,
          basedOnMessages: userMsgCount,
          computedAt: new Date().toISOString(),
        },
      }, { merge: true });
      result.inferred++;
    } catch (err) {
      console.error(`[inferActiveHours] failed for ${doc.id}:`, err);
    }
  }

  console.log("[inferActiveHours]", result);
  return result;
}

// Weekly, Sunday 12:00 UTC — timing preferences drift slowly.
export const inferActiveHoursWeekly = functions.pubsub
  .schedule("0 12 * * 0")
  .onRun(async () => {
    await runInferActiveHours().catch((err) =>
      console.error("[inferActiveHours] run failed:", err)
    );
  });
