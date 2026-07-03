import * as admin from "firebase-admin";
import { parseWithClaude } from "../utils/parseWithClaude";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * Canonical time blocks — same as the UI grid.
 * Evia always asks caregivers to pick from these explicitly so there
 * is zero ambiguity and no approximate time-to-block mapping.
 */
const BLOCKS: Record<string, { start: string; end: string; label: string; hours: string }> = {
  morning:   { start: "06:00", end: "12:00", label: "Morning",   hours: "6am–12pm" },
  afternoon: { start: "12:00", end: "18:00", label: "Afternoon", hours: "12pm–6pm" },
  evening:   { start: "18:00", end: "23:00", label: "Evening",   hours: "6pm–11pm" },
  overnight: { start: "23:00", end: "06:00", label: "Overnight", hours: "11pm–6am" },
};
const BLOCK_IDS = ["morning", "afternoon", "evening", "overnight"] as const;
type BlockId = typeof BLOCK_IDS[number];

interface DaySlot { start: string; end: string; }
type WeeklyAvailability = Record<string, DaySlot[]>;

/** Convert block ID array → TimeSlot array for Firestore */
function blocksToSlots(blockIds: string[]): DaySlot[] {
  return blockIds.filter(id => BLOCKS[id]).map(id => ({ start: BLOCKS[id].start, end: BLOCKS[id].end }));
}

/** Convert stored TimeSlots → block IDs (handles both formats in Firestore) */
function slotsToBlocks(slots: DaySlot[]): BlockId[] {
  const active = new Set<BlockId>();
  const blockMins: Record<string, { s: number; e: number }> = {
    morning:   { s: 360,  e: 720  },
    afternoon: { s: 720,  e: 1080 },
    evening:   { s: 1080, e: 1380 },
    overnight: { s: 1380, e: 1440 },
  };
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  for (const slot of slots) {
    const s = toMin(slot.start);
    const eRaw = toMin(slot.end);
    const e = eRaw <= s ? eRaw + 1440 : eRaw;
    for (const b of BLOCK_IDS) {
      const r = blockMins[b];
      if (s < r.e && e > r.s) active.add(b);
    }
  }
  return BLOCK_IDS.filter(b => active.has(b));
}

