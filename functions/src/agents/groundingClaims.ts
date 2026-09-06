// U7 (memory-grounding hardening, R18): pure output-only claim classifier.
//
// Given a DRAFT reply Evia is about to send, classify the specific factual /
// action claims it asserts into categories with a risk tier. This module is the
// risk-aware successor to qaAgent's detectConfidenceClaim pattern list: that
// detector required a proper name (or "I ...") in the sentence, so pronoun-led
// claims — "She has Parkinson's", "She is allergic to penicillin", "She is 82",
// "She lives in Sacramento" — slipped past the grounding gate entirely (the
// plan's confirmed false negatives). Every pattern the legacy detector caught
// is absorbed here so nothing currently gated is lost.
//
// PURITY CONTRACT: no I/O, no model calls, no firebase imports, no env reads.
// The classifier only decides whether the (existing) verifier LLM call runs and
// which risk tier applies to its outcome; it never blocks a reply by itself.
// Like the legacy detector it errs WIDE by design — a false positive costs one
// quick-tier verifier call, a false negative ships an invented fact to a family.
//
// Risk tiers (plan R18/R19; schedule_appointment/caregiver_availability moved
// to HIGH 2026-09-06 — see below):
//   high — medical (condition / allergy / prior medical event), identity or
//          relationship, action/authorization ("I've booked/cancelled/..."),
//          money/payment, schedule/appointment, and caregiver availability.
//          An unverifiable high-risk claim FAILS CLOSED to deterministic
//          neutral copy (see humanHandoff.neutralCopyForClaims).
//   low  — age, location/address. An unverifiable low-risk claim keeps the
//          documented pre-U7 fallback (fail-open to sending — see the
//          qaAgent gate).
//
// 2026-09-06: schedule_appointment and caregiver_availability were promoted
// from low to high risk after a live incident — a family edited an
// interview's scheduledTime directly in Firestore, and Evia kept repeating
// the stale original date/time on every subsequent turn (including after
// being asked "are you sure"). The grounding verifier had rated the stale
// claim SUPPORTED because it was consistent with what Evia itself had said
// earlier in RECENT CONVERSATION — but a scheduled-item's real status can
// change independently of the conversation (site-side edits, cancellations,
// admin overrides), so "consistent with what was said before" isn't the same
// as "still true now." See the companion prompt hardening in
// HANDOFF_GROUNDING_SYSTEM_PROMPT (humanHandoff.ts), which makes RECENT
// CONVERSATION alone insufficient support for exactly these two categories.
// This closes the gap for the whole product, not just interviews — any
// handler whose draft reply asserts a schedule/availability fact goes
// through this same shared classifier + verifier.

export type GroundingClaimCategory =
  | "medical_condition"       // diagnosis / condition / medication / vital
  | "allergy"                 // "is allergic to penicillin"
  | "medical_event"           // prior stroke / fall / hospitalization / surgery
  | "age"                     // "She is 82", "82 years old"
  | "location"                // "She lives in Sacramento", street address
  | "relationship_identity"   // "Maria is her daughter", "he is your caregiver"
  | "schedule_appointment"    // appointment / visit / shift tied to a day/time
  | "caregiver_availability"  // "Maria is free Wednesday", "she is available"
  | "action_authorization"    // "I've booked/cancelled/authorized/paid…"
  | "money_payment";          // amounts, invoices, completed payments/refunds

export type GroundingRisk = "high" | "low";

export interface GroundingClaim {
  category: GroundingClaimCategory;
  risk: GroundingRisk;
}

const HIGH_RISK_CATEGORIES: ReadonlySet<GroundingClaimCategory> = new Set([
  "medical_condition",
  "allergy",
  "medical_event",
  "relationship_identity",
  "action_authorization",
  "money_payment",
  "schedule_appointment",
  "caregiver_availability",
]);

export function riskForCategory(category: GroundingClaimCategory): GroundingRisk {
  return HIGH_RISK_CATEGORIES.has(category) ? "high" : "low";
}

