import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake browser session (Stagehand + Playwright page) ───────────────────────
const act = vi.fn(async () => {});
const extract = vi.fn();
const fill = vi.fn(async () => {});
const fakeSession = {
  sessionId: "sess1",
  stagehand: { act: (...a: unknown[]) => (act as Function).apply(null, a as any[]), extract: (...a: unknown[]) => (extract as Function).apply(null, a as any[]) },
  page: {
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    fill: (...a: unknown[]) => (fill as Function).apply(null, a as any[]),
    setDefaultTimeout: vi.fn(),
  },
};

vi.mock("./../browserbaseClient", () => ({
  createBrowserSession: vi.fn(async () => fakeSession),
  closeBrowserSession: vi.fn(async () => {}),
  withSessionTimeout: (_s: unknown, work: () => Promise<unknown>) => work(), // pass-through
  searchWeb: vi.fn(),
  fetchPage: vi.fn(),
  logBrowserSession: vi.fn(async () => {}),
}));
vi.mock("./../credentialVault", () => ({
  getCredential: vi.fn(async () => ({ username: "user@x.com", password: "s3cret-PW", portalUrl: "https://mychart.com" })),
  markCredentialUsed: vi.fn(async () => {}),
  insurerToServiceKey: (s: string) => s,
}));

import { findAppointmentSlots, bookAppointmentSlot } from "../careWebActions";

beforeEach(() => { act.mockClear(); extract.mockReset(); fill.mockClear(); });

describe("findAppointmentSlots — read-only discovery (H-U3)", () => {
  it("returns a concrete slot and never submits", async () => {
    extract.mockResolvedValueOnce({ provider: "Dr. Lee", datetime: "2026-06-23T14:30", location: "Northside" });
    const r = await findAppointmentSlots({ userId: "u1", phone: "+1", doctorName: "Dr. Lee" });
    expect(r.success).toBe(true);
    expect(r.slot).toMatchObject({ provider: "Dr. Lee", datetime: "2026-06-23T14:30" });
    // No commit during discovery.
    const actArgs = act.mock.calls.map((c: any[]) => String(c[0]).toLowerCase());
    expect(actArgs.some((a) => a.includes("submit the appointment"))).toBe(false);
  });
});

describe("loginWithFieldFill — credential security (H-U10)", () => {
  it("fills credentials via page.fill and never passes the password to act()", async () => {
    extract.mockResolvedValueOnce({ provider: "Dr. Lee", datetime: "2026-06-23T14:30" });
    await findAppointmentSlots({ userId: "u1", phone: "+1", doctorName: "Dr. Lee" });
    // page.fill received the username and password.
    const fillArgs = fill.mock.calls.map((c: any[]) => String(c[1]));
    expect(fillArgs).toContain("user@x.com");
    expect(fillArgs).toContain("s3cret-PW");
    // The password NEVER appears in any act() instruction.
    const everyActArg = act.mock.calls.map((c: any[]) => String(c[0])).join(" ");
    expect(everyActArg).not.toContain("s3cret-PW");
  });
});

describe("bookAppointmentSlot — verified commit (H-U3/H-U6)", () => {
  const slot = { provider: "Dr. Lee", datetime: "2026-06-23T14:30", location: "Northside" };

  it("commits and verifies a unique match → verified_success", async () => {
    extract.mockResolvedValueOnce({ matchCount: 1 }).mockResolvedValueOnce({ confirmationNumber: "A1234" });
    const r = await bookAppointmentSlot({ userId: "u1", phone: "+1", chosenSlot: slot });
    expect(r.status).toBe("verified_success");
    expect(r.confirmationNumber).toBe("A1234");
  });

  it("reports unverified when no confirmation evidence (not 'booked')", async () => {
    extract.mockResolvedValueOnce({ matchCount: 1 }).mockResolvedValueOnce({});
    const r = await bookAppointmentSlot({ userId: "u1", phone: "+1", chosenSlot: slot });
    expect(r.status).toBe("unverified");
    expect(r.result.toLowerCase()).toContain("awaiting");
  });

  it("does NOT submit when the slot is gone → slot_unavailable", async () => {
    extract.mockResolvedValueOnce({ matchCount: 0 });
    const r = await bookAppointmentSlot({ userId: "u1", phone: "+1", chosenSlot: slot });
    expect(r.status).toBe("slot_unavailable");
    const actArgs = act.mock.calls.map((c: any[]) => String(c[0]).toLowerCase());
    expect(actArgs.some((a) => a.includes("submit the appointment"))).toBe(false);
  });

  it("does NOT submit on ambiguity → slot_ambiguous", async () => {
    extract.mockResolvedValueOnce({ matchCount: 2 });
    const r = await bookAppointmentSlot({ userId: "u1", phone: "+1", chosenSlot: slot });
    expect(r.status).toBe("slot_ambiguous");
  });
});
