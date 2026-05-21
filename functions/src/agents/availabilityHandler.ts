import * as admin from "firebase-admin";
import { parseWithClaude } from "../utils/parseWithClaude";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

async function isQuestionOrOther(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    "Reply YES if this is a general question or off-topic comment unrelated to confirming a schedule change. Reply NO if it is a direct answer about whether to apply the schedule update. Only reply YES or NO.",
    text,
    5
  );
  return result.toUpperCase().startsWith("Y");
}

interface DaySlot { start: string; end: string; }
type WeeklyAvailability = Record<string, DaySlot[]>;

function formatAvailability(avail: WeeklyAvailability): string {
  const lines: string[] = [];
  for (const day of DAYS) {
    const slots = avail[day] ?? [];
    if (slots.length > 0) {
      const times = slots.map(s => `${s.start}–${s.end}`).join(", ");
      lines.push(`  ${day.charAt(0).toUpperCase() + day.slice(1)}: ${times}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "  (no availability set)";
}

/**
 * UPDATE_AVAILABILITY handler — caregiver updates their weekly schedule.
 *
 * Flow:
 *   start        → parse change from initial message, show proposed schedule, ask to confirm
 *   confirm      → YES applies update to Firestore; NO cancels
 */
export async function handleAvailabilityUpdate(
  caregiverId: string,
  phone:       string,
  text:        string,
  session:     Record<string, unknown>,
  sendMessage: (msg: string) => Promise<void>
): Promise<void> {
  const step = (session.availabilityStep as string) ?? "start";

  // ── start — parse the change and show the proposed schedule ──────────────
  if (step === "start") {
    // Load current availability
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    if (!cgSnap.exists) {
      await sendMessage("I couldn't find your caregiver profile. Please contact support.");
      return;
    }
    const current: WeeklyAvailability = (cgSnap.data()?.weeklyAvailability ?? {}) as WeeklyAvailability;

    // Claude parses the requested change into a JSON patch
    const raw = await parseWithClaude(
      `The caregiver wants to update their weekly availability schedule. ` +
      `Parse their message and return a JSON object describing the change. ` +
      `Current schedule (for reference): ${JSON.stringify(current)}. ` +
      `Return ONLY valid JSON with this shape: ` +
      `{"action":"add"|"remove"|"replace","days":["monday","tuesday",...],"slots":[{"start":"HH:MM","end":"HH:MM"}]}. ` +
      `"add" = add new time slots to those days. ` +
      `"remove" = remove availability on those days entirely. ` +
      `"replace" = replace the entire schedule for those days with the new slots. ` +
      `Use 24-hour time (e.g. 09:00, 17:00). ` +
      `If the caregiver says they are free all day on a given day, use 08:00–20:00. ` +
      `If you cannot parse a clear change, return {"action":"unclear"}.`,
      text,
      300
    );

    let parsed: { action: string; days?: string[]; slots?: DaySlot[] } = { action: "unclear" };
    try {
      const stripped = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(stripped);
    } catch { /* keep unclear */ }

    if (parsed.action === "unclear" || !Array.isArray(parsed.days) || parsed.days.length === 0) {
      await sendMessage(
        "I didn't quite catch the schedule change. Could you be more specific?\n\n" +
        "For example:\n" +
        "• \"Add Monday 9am–5pm\"\n" +
        "• \"Remove Fridays\"\n" +
        "• \"I'm free Tuesdays and Thursdays from 10am to 3pm\""
      );
      return;
    }

    // Build proposed new availability by applying the patch
    const proposed: WeeklyAvailability = JSON.parse(JSON.stringify(current));
    const validDays = parsed.days.map(d => d.toLowerCase()).filter(d => DAYS.includes(d));

    if (parsed.action === "remove") {
      for (const day of validDays) delete proposed[day];
    } else if (parsed.action === "add" && parsed.slots?.length) {
      for (const day of validDays) {
        proposed[day] = [...(proposed[day] ?? []), ...(parsed.slots ?? [])];
      }
    } else if (parsed.action === "replace") {
      for (const day of validDays) {
        proposed[day] = parsed.slots?.length ? parsed.slots : [];
        if (!proposed[day].length) delete proposed[day];
      }
    }

    // Persist the proposed update in session, then ask to confirm
    await db.collection("agent_sessions").doc(phone).update({
      availabilityStep:      "confirm",
      pendingAvailability:   JSON.stringify(proposed),
      stateExpiresAt:        new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const opener = await generateCaraMessage({
      audience:  "caregiver",
      context:   "Cara is about to show the caregiver their updated availability schedule for confirmation. Write a brief 1-sentence intro asking them to confirm it looks right.",
      fallback:   "Here's your updated schedule — does this look right?",
      maxTokens: 60,
    });

    await sendMessage(
      `${opener}\n\n` +
      formatAvailability(proposed) +
      `\n\nReply YES to save this schedule, or NO to cancel.`
    );
    return;
  }

  // ── confirm — apply update or cancel ─────────────────────────────────────
  if (step === "confirm") {
    const proposed = JSON.parse((session.pendingAvailability as string) ?? "{}") as WeeklyAvailability;

    if (await isQuestionOrOther(text)) {
      await sendMessage(
        `Your proposed schedule:\n\n` +
        formatAvailability(proposed) +
        `\n\nReply YES to save, or NO to cancel.`
      );
      return;
    }

    const decision = await parseWithClaude(
      '"yes", "yeah", "looks good", "correct", "that\'s right", "save it", "confirm", "go ahead" → YES. ' +
      '"no", "cancel", "never mind", "wait", "wrong", "change it", "nope" → NO. ' +
      'Reply with exactly YES or NO.',
      text,
      5
    );

    // Clear state regardless
    await db.collection("agent_sessions").doc(phone).update({
      availabilityStep:    admin.firestore.FieldValue.delete(),
      pendingAvailability: admin.firestore.FieldValue.delete(),
      stateExpiresAt:      admin.firestore.FieldValue.delete(),
    }).catch(() => {});

    if (decision === "YES") {
      await db.collection("caregivers").doc(caregiverId).update({
        weeklyAvailability: proposed,
        availabilityUpdatedAt: new Date().toISOString(),
      });

      const saveMsg = await generateCaraMessage({
        audience:  "caregiver",
        context:   "A caregiver just confirmed their updated availability schedule. Cara saved it. Write a warm 1-sentence confirmation.",
        fallback:   "Done — your availability has been updated.",
        maxTokens: 60,
      });
      await sendMessage(saveMsg);
    } else {
      const cancelMsg = await generateCaraMessage({
        audience:  "caregiver",
        context:   "A caregiver decided not to apply their proposed availability change. Write a brief 1-sentence acknowledgment and invite them to try again when they're ready.",
        fallback:   "No problem — your availability wasn't changed. Let me know whenever you'd like to update it.",
        maxTokens: 60,
      });
      await sendMessage(cancelMsg);
    }
    return;
  }
}