/** Format the weekly schedule as readable block names for confirmation SMS */
function formatAvailability(weekly: WeeklyAvailability): string {
  const lines: string[] = [];
  for (const day of DAYS) {
    const slots = weekly[day] ?? [];
    if (slots.length > 0) {
      const blockNames = slotsToBlocks(slots)
        .map(id => `${BLOCKS[id].label} (${BLOCKS[id].hours})`)
        .join(", ");
      lines.push(`  ${day.charAt(0).toUpperCase() + day.slice(1)}: ${blockNames}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "  (no availability set)";
}

/** The block menu shown to caregivers when picking availability */
const BLOCK_MENU =
  `  1. Morning (6am–12pm)\n` +
  `  2. Afternoon (12pm–6pm)\n` +
  `  3. Evening (6pm–11pm)\n` +
  `  4. Overnight (11pm–6am)`;

async function isQuestionOrOther(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    "Reply YES if this is a general question or off-topic comment unrelated to confirming a schedule change or picking time blocks. Reply NO if it is a direct answer. Only reply YES or NO.",
    text,
    5
  );
  return result.toUpperCase().startsWith("Y");
}

/**
 * UPDATE_AVAILABILITY handler — caregiver updates their weekly schedule.
 *
 * Flow:
 *   start           → parse which day(s) and action from message,
 *                      then ask caregiver to pick blocks explicitly
 *   awaiting_blocks → parse block selections, build proposed schedule, ask to confirm
 *   confirm         → YES saves to Firestore; NO cancels
 */
export async function handleAvailabilityUpdate(
  caregiverId: string,
  phone:       string,
  text:        string,
  session:     Record<string, unknown>,
  sendMessage: (msg: string) => Promise<unknown>
): Promise<void> {
  const step = (session.availabilityStep as string) ?? "start";

  // ── start — identify days + action, then ask which blocks ────────────────
  if (step === "start") {
    // isQuestionOrOther check first
    if (await isQuestionOrOther(text)) {
      await sendMessage(
        "I can update your availability! Just let me know which day(s) you'd like to change.\n\n" +
        "For example:\n" +
        "• \"Add Monday\"\n" +
        "• \"Remove Fridays\"\n" +
        "• \"Change my Tuesday schedule\""
      );
      return;
    }

    const raw = await parseWithClaude(
      `Extract which days and what action the caregiver wants for their availability. ` +
      `Return ONLY valid JSON: {"action":"add"|"remove"|"replace","days":["monday","tuesday",...]}. ` +
      `"add" = add new availability to those days. ` +
      `"remove" = remove all availability on those days. ` +
      `"replace" = replace existing availability on those days. ` +
      `Use lowercase full day names. ` +
      `If action is unclear but days are mentioned, default to "replace". ` +
      `If you cannot identify any days, return {"action":"unclear","days":[]}.`,
      text,
      200
    );

    let parsed: { action: string; days: string[] } = { action: "unclear", days: [] };
    try {
      const stripped = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(stripped);
    } catch { /* keep unclear */ }

    const validDays = (parsed.days ?? []).map(d => d.toLowerCase()).filter(d => DAYS.includes(d));

    if (parsed.action === "unclear" || validDays.length === 0) {
      await sendMessage(
        "Which day(s) would you like to update?\n\n" +
        "For example: \"Monday\", \"Monday and Wednesday\", or \"weekdays\""
      );
      return;
    }

    const dayList = validDays.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ");

    // "remove" doesn't need block selection — go straight to confirm
    if (parsed.action === "remove") {
      const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
      const current: WeeklyAvailability = (cgSnap.data()?.weeklyAvailability ?? {}) as WeeklyAvailability;
      const proposed: WeeklyAvailability = JSON.parse(JSON.stringify(current));
      for (const day of validDays) delete proposed[day];

      await db.collection("agent_sessions").doc(phone).update({
        availabilityStep:    "confirm",
        pendingAvailability: JSON.stringify(proposed),
        stateExpiresAt:      new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });

      const opener = await generateCaraMessage({
        audience: "caregiver",
        context:  "Evia is about to show the caregiver their updated availability after removing a day. Write a brief 1-sentence intro asking them to confirm.",
        fallback:  "Here's your updated schedule — does this look right?",
        maxTokens: 60,
      });

      await sendMessage(
        `${opener}\n\n` +
        formatAvailability(proposed) +
        `\n\nReply YES to save, or NO to cancel.`
      );
      return;
    }

    // For add/replace — ask which blocks
    await db.collection("agent_sessions").doc(phone).update({
      availabilityStep: "awaiting_blocks",
      pendingDays:      JSON.stringify(validDays),
      pendingAction:    parsed.action,
      stateExpiresAt:   new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    const verb = parsed.action === "add" ? "add for" : "set for";
    await sendMessage(
      `Got it — ${dayList}. Which time blocks would you like to ${verb} ${validDays.length === 1 ? "that day" : "those days"}?\n\n` +
      BLOCK_MENU +
      `\n\nReply with the numbers or names (e.g. "1 and 2" or "Morning, Afternoon"). ` +
      `Reply "all" for all blocks or "none" to remove availability.`
    );
    return;
  }

  // ── awaiting_blocks — parse block selections, build proposed, ask confirm ─
  if (step === "awaiting_blocks") {
    // isQuestionOrOther check first
    if (await isQuestionOrOther(text)) {
      await sendMessage(
        `Which time blocks would you like?\n\n` +
        BLOCK_MENU +
        `\n\nReply with numbers or names, "all", or "none".`
      );
      return;
    }

    const pendingDays: string[] = JSON.parse((session.pendingDays as string) ?? "[]");
    const pendingAction = (session.pendingAction as string) ?? "replace";

    const raw = await parseWithClaude(
      `The caregiver is selecting which time blocks they are available. ` +
      `The blocks are: morning (6am–12pm), afternoon (12pm–6pm), evening (6pm–11pm), overnight (11pm–6am). ` +
      `Map their reply to block IDs. Rules:\n` +
      `- "1" or "morning" → "morning"\n` +
      `- "2" or "afternoon" → "afternoon"\n` +
      `- "3" or "evening" → "evening"\n` +
      `- "4" or "overnight" → "overnight"\n` +
      `- "all" or "all day" or "everything" → all four blocks\n` +
      `- "none" or "not available" or "remove" → empty array\n` +
      `- "1 and 2" → morning and afternoon\n` +
      `- "morning and afternoon" → morning and afternoon\n` +
      `Return ONLY a JSON array of block IDs, e.g. ["morning","afternoon"] or [].`,
      text,
      100
    );

    let selectedBlocks: BlockId[] = [];
    try {
      const stripped = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
      const parsed = JSON.parse(stripped);
      selectedBlocks = (Array.isArray(parsed) ? parsed : []).filter((b: string) => BLOCKS[b]) as BlockId[];
    } catch { /* empty blocks */ }

    // Load current availability and apply the patch
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const current: WeeklyAvailability = (cgSnap.data()?.weeklyAvailability ?? {}) as WeeklyAvailability;
    const proposed: WeeklyAvailability = JSON.parse(JSON.stringify(current));

    if (selectedBlocks.length === 0) {
      // "none" — remove those days
      for (const day of pendingDays) delete proposed[day];
    } else if (pendingAction === "add") {
      for (const day of pendingDays) {
        const existingBlocks = slotsToBlocks(proposed[day] ?? []);
        const merged = Array.from(new Set([...existingBlocks, ...selectedBlocks]));
        proposed[day] = blocksToSlots(merged);
      }
    } else {
      // replace
      for (const day of pendingDays) {
        proposed[day] = blocksToSlots(selectedBlocks);
      }
    }

    // Move to confirm step
    await db.collection("agent_sessions").doc(phone).update({
      availabilityStep: "confirm",
      pendingAvailability: JSON.stringify(proposed),
      pendingDays:      admin.firestore.FieldValue.delete(),
      pendingAction:    admin.firestore.FieldValue.delete(),
      stateExpiresAt:   new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    const opener = await generateCaraMessage({
      audience: "caregiver",
      context:  "Evia is about to show the caregiver their updated availability schedule for confirmation. Write a brief 1-sentence intro asking them to confirm it looks right.",
      fallback:  "Here's your updated schedule — does this look right?",
      maxTokens: 60,
    });

    await sendMessage(
      `${opener}\n\n` +
      formatAvailability(proposed) +
      `\n\nReply YES to save, or NO to cancel.`
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

    // Clear session state regardless of decision
    await db.collection("agent_sessions").doc(phone).update({
      availabilityStep:    admin.firestore.FieldValue.delete(),
      pendingAvailability: admin.firestore.FieldValue.delete(),
      stateExpiresAt:      admin.firestore.FieldValue.delete(),
    }).catch(() => {});

    if (decision === "YES") {
      await db.collection("caregivers").doc(caregiverId).update({
        weeklyAvailability:    proposed,
        availabilityUpdatedAt: new Date().toISOString(),
      });

      const saveMsg = await generateCaraMessage({
        audience: "caregiver",
        context:  "A caregiver just confirmed their updated availability schedule. Evia saved it. Write a warm 1-sentence confirmation.",
        fallback:  "Done — your availability has been updated.",
        maxTokens: 60,
      });
      await sendMessage(saveMsg);
    } else {
      const cancelMsg = await generateCaraMessage({
        audience: "caregiver",
        context:  "A caregiver decided not to apply their proposed availability change. Write a brief 1-sentence acknowledgment and invite them to try again when they're ready.",
        fallback:  "No problem — your availability wasn't changed. Let me know whenever you'd like to update it.",
        maxTokens: 60,
      });
      await sendMessage(cancelMsg);
    }
    return;
  }
}
