// ── Childcare incident signal + deterministic handoff (plan 2026-07-22-002,
//    U10 / R53, AE24 seam) ─────────────────────────────────────────────────────
//
// A childcare turn matching serious-incident classification (injury, missing
// child, suspected abuse, unsafe pickup, custody conflict, immediate danger)
// routes to the EXISTING human-handoff machinery (agent_sessions hold fields +
// createCaraOpsAlert) BEFORE any model call. The classifier is deterministic
// (keyword + category patterns) and runs OUTSIDE the LLM, so model text can
// never suppress, investigate, or complete the escalation (R53).
//
// PILOT LIMITATIONS (documented per the amended plan):
//   • Keyword/regex classification, English-only — misses paraphrase and
//     multilingual reports; errs toward escalating (false positives page a
//     human, false negatives are the dangerous direction).
//   • Full incident case management (restricted case docs, evidence, operator
//     ownership, suspected-party exclusion enforcement) is U12
//     (childcare/incidentPolicy.ts). This module leaves the TYPED SEAM: the
//     session hold carries `childcareIncidentMarker` (category) and the alert
//     type is `childcare_incident` — U12's queue consumes both.
//   • Message text NEVER enters the alert/log payload (R57) — category +
//     identifiers only.

import * as admin from "firebase-admin";
// NOTE: caraOpsAlerts/auditLog are imported LAZILY inside
// escalateChildcareIncident — both bind admin.firestore() at module load,
// which would break every test suite that imports this module's pure
// classifier without a firebase-admin mock.

export const CHILDCARE_INCIDENT_CATEGORIES = [
  "injury",
  "missing_child",
  "abuse",
  "unsafe_pickup",
  "custody_conflict",
  "danger",
] as const;
export type ChildcareIncidentCategory = (typeof CHILDCARE_INCIDENT_CATEGORIES)[number];

export interface ChildcareIncidentSignal {
  incident: boolean;
  category?: ChildcareIncidentCategory;
}

// Child reference fragment. Includes bare PRONOUNS on purpose: this classifier
// only ever runs on a turn already anchored to a childcare session (see the
// function doc), so "she's bleeding" / "he fell" almost certainly refer to the
// child. Requiring an explicit noun was the classifier's biggest false-negative
// source — parents overwhelmingly use pronouns in a panic.
const CHILD_REF = "(?:kid|kids|child|children|son|daughter|toddler|baby|infant|he|she|they|him|her|them|his|their)";

