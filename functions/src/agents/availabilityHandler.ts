// agents/availabilityHandler.ts — the Calendar page's "Update Availability"
// modal as a short scripted flow (the UPDATE_AVAILABILITY intent's handler).
//
// The modal: a 7-day × 4-block grid, Save writes caregivers/{uid}.weeklyAvailability
// as the whole map of canonical slots (services/availabilityService.ts
// blocksToWeeklySlots). This flow ends in that exact write — nothing else
// (rewritten 2026-09-30: plain fixed sentences, no model-written copy; same
// field and values as the modal; caregiverAvailabilityGrid.ts owns the grid).
//
//   start           → which day(s), and add / remove / replace (LLM-parsed)
//   awaiting_blocks → which blocks (LLM-parsed against the modal's four labels)
//   confirm         → shows the whole grid like the modal; SAVE saves, CANCEL backs out
import * as admin from "firebase-admin";
import { parseWithClaude } from "../utils/parseWithClaude";
import {
  gridFromWeekly, weeklyFromGrid, applyGridPatch, gridText, gridsEqual, normalizeDay,
  BLOCK_IDS, BLOCK_CHOICES, DAY_KEYS, type Grid, type BlockId, type GridPatch,
} from "./caregiverAvailabilityGrid";

const db = admin.firestore();
const FLOW_TTL_MS = 30 * 60 * 1000;

export const WHICH_DAYS_Q = "Which day(s) would you like to update? For example \"Monday\", \"Monday and Wednesday\", or \"weekdays\".";
export const CONFIRM_LINE = "Reply SAVE to save this, or CANCEL to leave it as it is.";
const blocksQ = (days: string[], action: string) =>
  `Which time blocks ${action === "add" ? "should I add for" : "are you available on"} ${days.map(cap).join(", ")} — ${BLOCK_CHOICES}? Reply the names, ALL, or NONE to clear ${days.length === 1 ? "that day" : "those days"}.`;
const cap = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);

async function isQuestionOrOther(text: string): Promise<boolean> {
  const v = await parseWithClaude(
    "Is this message a QUESTION or an unrelated remark, rather than an answer naming days, time blocks, or yes/no/save/cancel? Reply exactly QUESTION or ANSWER.",
    text, 5,
  ).catch(() => "ANSWER");
  return v.trim().toUpperCase().startsWith("Q");
}

