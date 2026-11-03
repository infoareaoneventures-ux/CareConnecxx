import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// P0 privacy fixes (2026-11-03). Text-level contract on firestore.rules, same
// style as shiftHoursSecurityContract.test.ts.
const rules = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");

function block(match: string): string {
  const start = rules.indexOf(`match /${match}`);
  expect(start, `rules block for ${match}`).toBeGreaterThan(-1);
  const body = rules.slice(start).match(/^[^\n]*\{([\s\S]*?)\n    \}/)?.[1];
  expect(body).toBeTruthy();
  return body!;
}

describe("account_action_requests privacy", () => {
  const b = block("account_action_requests/{requestId}");

  it("allows a single get by id (the request's own listener)", () => {
    expect(b).toMatch(/allow get:\s*if true;/);
  });

  it("never allows listing — `read` would include `list` and expose every token/code/email/phone", () => {
    expect(b).toMatch(/allow list:\s*if false;/);
    expect(b).not.toMatch(/allow read\b/);
  });
});

describe("job_postings privacy", () => {
  const b = block("job_postings/{postId}");

  it("is readable only by the owning family or an admin — it carries the home address", () => {
    expect(b).toMatch(/allow read:\s*if isOwner\(postId\) \|\| isAdmin\(\);/);
    expect(b).not.toMatch(/allow read:\s*if isAuthenticated\(\);/);
  });
});
