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

  it("allows owner-only confirmation for every supported offline payment method", () => {
    const block = rules.match(/match \/shiftHours\/\{appointmentId\} \{([\s\S]*?)\n    \}/)?.[1];
    expect(block).toBeTruthy();
    expect(block).toMatch(
      /resource\.data\.paymentMethod\s+in\s+\['cash',\s*'venmo',\s*'zelle'\]/,
    );
    expect(block).toMatch(/resource\.data\.caregiverId\s*==\s*request\.auth\.uid/);
    expect(block).toMatch(
      /\.hasOnly\(\['status',\s*'paidMethod',\s*'paidAt',\s*'cashConfirmedAt',\s*'updatedAt'\]\)/,
    );
  });
});
