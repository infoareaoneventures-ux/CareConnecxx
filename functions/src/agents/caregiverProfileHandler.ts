import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { parseWithClaude } from "../utils/parseWithClaude";
import { quickComplete } from "../utils/openaiClient";
import { generateCaraMessage } from "../utils/caraMessage";
import { generateToken } from "./tokenService";
import { getAppUrl } from "../config/appUrl";

const db = admin.firestore();

const APP_URL = getAppUrl();

/**
 * Caregiver profile update flow — covers rate, skills, bio, photo, pause, reactivate.
 *
 * Two-step state machine per field:
 *   collect (the value, if not already supplied) → confirm (YES/NO)
 *
 * Triggered by intents: UPDATE_RATE, UPDATE_SKILLS, UPDATE_BIO, UPDATE_PHOTO,
 *                       PAUSE_ACCOUNT, REACTIVATE
 *
 * Sub-handlers each follow: detect intent → parse value → propose → YES/NO confirm → write.
 */

export type ProfileUpdateField =
  | "rate"
  | "skills"
  | "bio"
  | "photo"
  | "pause"
  | "reactivate";

async function isQuestionOrOther(text: string, currentQuestion: string): Promise<boolean> {
  const result = await parseWithClaude(
    `The caregiver is updating their profile. Current step's question: "${currentQuestion}". ` +
      "Reply YES if their message is a general question or off-topic comment unrelated to that question. " +
      "Reply NO if it is a direct answer. Only reply YES or NO.",
    text,
    5,
  );
  return result.toUpperCase().startsWith("Y");
}

async function answerMidFlow(text: string, reAsk: string): Promise<string> {
  const answer = await quickComplete(
    "You are Cara, an AI care assistant helping a caregiver update their profile. " +
      "Answer their question briefly (1-2 sentences). Do NOT ask them to continue — that prompt comes next.",
    text,
    { maxTokens: 150 },
  ).catch(() => "Let me get back to you on that. In the meantime —");
  return `${answer}\n\n${reAsk}`;
}

const KNOWN_SPECIALTIES = [
  "dementia", "alzheimer's", "mobility", "post-surgery", "companionship",
  "medication management", "hospice", "diabetes care", "wound care",
  "transportation", "meal prep", "personal care", "bathing", "transfers",
  "respite care", "parkinson's", "stroke recovery", "cognitive support",
];

async function clearProfileFlow(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    profileUpdateStep:  admin.firestore.FieldValue.delete(),
    profileUpdateField: admin.firestore.FieldValue.delete(),
    profileUpdateValue: admin.firestore.FieldValue.delete(),
    stateExpiresAt:     admin.firestore.FieldValue.delete(),
  }).catch(() => {});
}

/**
 * Entry point — call when a profile-update intent (or active profileUpdateStep) is detected.
 * Routes to the correct sub-handler based on `field`.
 *
 * For pure-entry intents that may include the value inline (e.g. "change my rate to $28"),
 * pass `field` from intent classification. Otherwise the existing session.profileUpdateField is used.
 */
export async function handleCaregiverProfileUpdate(
  caregiverId:    string,
  caregiverPhone: string,
  text:           string,
  session:        Record<string, unknown>,
  chatId:         string,
  field?:         ProfileUpdateField,
): Promise<void> {
  const activeField = (field ?? (session.profileUpdateField as ProfileUpdateField | undefined));
  if (!activeField) {
    await sendMessage(chatId, "I'm not sure what you wanted to update. Try something like \"change my rate to $25\" or \"add dementia care to my skills\".");
    return;
  }

  // ── Inbound MMS media detection (photo path uses this) ─────────────────────
  // The webhooks router passes `text` as the joined text, so MMS-only messages
  // come through as "". The photo handler relies on session.pendingPhotoUrl
  // (set by the router when it sees a media part) — see webhooks.ts wiring.

  switch (activeField) {
    case "rate":       return handleRateUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "skills":     return handleSkillsUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "bio":        return handleBioUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "photo":      return handlePhotoUpdate(caregiverId, caregiverPhone, text, session, chatId);
    case "pause":      return handlePauseAccount(caregiverId, caregiverPhone, text, session, chatId);
    case "reactivate": return handleReactivate(caregiverId, caregiverPhone, session, chatId);
  }
}