// Immediate medical / life-safety phrasings. Deliberately noun-free: any of
// these on a childcare turn escalates regardless of who is named. Over-escalation
// is the safe direction here — a human triages; a miss does not get triaged.
const MEDICAL_EMERGENCY = [
  /\b911\b/,
  /\b(?:ambulance|paramedics?|EMTs?|life ?flight)\b/i,
  /\b(?:unconscious|unresponsive|not breathing|can'?t breathe|stopped breathing|turning blue)\b/i,
  /\b(?:seizure|seizing|convulsi)/i,
  /\b(?:anaphyla|epi ?pen|allergic reaction)\b/i,
  /\b(?:drown(?:ing|ed)|underwater|face ?down in the (?:pool|water|tub|bath))\b/i,
  /\b(?:poison(?:ed|ing)?|swallowed (?:a |some |the )?\w+|ate (?:a |some |the )?(?:pill|medicine|cleaner|battery)|overdose)\b/i,
  /\b(?:locked|left|trapped|stuck)\b.{0,25}\bin the car\b/i,
  /\bhead (?:injury|trauma)\b|\bhit (?:his|her|their|its) head\b/i,
];

// Category patterns, checked in severity order — the FIRST match wins so the
// marker names the most urgent classification present.
const CATEGORY_PATTERNS: ReadonlyArray<{ category: ChildcareIncidentCategory; patterns: RegExp[] }> = [
  {
    // Life-safety first: a medical emergency outranks every other classification
    // so the marker never downgrades an ambulance-level event to e.g. "injury".
    category: "danger",
    patterns: MEDICAL_EMERGENCY,
  },
  {
    category: "danger",
    patterns: [
      // "emergency" excludes the routine "emergency contact/info" phrasings — a
      // pre-existing false positive surfaced by the 2026-07-25 silence tests.
      /\b(?:in danger|unsafe|not safe|emergency(?!\s+(?:contact|contacts|info|information|number|numbers))|call(?:ed|ing)? (?:the )?police|weapon|gun|knife|threat(?:en(?:ed|ing)?)?)\b/i,
      /\b(?:drunk|intoxicated|wasted|high)\b.{0,40}\b(?:sitter|caregiver|nanny|babysitter|provider)\b/i,
      /\b(?:sitter|caregiver|nanny|babysitter|provider)\b.{0,40}\b(?:drunk|intoxicated|wasted|high)\b/i,
    ],
  },
  {
    category: "missing_child",
    patterns: [
      // "can't find her" is alarming; bare "missing"/"disappeared" are NOT in this
      // ordering — "I'm missing her school forms" must not page an operator. They
      // stay in the next pattern, where the child is the SUBJECT ("she is missing").
      new RegExp(String.raw`\b(?:can'?t find|cannot find|lost track of)\b.{0,30}\b${CHILD_REF}\b`, "i"),
      new RegExp(String.raw`\b${CHILD_REF}\b.{0,50}\b(?:is missing|went missing|disappeared|not (?:here|there|at school|at home))\b`, "i"),
      // Wandering phrasings. Deliberately NOT "took off" / "got out" / "slipped
      // out": those fire on "took off her shoes" and "got out of the car", and a
      // classifier that cries wolf on routine messages trains operators to ignore
      // it — the same failure mode as a guard test that always fails.
      /\b(?:ran away|ran off|wandered off)\b/i,
      /\bdon'?t know where\b.{0,30}\b(?:he|she|they|him|her|them|kid|child)\b/i,
      /\b(?:never (?:picked|dropped)|didn'?t (?:pick|drop)) (?:him|her|them|up)\b.{0,60}\b(?:school|daycare|home)\b/i,
      /\bno one (?:picked up|came for)\b/i,
    ],
  },
  {
    category: "abuse",
    patterns: [
      /\b(?:abus(?:e|ed|ing|ive)|molest|inappropriate(?:ly)?\s+touch(?:ed|ing)?|touched?\s+(?:him|her|them|my)\b.{0,30}\binappropriate)/i,
      /\b(?:hit|slapped|shook|grabbed|shoved|spanked)\b.{0,40}\b(?:him|her|them|my (?:kid|child|son|daughter))\b/i,
      /\b(?:bruise|mark|welt)s?\b.{0,60}\b(?:won'?t say|can'?t explain|no explanation|after the (?:sitter|visit|caregiver))/i,
    ],
  },
  {
    category: "unsafe_pickup",
    patterns: [
      /\b(?:stranger|someone (?:i|we) (?:don'?t|didn'?t) (?:know|recognize)|unauthorized (?:person|adult)|wrong person)\b.{0,60}\b(?:pick(?:ed|ing)? (?:him|her|them|up)|took (?:him|her|them)|at pickup)/i,
      /\bpick(?:ed|ing)? up\b.{0,60}\b(?:stranger|someone (?:i|we) (?:don'?t|didn'?t) (?:know|recognize)|unauthorized|not on the list)\b/i,
      /\bleft (?:him|her|them|my (?:kid|child|son|daughter))\b.{0,40}\b(?:alone|unattended)\b/i,
    ],
  },
  {
    category: "custody_conflict",
    patterns: [
      /\b(?:custody|court order|restraining order|protective order)\b/i,
      /\bex[- ]?(?:husband|wife|partner|spouse)\b.{0,60}\b(?:took|showed up|tried to (?:take|pick up)|not allowed)\b/i,
      /\bnot (?:allowed|supposed) to (?:see|take|pick up)\b.{0,40}\b(?:him|her|them|my (?:kid|child|son|daughter))\b/i,
    ],
  },
  {
    category: "injury",
    patterns: [
      new RegExp(String.raw`\b(?:hurt|injur(?:ed|y)|bleeding|bled|burn(?:ed|t)?|broke(?:n)?|fractur|concussion|stitches|swollen|choking|choked)\b.{0,60}\b${CHILD_REF}\b`, "i"),
      new RegExp(String.raw`\b${CHILD_REF}\b.{0,60}\b(?:hurt|injur(?:ed|y)|bleeding|burn(?:ed|t)?|broke(?:n)?|fell(?!\s+asleep)|fall|hospital|urgent care|\bER\b)\b`, "i"),
      // Pronoun-only falls ("she fell down the stairs") were a live gap.
      /\bfell (?:down|off|out of|from)\b/i,
      /\b(?:got hurt|is hurt|was hurt|in the hospital|to the (?:er|hospital|urgent care))\b/i,
    ],
  },
];

/**
 * Deterministic classifier — pure, synchronous, runs BEFORE/OUTSIDE the LLM.
 * Only ever invoked on classified childcare turns (context anchoring), so a
 * senior session's text never reaches these patterns.
 */
export function classifyChildcareIncidentSignal(text: string): ChildcareIncidentSignal {
  const t = String(text ?? "");
  if (!t.trim()) return { incident: false };
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some((p) => p.test(t))) return { incident: true, category };
  }
  return { incident: false };
}

