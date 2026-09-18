// Lapsed family membership — freeze at the lapse: scheduled visits always happen;
// no new visits from the day the lapse is seen; both sides told once with the
// last visit date; one reminder 3 days before it; reactivation resumes.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets: Array<{ path: string; data: any }> = [];
  const makeDoc = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any) => { sets.push({ path, data }); docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
  });
  const coll = (path: string): any => ({ doc: (id: string) => makeDoc(`${path}/${id}`) });
  return { docState, sets, coll, makeDoc, reset: () => { docState.clear(); sets.length = 0; } };
});
vi.mock("firebase-admin", () => ({
  firestore: Object.assign(() => ({ collection: hoisted.coll }), { FieldValue: { delete: () => ({ __delete: true }) } }),
}));
vi.mock("../config/appUrl", () => ({ appLink: (p: string) => `https://www.eviacares.com${p}` }));

import {
  decideMembershipLapse, applyMembershipLapse, freezeFamilyText, freezeCaregiverText, reminderFamilyText,
} from "./membershipLapse";

const TODAY = "2026-09-17";
const booking = { clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf", clientName: "Hamse M" };
const notifier = { client: vi.fn(async () => undefined), caregiver: vi.fn(async () => undefined) };
const lastScheduledVisit = vi.fn(async () => "2026-10-01");
const opts = { notifier, lastScheduledVisit };
// The harness stores only the fields written — merge them onto the booking like Firestore would.
const stored = (id = "b1") => ({ ...booking, ...hoisted.docState.get(`booking_requests/${id}`) });

beforeEach(() => { hoisted.reset(); notifier.client.mockClear(); notifier.caregiver.mockClear(); lastScheduledVisit.mockClear(); });

describe("decideMembershipLapse — the same fields the website's paywall reads", () => {
  it("active / trialing / subscriptionActive → active; anything else → frozen", () => {
    expect(decideMembershipLapse({ membershipStatus: "active" }, TODAY)).toEqual({ state: "active" });
    expect(decideMembershipLapse({ membershipStatus: "trialing" }, TODAY)).toEqual({ state: "active" });
    expect(decideMembershipLapse({ subscriptionActive: true, membershipStatus: "canceled" }, TODAY)).toEqual({ state: "active" });
    expect(decideMembershipLapse({ membershipStatus: "canceled" }, TODAY)).toEqual({ state: "frozen", lapsedAt: TODAY });
    expect(decideMembershipLapse({ membershipStatus: "past_due", membershipLapsedAt: "2026-09-03" }, TODAY)).toEqual({ state: "frozen", lapsedAt: "2026-09-03" });
  });
});

describe("applyMembershipLapse — what the daily generator does per booking", () => {
  it("active membership: generates as normal, no writes, no texts", async () => {
    hoisted.docState.set("users/c1", { membershipStatus: "active" });
    expect(await applyMembershipLapse(hoisted.makeDoc("booking_requests/b1"), booking, TODAY, new Map(), opts)).toBe("active");
    expect(hoisted.sets).toEqual([]);
    expect(notifier.client).not.toHaveBeenCalled();
  });

  it("first sighting: freezes at once — stamps the lapse, pauses the booking with the last visit date, texts BOTH sides once, generator skips it", async () => {
    hoisted.docState.set("users/c1", { membershipStatus: "canceled" });
    const ref = hoisted.makeDoc("booking_requests/b1");
    expect(await applyMembershipLapse(ref, booking, TODAY, new Map(), opts)).toBe("frozen");
    expect(hoisted.docState.get("users/c1").membershipLapsedAt).toBe(TODAY);
    expect(hoisted.docState.get("booking_requests/b1")).toMatchObject({ schedulePausedReason: "membership_lapsed", membershipLastScheduledVisit: "2026-10-01" });
    expect(lastScheduledVisit).toHaveBeenCalledWith("b1");
    expect(notifier.client).toHaveBeenCalledWith("c1", expect.stringContaining("still happen through Thursday, October 1, 2026"));
    expect(notifier.caregiver).toHaveBeenCalledWith("cg1", expect.stringContaining("still happen as scheduled"));
    expect(String((notifier.caregiver.mock.calls[0] as unknown as [string, string])[1])).not.toMatch(/paid|pay /i);
    // Next day: still frozen, no repeat texts.
    notifier.client.mockClear(); notifier.caregiver.mockClear();
    expect(await applyMembershipLapse(ref, stored(), "2026-09-18", new Map(), opts)).toBe("frozen");
    expect(notifier.client).not.toHaveBeenCalled();
    expect(notifier.caregiver).not.toHaveBeenCalled();
  });

  it("one reminder to the family three days before the last scheduled visit, never twice", async () => {
    hoisted.docState.set("users/c1", { membershipStatus: "canceled", membershipLapsedAt: "2026-09-17" });
    const ref = hoisted.makeDoc("booking_requests/b1");
    hoisted.docState.set("booking_requests/b1", { schedulePausedAt: "x", schedulePausedReason: "membership_lapsed", membershipLastScheduledVisit: "2026-10-01" });
    expect(await applyMembershipLapse(ref, stored(), "2026-09-27", new Map(), opts)).toBe("frozen");
    expect(notifier.client).not.toHaveBeenCalled(); // 4 days out — not yet
    expect(await applyMembershipLapse(ref, stored(), "2026-09-28", new Map(), opts)).toBe("frozen");
    expect(notifier.client).toHaveBeenCalledWith("c1", expect.stringContaining("last scheduled visit with Basra is Thursday, October 1, 2026"));
    notifier.client.mockClear();
    expect(await applyMembershipLapse(ref, stored(), "2026-09-29", new Map(), opts)).toBe("frozen");
    expect(notifier.client).not.toHaveBeenCalled();
  });

  it("reactivation: clears the stamp and the pause, tells both sides, generation resumes", async () => {
    hoisted.docState.set("users/c1", { membershipStatus: "active", membershipLapsedAt: "2026-09-01" });
    const ref = hoisted.makeDoc("booking_requests/b1");
    const paused = { ...booking, schedulePausedAt: "2026-09-15T00:00:00.000Z", schedulePausedReason: "membership_lapsed", membershipLastScheduledVisit: "2026-09-29" };
    expect(await applyMembershipLapse(ref, paused, TODAY, new Map(), opts)).toBe("active");
    expect(hoisted.sets.find((s) => s.path === "users/c1")?.data.membershipLapsedAt).toEqual({ __delete: true });
    expect(hoisted.sets.find((s) => s.path === "booking_requests/b1")?.data.schedulePausedAt).toEqual({ __delete: true });
    expect(notifier.client).toHaveBeenCalledWith("c1", expect.stringContaining("running again"));
    expect(notifier.caregiver).toHaveBeenCalledWith("cg1", expect.stringContaining("back on your schedule"));
  });

  it("the notices say the right things and promise no pay", () => {
    expect(freezeFamilyText("Basra Yousuf", "2026-10-01")).toContain("Basra's visits already on the calendar still happen through Thursday, October 1, 2026");
    expect(freezeFamilyText("Basra Yousuf", "2026-10-01")).toContain("/client/membership");
    expect(freezeFamilyText("Basra Yousuf", null)).toContain("visits already on the calendar still happen.");
    expect(freezeCaregiverText("Hamse M", "2026-10-01")).toContain("Your visits with them through Thursday, October 1, 2026 still happen as scheduled");
    expect(freezeCaregiverText("Hamse M", "2026-10-01")).not.toMatch(/paid|pay\b/i);
    expect(reminderFamilyText("Basra Yousuf", "2026-10-01")).toContain("Reactivate your membership");
  });
});