// ── RATE ────────────────────────────────────────────────────────────────────

async function handleRateUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";

  if (step === "collect") {
    const reAsk = "What hourly rate would you like? (e.g. \"$25\" — must be between $15 and $150)";
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk));
      return;
    }
    const raw = await parseWithClaude(
      "Extract the requested hourly rate as a number (no $ sign). " +
        "If the caregiver hasn't yet mentioned a rate, reply: __none__. " +
        "Reply with just the number, e.g. 25.",
      text,
      10,
    );
    const rate = parseFloat(raw);
    if (raw === "__none__" || isNaN(rate)) {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "rate",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, reAsk);
      return;
    }
    if (rate < 15 || rate > 150) {
      await sendMessage(chatId, `Hourly rate must be between $15 and $150 — you said $${rate}. What rate would you like?`);
      return;
    }
    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep:  "confirm",
      profileUpdateField: "rate",
      profileUpdateValue: String(rate),
      stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId, `Set your hourly rate to $${rate}/hr? Reply YES to save, or NO to cancel.`);
    return;
  }

  // confirm
  const proposedRate = parseFloat((session.profileUpdateValue as string) ?? "0");
  const reAskConfirm = `Set your hourly rate to $${proposedRate}/hr? Reply YES to save, or NO to cancel.`;
  if (await isQuestionOrOther(text, reAskConfirm)) {
    await sendMessage(chatId, await answerMidFlow(text, reAskConfirm));
    return;
  }
  const decision = await parseWithClaude(
    '"yes", "save", "confirm", "do it" → YES. "no", "cancel", "wait", "never mind" → NO. Reply exactly YES or NO.',
    text, 5,
  );
  await clearProfileFlow(phone);
  if (decision === "YES" && proposedRate > 0) {
    await db.collection("caregivers").doc(caregiverId).update({
      hourlyRate:      proposedRate,
      rateUpdatedAt:   new Date().toISOString(),
    });
    await sendMessage(chatId, `Done — your hourly rate is now $${proposedRate}/hr.`);
  } else {
    await sendMessage(chatId, "No problem — your rate wasn't changed.");
  }
}

// ── SKILLS ──────────────────────────────────────────────────────────────────

async function handleSkillsUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";

  if (step === "collect") {
    const reAsk = "Which specialties would you like to add or remove? " +
      "(e.g. \"add dementia and hospice\", or \"remove mobility\")";
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk));
      return;
    }
    const raw = await parseWithClaude(
      "Parse the caregiver's skill-update request. Reply JSON: " +
        '{"action":"add"|"remove"|"replace","skills":["skill1","skill2"]}. ' +
        "Skills should be lowercase short phrases. " +
        "If the caregiver hasn't said yet, reply: __none__.",
      text,
      150,
    );
    if (raw === "__none__" || raw === "__parse_error__") {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "skills",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, reAsk);
      return;
    }
    let action: "add" | "remove" | "replace" = "add";
    let skills: string[] = [];
    try {
      const parsed = JSON.parse(raw);
      action = ["add", "remove", "replace"].includes(parsed.action) ? parsed.action : "add";
      skills = Array.isArray(parsed.skills) ? parsed.skills.map((s: unknown) => String(s).toLowerCase().trim()).filter(Boolean) : [];
    } catch { /* fall through */ }

    if (skills.length === 0) {
      await sendMessage(chatId, "I didn't catch any specific skills in that. Try \"add dementia care\" or \"remove mobility\".");
      return;
    }

    // Show proposed change against current
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const current = (cgSnap.data()?.specialties ?? []) as string[];
    const currentNorm = current.map(s => s.toLowerCase());

    let proposed: string[] = [];
    if (action === "add") {
      proposed = [...new Set([...currentNorm, ...skills])];
    } else if (action === "remove") {
      proposed = currentNorm.filter(s => !skills.includes(s));
    } else {
      proposed = skills;
    }

    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep:  "confirm",
      profileUpdateField: "skills",
      profileUpdateValue: JSON.stringify(proposed),
      stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId,
      `Updated skills will be: ${proposed.length ? proposed.join(", ") : "(none)"}\n\n` +
      `Save? Reply YES or NO.`,
    );
    return;
  }

  // confirm
  const proposed = (() => {
    try { return JSON.parse((session.profileUpdateValue as string) ?? "[]") as string[]; }
    catch { return []; }
  })();
  const reAskConfirm = `Save these skills: ${proposed.join(", ") || "(none)"}? Reply YES or NO.`;
  if (await isQuestionOrOther(text, reAskConfirm)) {
    await sendMessage(chatId, await answerMidFlow(text, reAskConfirm));
    return;
  }
  const decision = await parseWithClaude(
    '"yes", "save", "confirm" → YES. "no", "cancel", "wait" → NO. Reply exactly YES or NO.',
    text, 5,
  );
  await clearProfileFlow(phone);
  if (decision === "YES") {
    await db.collection("caregivers").doc(caregiverId).update({
      specialties:        proposed,
      skillsUpdatedAt:    new Date().toISOString(),
    });
    await sendMessage(chatId, `Done — your specialties are updated.`);
  } else {
    await sendMessage(chatId, "No problem — your skills weren't changed.");
  }
  void KNOWN_SPECIALTIES;
}