/** The ONE deterministic acknowledgment — never model-generated (R53). */
export const CHILDCARE_INCIDENT_ACK =
  "Thank you for telling me — I've escalated this to our care team right now, and a real person " +
  "will reach out to you as soon as possible. If your child is in immediate danger or needs " +
  "medical help, please call 911 first.";

export interface EscalateChildcareIncidentParams {
  phone: string;
  userId?: string;
  category: ChildcareIncidentCategory;
  channel: "linq" | "web";
  db?: admin.firestore.Firestore;
  now?: Date;
}

/**
 * Route the turn into the EXISTING human-handoff machinery:
 *   1. hold the thread (agent_sessions handedToHuman fields — the same hold
 *      qaAgent's low-confidence gate uses, so follow-ups stay held) with the
 *      childcare-incident marker (U12's typed seam),
 *   2. page operators via createCaraOpsAlert (severity high, type
 *      childcare_incident — category only, never message text).
 * Best-effort writes: a failed hold/alert never blocks the deterministic ack
 * (the caller ALWAYS sends CHILDCARE_INCIDENT_ACK).
 */
export async function escalateChildcareIncident(
  params: EscalateChildcareIncidentParams,
): Promise<{ held: boolean; alerted: boolean }> {
  const db = params.db ?? admin.firestore();
  const nowIso = (params.now ?? new Date()).toISOString();

  let held = false;
  try {
    await db.collection("agent_sessions").doc(params.phone).set({
      handedToHuman: true,
      handedToHumanAt: nowIso,
      handedToHumanReason: "childcare_incident",
      childcareIncidentMarker: params.category,
      childcareIncidentAt: nowIso,
    }, { merge: true });
    held = true;
  } catch (err) {
    console.error("childcareIncident: session hold write failed", {
      reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }

  let alerted = false;
  try {
    const { createCaraOpsAlert } = await import("../observability/caraOpsAlerts");
    alerted = await createCaraOpsAlert({
      type: "childcare_incident",
      severity: "high",
      phone: params.phone,
      userId: params.userId,
      role: "client",
      source: "childcareIncidentSignal",
      message: `Childcare serious-incident signal (${params.category}) — deterministic escalation; U12 case queue owns follow-up.`,
      context: { category: params.category, channel: params.channel },
    });
  } catch (err) {
    console.error("childcareIncident: ops alert failed", {
      reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }

  try {
    const { logAudit } = await import("../observability/auditLog");
    await logAudit({
      eventType: "childcare_incident_escalated",
      userId: params.userId || params.phone,
      data: { category: params.category, channel: params.channel, held, alerted },
    });
  } catch { /* best-effort */ }

  return { held, alerted };
}
