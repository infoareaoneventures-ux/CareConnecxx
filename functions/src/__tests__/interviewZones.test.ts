import { describe, it, expect, vi } from "vitest";

// Time zones (2026-11-09): the same interview instant is told to each person in THEIR OWN zone.
const docs = vi.hoisted(() => new Map<string, any>());
vi.mock("firebase-admin", () => {
  const db = { collection: (c: string) => ({ doc: (id: string) => ({ get: async () => ({ exists: docs.has(`${c}/${id}`), data: () => docs.get(`${c}/${id}`) }) }) }) };
  return { __esModule: true, default: { firestore: () => db }, firestore: () => db };
});

import { zoneForUser } from "../utils/personZone";
import { formatInterviewTime, formatInterviewTimeShort } from "../utils/scheduledTime";

describe("zoneForUser", () => {
  it("a family's home ZIP and a care provider's ZIP give their own zones; unknown people read as Pacific", async () => {
    docs.set("users/fam", { homeZipCode: "10001" });
    docs.set("caregivers/cg", { zipCode: "60601" });
    docs.set("users/cg", { phone: "+1555" });
    expect(await zoneForUser("fam")).toBe("America/New_York");
    expect(await zoneForUser("cg")).toBe("America/Chicago");
    expect(await zoneForUser("nobody")).toBe("America/Los_Angeles");
    expect(await zoneForUser(undefined)).toBe("America/Los_Angeles");
  });
  it("a stamped timeZone wins", async () => {
    docs.set("users/stamped", { timeZone: "America/Denver", zipCode: "10001" });
    expect(await zoneForUser("stamped")).toBe("America/Denver");
  });
});

describe("interview times told in each person's zone", () => {
  const ms = Date.UTC(2026, 10, 10, 17, 0); // 9:00 AM Pacific
  it("Pacific text is unchanged; other zones carry their name", () => {
    expect(formatInterviewTime(ms)).toBe("Tuesday, November 10 at 9:00 AM");
    expect(formatInterviewTime(ms, "America/New_York")).toBe("Tuesday, November 10 at 12:00 PM ET");
    expect(formatInterviewTime(ms, "America/Chicago")).toBe("Tuesday, November 10 at 11:00 AM CT");
    expect(formatInterviewTimeShort(ms, "America/Denver")).toBe("Tue, Nov 10, 10:00 AM MT");
    expect(formatInterviewTimeShort(ms, "Pacific/Honolulu")).toBe("Tue, Nov 10, 7:00 AM HT");
  });
});