// ── BIO ─────────────────────────────────────────────────────────────────────

async function handleBioUpdate(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";

  if (step === "collect") {
    const reAsk = "What would you like your new bio to say? (Up to ~300 characters — this is what families see on your profile.)";
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk));
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length < 15) {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "bio",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, reAsk);
      return;
    }
    const bio = trimmed.slice(0, 300);
    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep:  "confirm",
      profileUpdateField: "bio",
      profileUpdateValue: bio,
      stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    await sendMessage(chatId, `Here's your new bio:\n\n"${bio}"\n\nSave? Reply YES or NO.`);
    return;
  }

  // confirm
  const proposedBio = (session.profileUpdateValue as string) ?? "";
  const reAskConfirm = `Save this bio?\n\n"${proposedBio}"\n\nReply YES or NO.`;
  if (await isQuestionOrOther(text, reAskConfirm)) {
    await sendMessage(chatId, await answerMidFlow(text, reAskConfirm));
    return;
  }
  const decision = await parseWithClaude(
    '"yes", "save", "confirm" → YES. "no", "cancel", "wait" → NO. Reply exactly YES or NO.',
    text, 5,
  );
  await clearProfileFlow(phone);
  if (decision === "YES" && proposedBio) {
    await db.collection("caregivers").doc(caregiverId).update({
      bio:              proposedBio,
      bioUpdatedAt:     new Date().toISOString(),
    });
    await sendMessage(chatId, "Done — your bio is updated.");
  } else {
    await sendMessage(chatId, "No problem — your bio wasn't changed.");
  }
}

// ── PHOTO ───────────────────────────────────────────────────────────────────
// Uses a web upload link (auto-returns to SMS on completion per the web→SMS
// handoff rule). MMS attachments aren't reliably available on all carriers
// and the existing onboarding photo flow already uses this pattern.

async function handlePhotoUpdate(
  _caregiverId: string, phone: string, _text: string,
  _session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const token = generateToken({ phone, task: "photo_upload" });
  const photoUrl = `${APP_URL}/upload/photo?t=${token}&return=sms`;

  await clearProfileFlow(phone);
  await sendMessage(chatId,
    "Tap to upload a new profile photo — it'll bring you right back here when you're done:",
  );
  await sendMessage(chatId, { parts: [{ type: "link", value: photoUrl }] });
}

// ── PAUSE ACCOUNT ──────────────────────────────────────────────────────────

