// Founder 2026-10-12: the people who give care are "care providers" in everything a
// family, a care provider or the admin team reads. Code identifiers keep the legacy
// spelling (caregivers/{uid}, caregiverId, caregiver_ask_rate, update_caregiver_profile,
// userType "caregiver"), so this guard reads the STRING LITERALS of the notice /
// reminder / flow modules through the TypeScript AST (the way pricingLiterals.test.ts
// scans source text) and fails on a visible "caregiver" — never on an identifier,
// a comment, a Firestore path, a URL or a bare machine value.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, relative, sep } from "path";
import * as ts from "typescript";

const SRC_ROOT = resolve(__dirname, "..");

// Every module whose string literals are texted, belled or emailed to a person
// (or handed to the model as the words to say). Directories are scanned whole.
const GUARDED = [
  "notifications",
  "scheduled",
  "triggers/notificationTriggers.ts",
  "triggers/caregiverAccountEvents.ts",
  "triggers/newJobNotice.ts",
  "triggers/familyVisitUpdates.ts",
  "agents/caregiverActiveBookings.ts",
  "agents/caregiverPastBookings.ts",
  "agents/caregiverCalendar.ts",
  "agents/caregiverTimesheets.ts",
  "agents/caregiverPayouts.ts",
  "agents/caregiverMembership.ts",
  "agents/caregiverSettings.ts",
  "agents/caregiverMyProfile.ts",
  "agents/caregiverProfilePage.ts",
  "agents/caregiverJobFlows.ts",
  "agents/caregiverInterviewsTab.ts",
  "agents/caregiverBookingRequests.ts",
  "agents/caregiverCancelShiftHandler.ts",
  "agents/caregiverSearch.ts",
  "agents/caregiverMatchScoring.ts",
  "agents/caregiverOnboardingDirective.ts",
  "agents/onboardingDirective.ts",
  "agents/onboardingConversation.ts",
  "agents/interviewsTab.ts",
  "agents/jobBoardText.ts",
  "agents/decisionNotices.ts",
  "agents/familyRelay.ts",
  "agents/inShift.ts",
  "agents/visitMode.ts",
  "agents/notificationsPage.ts",
  "agents/terminology.ts",
  "agents/qaAgent.ts",
  "agents/defaultPromptAugmenters.ts",
  "agents/emotionalContext.ts",
  "safety/supervisor.ts",
  "linq/webhooks.ts",
  "mcp/server.ts",
  "shiftHours.ts",
  "stripe.ts",
  "checkr.ts",
  "backgroundCheckConsent.ts",
  "bgcheckConsentRequest.ts",
  "email.ts",
  "notifications.ts",
  "adminAlerts.ts",
  "utils/caraMessage.ts",
];

const VISIBLE_WORD = /\b[Cc]aregivers?\b|\bCAREGIVERS?\b/;

function listFiles(target: string): string[] {
  const full = join(SRC_ROOT, target);
  if (!statSync(full).isDirectory()) return [full];
  const out: string[] = [];
  for (const name of readdirSync(full)) {
    const p = join(full, name);
    if (statSync(p).isDirectory()) { if (name !== "__tests__") out.push(...listFiles(relative(SRC_ROOT, p))); continue; }
    if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The literal's text with everything that is a machine name taken out. */
function visibleText(raw: string): string {
  return raw
    .split(/(\s+)/)
    .filter((tok) => !(
      /:\/\/|^\/|\.[a-z]{2,}\//i.test(tok) ||        // URL / path token (/caregiver/jobs, eviacares.com/…)
      /[_{}$.]|\/\{|s\//.test(tok) ||                  // caregiver_ask_rate, caregivers/{uid}, data.caregiverId, caregivers/
      /^["'`]caregivers?["'`][,.:;)]*$/i.test(tok)     // a quoted machine value: role: "caregiver"
    ))
    .join("");
}

/** A console/logger call's arguments are never read by a person. */
function inLogCall(n: ts.Node): boolean {
  for (let p = n.parent; p && !ts.isSourceFile(p) && !ts.isFunctionLike(p); p = p.parent) {
    if (ts.isCallExpression(p) && /^(console|logger|functions\.logger)\.(log|warn|error|info|debug)$/.test(p.expression.getText())) return true;
  }
  return false;
}

function offendersIn(file: string): string[] {
  const src = readFileSync(file, "utf8");
  if (!/caregiver/i.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    const isLit = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
    if (isLit && !inLogCall(n)) {
      const text = (n as ts.LiteralLikeNode).text;
      // A bare value ("caregiver", "caregivers") or an identifier-shaped literal is a machine name.
      const bare = /^(caregivers?|Caregivers?)$/.test(text) || !/\s/.test(text);
      if (!bare && VISIBLE_WORD.test(visibleText(text))) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        found.push(`${relative(SRC_ROOT, file).split(sep).join("/")}:${line + 1}: ${text.replace(/\s+/g, " ").slice(0, 110)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('visible text says "care provider", never "caregiver" (founder 2026-10-12)', () => {
  for (const target of GUARDED) {
    it(`${target} has no visible "caregiver" in any string literal`, () => {
      const offenders = listFiles(target).flatMap(offendersIn);
      expect(offenders, `say "care provider" instead:\n${offenders.join("\n")}`).toEqual([]);
    });
  }

  it("the scanner itself catches a visible word and ignores machine names", () => {
    expect(VISIBLE_WORD.test(visibleText("Your caregiver cancelled the visit."))).toBe(true);
    expect(VISIBLE_WORD.test(visibleText("Caregiver: Jane"))).toBe(true);
    expect(VISIBLE_WORD.test(visibleText("open https://eviacares.com/caregiver/jobs today"))).toBe(false);
    expect(VISIBLE_WORD.test(visibleText("writes caregivers/{uid} and data.caregiverId"))).toBe(false);
    expect(VISIBLE_WORD.test(visibleText('role: "caregiver" on the session'))).toBe(false);
    expect(VISIBLE_WORD.test(visibleText("step caregiver_ask_rate then update_caregiver_profile"))).toBe(false);
  });
});
