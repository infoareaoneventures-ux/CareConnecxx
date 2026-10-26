// Evia's voice guard (2026-10-26, context/evia-voice.md): the fixed lines a
// scripted flow or a notice sends must not use the old reply-protocol grammar
// ("Reply SUBMIT to send, or CANCEL", "Reply with a number…", quoted commands).
// Files are converted batch by batch: a CONVERTED file must be clean; any other
// file that still has such lines must be on the PENDING list (the remaining
// inventory), so a NEW file cannot ship with the old grammar unnoticed.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(__dirname, "../..");

/** Converted to Evia's voice — must stay clean. */
const CONVERTED = [
  "agents/jobBoardText.ts",
  "agents/caregiverJobFlows.ts",
  "agents/interviewFlow.ts",
  "agents/decisionNotices.ts",
  "triggers/newJobNotice.ts",
  // Batch 2 (bookings + visits)
  "agents/caregiverBookingRequests.ts",
  "agents/caregiverActiveBookings.ts",
  "agents/caregiverPastBookings.ts",
  "agents/caregiverShiftProposal.ts",
  "agents/inShift.ts",
  "agents/visitMode.ts",
  "scheduled/pendingDecisionNudge.ts",
  "triggers/notificationTriggers.ts",
];

/** Still on the old grammar — the next batches (context/evia-voice.md, Rollout). Shrinks as batches land. */
const PENDING = [
  "agents/adminAssist.ts",
  "agents/availabilityHandler.ts",
  "agents/bookingFlow.ts",
  "agents/cancelFlow.ts",
  "agents/caregiverAccessGate.ts",
  "agents/caregiverCalendar.ts",
  "agents/caregiverCancelShiftHandler.ts",
  "agents/caregiverFamilies.ts",
  "agents/caregiverMembership.ts",
  "agents/caregiverMyProfile.ts",
  "agents/caregiverPayouts.ts",
  "agents/caregiverProfileHandler.ts",
  "agents/caregiverSettings.ts",
  "agents/caregiverTimesheets.ts",
  "agents/correctionFlow.ts",
  "agents/familyIntakeScript.ts",
  "agents/familyRelay.ts",
  "agents/instantPayoutHandler.ts",
  "agents/jobPostingFlow.ts",
  "agents/onboardingConversation.ts",
  "agents/profileCompleteness.ts",
  "agents/replacementFlow.ts",
  "agents/rescheduleFlow.ts",
  "agents/reviewFlow.ts",
  "agents/visitRequestFlow.ts",
  "linq/webhooks.ts",
  "mcp/server.ts",
  "scheduled/caregiverTimesheetReminders.ts",
  "scheduled/pendingTimesheetNudge.ts",
  "scheduled/staleSessionNudge.ts",
];

/** Carrier / consent protocol text (TCPA opt-in, STOP) — the wording is the protocol, not Evia's voice. */
const EXEMPT = [
  "triggers/userCreated.ts",
];

const SCAN_DIRS = ["agents", "triggers", "scheduled", "mcp", "linq"];

/** The old grammar, toward a user. */
const ROBOTIC: RegExp[] = [
  /\bReply (with a number|[A-Z]{2,}\b)/,
  /\breply (JOBS|MORE|YES|NO|SUBMIT|SEND|CANCEL|SKIP|ACCEPT|DECLINE|VIEW|INTERVIEW|DETAILS|APPLY|CONFIRM|KEEP|PROPOSE|REVIEW|COUNTER|START|DONE|FINISH)\b/,
  /"(apply|hide|accept|decline|submit) (to |\$\{)?\d?/,
  / — reply /,
];

/** A line that is a comment, or an instruction to the MODEL (a classifier / extraction prompt), not a text to a person. */
const NOT_USER_FACING = [
  /^\s*(\/\/|\*|\/\*)/,
  /\bONLY\b/i,
  /\bClassify\b/,
  /\bexactly\b/,
  /\bor NONE\b/,
  /\bone word\b/i,
  /\bReply with (that|it|the|a JSON|ONLY)/,
  /\b(if|whether|when) (the|their|she|he|they|a|this|it)\b/,
  /\b(quickComplete|parseWithClaude|parse|classify\w*)\(/,
  /\bprompt\b/i,
  /toContain|toBe\(|toMatch|expect\(/,
  /^\s*context: /,
  /\breply NONE\b/,
  /\bReply (YES|NO) (if|for|only|when)\b/,
  /\b(asked|texted) (the|a) (user|person|new client)\b/,
  /text message say/,
  /texted while the team/,
];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "__tests__") out.push(...listTs(p)); continue; }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function roboticLines(file: string): string[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (NOT_USER_FACING.some((re) => re.test(line))) return;
    if (ROBOTIC.some((re) => re.test(line))) hits.push(`${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  return hits;
}

describe("Evia's voice — no reply-protocol grammar in converted files", () => {
  const rel = (file: string) => path.relative(src, file).replace(/\\/g, "/");
  const offenders = new Map<string, string[]>();
  for (const dir of SCAN_DIRS) {
    for (const file of listTs(path.join(src, dir))) {
      const hits = roboticLines(file);
      if (hits.length && !EXEMPT.includes(rel(file))) offenders.set(rel(file), hits);
    }
  }

  it("every converted file is clean", () => {
    const bad = CONVERTED.filter((f) => offenders.has(f)).map((f) => `${f}\n  ${offenders.get(f)!.join("\n  ")}`);
    expect(bad).toEqual([]);
  });

  it("a file with the old grammar is either converted or on the PENDING list (the remaining inventory)", () => {
    const unknown = [...offenders.keys()].filter((f) => !CONVERTED.includes(f) && !PENDING.includes(f))
      .map((f) => `${f}\n  ${offenders.get(f)!.join("\n  ")}`);
    expect(unknown).toEqual([]);
  });

  it("the PENDING list names only files that still need the pass (drop a file once it is clean)", () => {
    const stale = PENDING.filter((f) => !offenders.has(f));
    expect(stale).toEqual([]);
  });

  it("converted files are not also listed as pending", () => {
    expect(CONVERTED.filter((f) => PENDING.includes(f))).toEqual([]);
  });
});