async function handlePauseAccount(
  caregiverId: string, phone: string, text: string,
  session: Record<string, unknown>, chatId: string,
): Promise<void> {
  const step = (session.profileUpdateStep as string) ?? "collect";

  if (step === "collect") {
    const reAsk = "When would you like to pause until? (e.g. \"until July 12\", \"for two weeks\", \"indefinitely\")";
    if (await isQuestionOrOther(text, reAsk)) {
      await sendMessage(chatId, await answerMidFlow(text, reAsk));
      return;
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    const raw = await parseWithClaude(
      `Parse the caregiver's pause-until date. Today is ${todayIso}. Reply JSON: ` +
        '{"until":"YYYY-MM-DD"} for a specific end date, or {"until":"indefinite"} for an open-ended pause. ' +
        'If you cannot extract any date or duration, reply: __none__.',
      text,
      40,
    );
    if (raw === "__none__" || raw === "__parse_error__") {
      await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep:  "collect",
        profileUpdateField: "pause",
        stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      await sendMessage(chatId, reAsk);
      return;
    }
    let until = "indefinite";
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.until === "string") until = parsed.until;
    } catch { /* keep default */ }

    await db.collection("agent_sessions").doc(phone).update({
      profileUpdateStep:  "confirm",
      profileUpdateField: "pause",
      profileUpdateValue: until,
      stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const untilLabel = until === "indefinite" ? "indefinitely" : `until ${until}`;
    await sendMessage(chatId,
      `Pause your account ${untilLabel}? You won't receive job matches during this time. ` +
      `Reply YES to pause, or NO to cancel.`,
    );
    return;
  }

  // confirm
  const until = (session.profileUpdateValue as string) ?? "indefinite";
  const untilLabel = until === "indefinite" ? "indefinitely" : `until ${until}`;
  const reAskConfirm = `Pause your account ${untilLabel}? Reply YES or NO.`;
  if (await isQuestionOrOther(text, reAskConfirm)) {
    await sendMessage(chatId, await answerMidFlow(text, reAskConfirm));
    return;
  }
  const decision = await parseWithClaude(
    '"yes", "pause", "confirm", "do it" → YES. "no", "cancel", "wait" → NO. Reply exactly YES or NO.',
    text, 5,
  );
  await clearProfileFlow(phone);
  if (decision === "YES") {
    const pausedUntil = until === "indefinite"
      ? "2099-12-31"
      : until;
    await db.collection("caregivers").doc(caregiverId).update({
      pausedUntil:      pausedUntil,
      pausedAt:         new Date().toISOString(),
    });
    const backWhen = until === "indefinite" ? "Text REACTIVATE whenever you're ready to come back." : `You'll be reactivated on ${until}. Text REACTIVATE sooner if your plans change.`;
    await sendMessage(chatId, `Done — your account is paused. ${backWhen}`);
  } else {
    await sendMessage(chatId, "No problem — your account is still active.");
  }
}

// ── REACTIVATE ─────────────────────────────────────────────────────────────

async function handleReactivate(
  caregiverId: string, phone: string,
  _session: Record<string, unknown>, chatId: string,
): Promise<void> {
  await db.collection("caregivers").doc(caregiverId).update({
    pausedUntil:      admin.firestore.FieldValue.delete(),
    reactivatedAt:    new Date().toISOString(),
  });
  await clearProfileFlow(phone);
  const msg = await generateCaraMessage({
    audience: "caregiver",
    context: "A caregiver just reactivated their account after being paused. Welcome them back warmly in one short sentence.",
    fallback: "Welcome back — you're set to receive job matches again.",
    maxTokens: 60,
  });
  await sendMessage(chatId, msg);
}

/**
 * Helper: detect which profile-update field an inbound intent corresponds to.
 * Returns undefined if the intent isn't a profile-update intent.
 */
export function profileFieldFromIntent(intent: string): ProfileUpdateField | undefined {
  switch (intent) {
    case "UPDATE_RATE":    return "rate";
    case "UPDATE_SKILLS":  return "skills";
    case "UPDATE_BIO":     return "bio";
    case "UPDATE_PHOTO":   return "photo";
    case "PAUSE_ACCOUNT":  return "pause";
    case "REACTIVATE":     return "reactivate";
    default:               return undefined;
  }
}
