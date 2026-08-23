import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rules = fs.readFileSync(path.join(process.cwd(), "firestore.rules"), "utf8");

describe("shiftHours security contract", () => {
  it("keeps timesheet creation server-only", () => {
    const block = rules.match(/match \/shiftHours\/\{appointmentId\} \{([\s\S]*?)\n    \}/)?.[1];
    expect(block).toBeTruthy();
    expect(block).toMatch(/allow create:\s*if false;/);
  });

  it("restricts all updates to admin — no client-direct cash-confirm exception (cash removed 2026-08-23)", () => {
    const block = rules.match(/match \/shiftHours\/\{appointmentId\} \{([\s\S]*?)\n    \}/)?.[1];
    expect(block).toBeTruthy();
    expect(block).toMatch(/allow update:\s*if isAdmin\(\);/);
    expect(block).not.toMatch(/paymentMethod\s+in\s+\['cash'/);
  });
});