export async function handleAvailabilityUpdate(
  caregiverId: string,
  phone: string,
  text: string,
  session: Record<string, unknown>,
  sendMessage: (msg: string) => Promise<unknown>,
): Promise<void> {
  const step = (session.availabilityStep as string) ?? "start";
  const ref = db.collection("agent_sessions").doc(phone);
  const clear = () => ref.update({
    availabilityStep: admin.firestore.FieldValue.delete(), pendingAvailability: admin.firestore.FieldValue.delete(),
    pendingDays: admin.firestore.FieldValue.delete(), pendingAction: admin.firestore.FieldValue.delete(), stateExpiresAt: admin.firestore.FieldValue.delete(),
  }).catch(() => {});
  const loadGrid = async (): Promise<Grid> => gridFromWeekly((await db.collection("caregivers").doc(caregiverId).get()).data()?.weeklyAvailability);
  // Goal 4 (founder): Evia wakes once per text and the site can change the grid
  // meanwhile — so the session keeps the TAPS, not the resulting grid, and SAVE
  // re-applies them to whatever the record holds at that moment.
  const toConfirm = async (patch: GridPatch, current: Grid) => {
    const grid = applyGridPatch(current, patch).grid;
    if (gridsEqual(grid, current)) { await clear(); await sendMessage(`That's already how your availability is set:\n${gridText(current)}`); return; }
    await ref.update({ availabilityStep: "confirm", pendingAvailability: JSON.stringify(patch), pendingDays: admin.firestore.FieldValue.delete(), pendingAction: admin.firestore.FieldValue.delete(), stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() });
    await sendMessage(`Your availability would be:\n${gridText(grid)}\n\n${CONFIRM_LINE}`);
  };

  if (step === "start") {
    if (await isQuestionOrOther(text)) { await sendMessage(`I can update your availability — it's the same grid as Update Availability on your Calendar. ${WHICH_DAYS_Q}`); return; }
    const raw = await parseWithClaude(
      `The caregiver wants to change their weekly availability. Extract the days and the action. Return ONLY JSON: {"action":"add"|"remove"|"replace","days":["monday",...],"blocks":["morning","afternoon","evening","overnight"]}. ` +
      `"weekdays" = monday..friday, "weekends" = saturday+sunday, "every day" = all seven. "remove"/"not available"/"take off" = remove. "add" when they add hours. Otherwise "replace". ` +
      `Include "blocks" only when they named parts of the day (morning 6am-12pm, afternoon 12pm-6pm, evening 6pm-12am, overnight 12am-6am; a clock range maps to every block it touches). If no day is named return {"action":"unclear","days":[]}.`,
      text, 200,
    ).catch(() => "");
    let parsed: { action?: string; days?: string[]; blocks?: string[] } = {};
    try { parsed = JSON.parse(raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")); } catch { /* unclear */ }
    const days = [...new Set((parsed.days ?? []).map(normalizeDay).filter((d): d is Grid extends Record<infer K, unknown> ? K & string : never => !!d))];
    const action = parsed.action === "add" || parsed.action === "remove" || parsed.action === "replace" ? parsed.action : "unclear";
    if (action === "unclear" || days.length === 0) { await sendMessage(WHICH_DAYS_Q); return; }
    const current = await loadGrid();
    if (action === "remove") {
      return toConfirm({ remove: Object.fromEntries(days.map((d) => [d, "all" as const])) }, current);
    }
    const namedBlocks = (parsed.blocks ?? []).map((b) => String(b).toLowerCase()).filter((b): b is BlockId => (BLOCK_IDS as string[]).includes(b));
    if (namedBlocks.length) {
      const patch: GridPatch = action === "add" ? { add: Object.fromEntries(days.map((d) => [d, namedBlocks])) } : { set: Object.fromEntries(days.map((d) => [d, namedBlocks])) };
      return toConfirm(patch, current);
    }
    await ref.update({ availabilityStep: "awaiting_blocks", pendingDays: JSON.stringify(days), pendingAction: action, stateExpiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() });
    await sendMessage(blocksQ(days, action));
    return;
  }

  if (step === "awaiting_blocks") {
    const days = (JSON.parse((session.pendingDays as string) ?? "[]") as string[]).filter((d) => (DAY_KEYS as readonly string[]).includes(d));
    const action = (session.pendingAction as string) === "add" ? "add" : "replace";
    const norm = text.trim().toUpperCase();
    let blocks: BlockId[] | null = null;
    if (norm === "ALL") blocks = [...BLOCK_IDS];
    else if (norm === "NONE") blocks = [];
    else if (norm === "CANCEL" || norm === "NO") { await clear(); await sendMessage("Okay — your availability wasn't changed."); return; }
    else {
      if (await isQuestionOrOther(text)) { await sendMessage(blocksQ(days, action)); return; }
      const raw = await parseWithClaude(
        `Map the caregiver's reply to time blocks: morning (6am-12pm), afternoon (12pm-6pm), evening (6pm-12am), overnight (12am-6am). "1"/"2"/"3"/"4" are those in order. "all" = all four; "none" = []. A clock range maps to every block it touches. Return ONLY a JSON array of block ids, e.g. ["morning","afternoon"].`,
        text, 100,
      ).catch(() => "");
      try { const p = JSON.parse(raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "")); if (Array.isArray(p)) blocks = p.map((b) => String(b).toLowerCase()).filter((b): b is BlockId => (BLOCK_IDS as string[]).includes(b)); } catch { /* unparsed */ }
      if (blocks === null) { await sendMessage(`Sorry, I didn't quite catch that. ${blocksQ(days, action)}`); return; }
    }
    const current = await loadGrid();
    const patch: GridPatch = blocks.length === 0 ? { set: Object.fromEntries(days.map((d) => [d, [] as string[]])) } : action === "add" ? { add: Object.fromEntries(days.map((d) => [d, blocks!])) } : { set: Object.fromEntries(days.map((d) => [d, blocks!])) };
    return toConfirm(patch, current);
  }

  if (step === "confirm") {
    let patch: GridPatch;
    try { patch = JSON.parse((session.pendingAvailability as string) ?? "") as GridPatch; } catch { await clear(); await sendMessage(WHICH_DAYS_Q); return; }
    const proposed = applyGridPatch(await loadGrid(), patch).grid; // the live grid + their taps
    const norm = text.trim().toUpperCase();
    let decision: "save" | "cancel" | "other";
    if (norm === "SAVE" || norm === "YES" || norm === "CONFIRM" || norm === "SAVE AVAILABILITY") decision = "save";
    else if (norm === "CANCEL" || norm === "NO") decision = "cancel";
    else {
      const v = await parseWithClaude("Evia asked the caregiver to reply SAVE to save their availability or CANCEL. Classify the reply: SAVE, CANCEL, or OTHER (a question or a change).", text, 5).catch(() => "OTHER");
      decision = v.toUpperCase().startsWith("SAVE") ? "save" : v.toUpperCase().startsWith("CANCEL") ? "cancel" : "other";
    }
    if (decision === "other") { await sendMessage(`Your availability would be:\n${gridText(proposed)}\n\n${CONFIRM_LINE}`); return; }
    await clear();
    if (decision === "cancel") { await sendMessage("Okay — your availability wasn't changed."); return; }
    // The modal's Save, field for field.
    await db.collection("caregivers").doc(caregiverId).update({ weeklyAvailability: weeklyFromGrid(proposed) });
    await sendMessage(`Saved. Your availability:\n${gridText(proposed)}`);
    return;
  }

  await clear();
}