// Named conditions asserted flatly ("has Parkinson's") — no proper name needed.
// Deliberately a lexicon, not a catch-all `has \w+` (which would flag "has a
// question"). Extend freely; each entry is a stated-medical-fact false-negative
// closed.
const CONDITION_LEXICON =
  "parkinson'?s?|alzheimer'?s?|dementia|diabetes|hypertension|copd|cancer|" +
  "arthritis|osteoporosis|epilepsy|asthma|glaucoma|anemia|shingles|gout|" +
  "kidney (?:disease|failure)|renal (?:disease|failure)|liver disease|" +
  "heart (?:disease|failure|condition)|afib|atrial fibrillation|" +
  "a\\s+uti|pneumonia|depression|anxiety|parkinsons|als|ms|multiple sclerosis";

// Category → pattern list. Sentence-level regexes over the raw draft. The
// legacy CONFIDENCE_CLAIM_PATTERNS / MEDICAL_ASSERTION_PATTERNS entries are
// ported verbatim (marked "legacy") so current coverage is a strict subset.
const CLAIM_PATTERNS: ReadonlyArray<[GroundingClaimCategory, RegExp]> = [
  // ── medical condition / diagnosis / medication / vital (HIGH) ──────────────
  ["medical_condition", /\b(?:was|were|is|are|has|have|had|been)\s+diagnos\w+/i],                        // legacy
  ["medical_condition", /\bdiagnos\w+\s+with\b/i],                                                        // legacy
  ["medical_condition", /\b(?:is|was|are|were)\s+(?:on|taking|prescribed)\s+\w+/i],                       // legacy
  ["medical_condition", /\b(?:blood pressure|heart rate|blood sugar|temperature|oxygen|o2 sat)\s+(?:is|was|of|reads?|=|:)?\s*\d/i], // legacy
  ["medical_condition", new RegExp(
    `\\b(?:has|have|had|suffers?\\s+from|lives?\\s+with|is\\s+living\\s+with|battling)\\s+` +
    `(?:early[- ]stage\\s+|late[- ]stage\\s+|advanced\\s+|mild\\s+|moderate\\s+|severe\\s+|type\\s+[12]\\s+)?` +
    `(?:${CONDITION_LEXICON})\\b`, "i")],                                                                 // widened: legacy list required a name-free subset

  // ── allergy (HIGH) ──────────────────────────────────────────────────────────
  ["allergy", /\b(?:is|are|was|were)\s+(?:\w+\s+)?allergic\b/i],
  ["allergy", /\ballergic\s+to\s+\w+/i],
  ["allergy", /\b(?:has|have|had)\s+(?:a\s+|an\s+)?(?:\w+\s+)?allerg(?:y|ies)\b/i],
  ["allergy", /\ballerg(?:y|ies)\s+(?:to|includes?|are|is)\b/i],

  // ── prior medical event (HIGH) ──────────────────────────────────────────────
  ["medical_event", /\b(?:had|suffered|experienced|survived)\s+(?:a|an|another|two|three|multiple|several)?\s*(?:mild\s+|minor\s+|major\s+|massive\s+|bad\s+)?(?:strokes?|heart attacks?|seizures?|falls?|fractures?|surger(?:y|ies)|concussions?|tias?|hip replacements?)\b/i],
  ["medical_event", /\b(?:was|were|got|has been|have been)\s+hospitali[sz]ed\b/i],
  ["medical_event", /\b(?:was|were)\s+(?:taken|rushed|admitted)\s+to\s+the\s+(?:hospital|er|emergency room)\b/i],
  ["medical_event", /\bfell\s+(?:last|yesterday|this|down|at|in|on)\b/i],

  // ── age (LOW) ───────────────────────────────────────────────────────────────
  // "She is 82" / "she's 82" / "just turned 90" — number must not be a clock
  // time, duration, amount, or percentage (the lookahead), so "the visit is 30
  // minutes" and "at 3pm" don't classify as age claims.
  ["age", /\b(?:is|was|turned|turns|turning|(?:she|he)'s)\s+\d{1,3}\b(?!\s*(?::\d|%|am\b|pm\b|a\.m|p\.m|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|miles?\b|dollars?\b|cents?\b|percent\b|degrees?\b))/i],
  ["age", /\b\d{1,3}\s*(?:years?|yrs?)[\s-]*old\b/i],
  ["age", /\b\d{1,3}[- ]year[- ]old\b/i],

  // ── location / address (LOW) ────────────────────────────────────────────────
  ["location", /\b(?:lives?|lived|living|resides?|resided|residing|stays?|staying)\s+(?:in|at|on|near|over in|out in)\b/i],
  ["location", /\b(?:is|are)\s+(?:located|based)\s+(?:in|at|near)\b/i],
  ["location", /\b\d+\s+[A-Za-z][\w']*\s+(?:st(?:reet)?|ave(?:nue)?|blvd|boulevard|dr(?:ive)?|rd|road|lane|ln|court|ct|way|pl(?:ace)?)\b/i],
  ["location", /\b(?:her|his|your|their|the)\s+(?:address|zip(?:\s*code)?)\s+is\b/i],

  // ── relationship / identity (HIGH) ──────────────────────────────────────────
  ["relationship_identity", /\b[A-Z][a-z]+\s+is\s+(?:her|his|your|their|the)\s+\w+/],                     // legacy ("Dr. Chen is her primary physician")
  ["relationship_identity", /\b(?:she|he|they)(?:'s|'re|\s+(?:is|are))\s+(?:your|her|his|their|my)\s+(?:\w+\s+)?(?:daughter|son|mother|father|mom|dad|sister|brother|wife|husband|spouse|partner|aunt|uncle|cousin|grandmother|grandfather|granddaughter|grandson|niece|nephew|neighbor|caregiver|physician|doctor|nurse|guardian|emergency contact)\b/i],
  ["relationship_identity", /\b(?:her|his|your|their)\s+(?:primary\s+)?(?:physician|doctor|caregiver|nurse|guardian|emergency contact|power of attorney)\s+is\b/i],
  ["relationship_identity", /\bis\s+(?:her|his|your|their)\s+power of attorney\b/i],

  // ── schedule / appointment (HIGH, 2026-09-06) ───────────────────────────────
  ["schedule_appointment", /\b(?:appointment|shift|booking|interview|visit)\b.{0,40}\b(?:is|was|on|at|scheduled|booked|confirmed|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i], // legacy
  ["schedule_appointment", /\b(?:at|by|on)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i],                         // legacy
  ["schedule_appointment", /\b[A-Z][a-z]+\s+(?:will|'ll|is going to|is gonna)\s+\w+/],                    // legacy ("Maria will arrive at 3")
  ["schedule_appointment", /\b(?:she|he|they)\s+(?:will|'ll)\s+(?:arrive|be there|be here|come|stop by|visit)\b/i],

  // ── caregiver availability (HIGH, 2026-09-06) ───────────────────────────────
  ["caregiver_availability", /\b[A-Z][a-z]+(?:'s| is)\s+(?:free|available|booked|coming|out|sick|here|on|off|done)\b/],   // legacy
  ["caregiver_availability", /\b(?:she|he|they|your caregiver|the caregiver)(?:'s|'re|\s+(?:is|are))\s+(?:free|available|unavailable|fully booked|booked|off|out sick|on shift|off shift)\b/i],
  ["caregiver_availability", /\b(?:no|a few|several|\d+)\s+caregivers?\s+(?:are|is)\s+(?:free|available|open)\b/i],

  // ── action / authorization (HIGH) ───────────────────────────────────────────
  ["action_authorization", /\bI\s+(?:confirmed|scheduled|cancelled|canceled|booked|moved|paid|refunded)\b/i],             // legacy
  ["action_authorization", /\bI(?:'ve| have| just| already)+\s+(?:just\s+|already\s+)?(?:confirmed|scheduled|cancelled|canceled|booked|moved|paid|refunded|authorized|approved|charged|submitted|sent|processed|set (?:that |this |it )?up)\b/i],
  ["action_authorization", /\bI\s+(?:authorized|approved|charged|submitted|processed|went ahead and \w+)\b/i],
  ["action_authorization", /\b(?:has|have)\s+been\s+(?:confirmed|scheduled|cancelled|canceled|booked|paid|refunded|authorized|approved|processed)\b/i],
  ["action_authorization", /\b(?:is|was)\s+(?:now\s+|all\s+)?(?:confirmed|cancelled|canceled|booked|scheduled|authorized|approved|processed|set)\b(?:\s*[.!—-]|\s+for\b|\s+and\b|$)/i],

  // ── money / payment (HIGH) ──────────────────────────────────────────────────
  ["money_payment", /\$\s?\d[\d,]*(?:\.\d+)?/],                                                           // legacy
  ["money_payment", /\b\d+(?:\.\d{2})?\s+dollars\b/i],
  ["money_payment", /\binvoice\b.{0,40}\b(?:is|was|of|for|totals?|came to)\b/i],
  ["money_payment", /\b(?:payment|refund|charge|payout|deposit)\b.{0,40}\b(?:went through|was (?:processed|issued|sent|completed|charged|refunded)|has been (?:processed|issued|sent|completed|charged|refunded)|is (?:complete|processed|on its way))\b/i],
  ["money_payment", /\b(?:you|they|she|he)\s+(?:were|was)\s+(?:charged|refunded|billed|paid)\b/i],
];

const CATEGORY_ORDER: ReadonlyArray<GroundingClaimCategory> = [
  "medical_condition",
  "allergy",
  "medical_event",
  "age",
  "location",
  "relationship_identity",
  "schedule_appointment",
  "caregiver_availability",
  "action_authorization",
  "money_payment",
];

// Classify the claims a draft asserts. Returns at most one claim per category
// (deduped, in stable CATEGORY_ORDER) — the gate cares about which categories
// are present and the highest risk tier, not how many sentences matched.
export function classifyGroundingClaims(draft: string): GroundingClaim[] {
  const text = draft ?? "";
  if (!text.trim()) return [];
  const hit = new Set<GroundingClaimCategory>();
  for (const [category, pattern] of CLAIM_PATTERNS) {
    if (!hit.has(category) && pattern.test(text)) hit.add(category);
  }
  return CATEGORY_ORDER.filter((c) => hit.has(c)).map((category) => ({
    category,
    risk: riskForCategory(category),
  }));
}

// Convenience predicate — the risk-tier replacement for detectConfidenceClaim.
export function detectGroundingClaim(draft: string): boolean {
  return classifyGroundingClaims(draft).length > 0;
}

export function highestGroundingRisk(claims: ReadonlyArray<GroundingClaim>): GroundingRisk | null {
  if (!claims.length) return null;
  return claims.some((c) => c.risk === "high") ? "high" : "low";
}

export function claimCategories(claims: ReadonlyArray<GroundingClaim>): GroundingClaimCategory[] {
  return claims.map((c) => c.category);
}

// ── Telemetry hash (R21) ──────────────────────────────────────────────────────
// FNV-1a 32-bit, same algorithm as turnCheckpoint.hashText / promptExperiments
// (duplicated here so this module stays dependency-free — turnCheckpoint pulls
// in firebase-admin). Used to correlate grounding telemetry (uncertainty log,
// ops alerts, console lines) with a turn WITHOUT storing the raw message,
// draft, or prior reply anywhere in the telemetry path.
export function groundingTelemetryHash(text: string): string {
  let h = 0x811c9dc5;
  const s = (text ?? "").trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
