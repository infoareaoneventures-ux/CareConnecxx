import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver "still waiting on you" nudges (pendingDecisionNudge.ts): interview
// requests, booking requests, replacement requests, schedule changes.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sessionSets: [] as Array<{ phone: string; data: any }>,
  bells: [] as any[],
  sends: [] as any[],
  /** "text" / "bell" in the order they happened — the lockstep proof */
  order: [] as string[],
  sendResult: true,
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })),
        update: vi.fn(async (d: any) => { hoisted.updates.push({ path: `${name}/${id}`, data: d }); hoisted.docs.set(`${name}/${id}`, { ...hoisted.docs.get(`${name}/${id}`), ...d }); }),
        set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionSets.push({ phone: id, data: d }); }),
      }),
      where: (f: string, _op: string, v: any) => ({
        limit: () => ({
          get: vi.fn(async () => {
            const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && d[f] === v).map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
            return { docs, empty: docs.length === 0 };
          }),
        }),
      }),
    }),
  }), { FieldValue: { serverTimestamp: () => "__ts__", delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("firebase-functions/v1", () => ({ pubsub: { schedule: () => ({ onRun: (fn: any) => fn }) } }));
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async (phone: string, out: any) => { hoisted.sends.push({ phone, out }); hoisted.order.push("text"); return hoisted.sendResult; }) }));
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); hoisted.order.push("bell"); return true; }) }));
vi.mock("../../utils/caregiverPhone", () => ({ resolveCaregiverPhone: vi.fn(async (id: string) => (id === "cg1" ? "+1408" : undefined)) }));

import { shouldNudgePendingDecision, runPendingDecisionNudges, toMs, NUDGE_DELAY_MS, RENUDGE_COOLDOWN_MS, REPLACEMENT_DELAY_MS, REPLACEMENT_EXPIRY_MS, REPLACEMENT_NUDGE_BEFORE_EXPIRY_MS, MAX_NUDGES } from "../pendingDecisionNudge";

const NOW = Date.parse("2099-03-10T18:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionSets.length = 0; hoisted.bells.length = 0; hoisted.sends.length = 0; hoisted.order.length = 0; hoisted.sendResult = true; hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1" }); });

describe("shouldNudgePendingDecision", () => {
  it("24h after the request, then every 48h; a replacement ONCE, 10 minutes before its 30-minute expiry, never at or after it (B6)", () => {
    expect(shouldNudgePendingDecision({ createdMs: NOW - NUDGE_DELAY_MS + 1000, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - NUDGE_DELAY_MS - 1000, lastNudgedMs: null, nowMs: NOW })).toBe(true);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 5 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS + 1000, nowMs: NOW })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 5 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS - 1000, nowMs: NOW })).toBe(true);
    // Replacement: the family's Needs Replacement wait is 30 minutes (shiftGenerator.ts expireStaleShiftReplacements reads REPLACEMENT_EXPIRY_MS).
    expect(REPLACEMENT_EXPIRY_MS).toBe(30 * 60 * 1000);
    expect(REPLACEMENT_DELAY_MS).toBe(REPLACEMENT_EXPIRY_MS - REPLACEMENT_NUDGE_BEFORE_EXPIRY_MS);
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_DELAY_MS - 1000, lastNudgedMs: null, nowMs: NOW, replacement: true, visitDate: "2099-03-11", today: "2099-03-10" })).toBe(true);
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_DELAY_MS + 1000, lastNudgedMs: null, nowMs: NOW, replacement: true })).toBe(false);          // too early
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_EXPIRY_MS, lastNudgedMs: null, nowMs: NOW, replacement: true })).toBe(false);               // at expiry — never
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_EXPIRY_MS - 60_000, lastNudgedMs: null, nowMs: NOW, replacement: true })).toBe(false);      // after expiry — never
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_DELAY_MS - 1000, lastNudgedMs: NOW - 1000, nowMs: NOW, replacement: true })).toBe(false);   // already nudged once
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_DELAY_MS - 1000, lastNudgedMs: null, nowMs: NOW, replacement: true, nudgeCount: 1 })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_DELAY_MS - 1000, lastNudgedMs: null, nowMs: NOW, replacement: true, visitDate: "2099-03-09", today: "2099-03-10" })).toBe(false); // the visit is gone
    expect(shouldNudgePendingDecision({ createdMs: null, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    // Cap (founder 2026-09-29): three nudges for a booking request / schedule change / interview, then silence.
    expect(shouldNudgePendingDecision({ createdMs: NOW - 9 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS - 1000, nowMs: NOW, nudgeCount: 2 })).toBe(true);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 9 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS - 1000, nowMs: NOW, nudgeCount: MAX_NUDGES })).toBe(false);
  });
  it("reads either side's timestamp shape", () => {
    expect(toMs("2099-03-10T00:00:00.000Z")).toBe(Date.parse("2099-03-10T00:00:00.000Z"));
    expect(toMs({ toMillis: () => 5 })).toBe(5);
    expect(toMs({ seconds: 7 })).toBe(7000);
    expect(toMs(undefined)).toBeNull();
  });
});

describe("runPendingDecisionNudges", () => {
  it("nudges an unanswered interview request with the notice's words, mirrors the bell, re-parks the decision, stamps the window", async () => {
    hoisted.docs.set("video_interviews/iv1", { status: "requested", caregiverId: "cg1", clientName: "Basra Yousuf", jobTitle: "Senior care in San Jose", scheduledTime: "2099-03-28T16:00:00.000Z", createdAt: ago(NUDGE_DELAY_MS + 60_000) });
    const r = await runPendingDecisionNudges(NOW);
    expect(r).toEqual({ nudged: 1, bellKeptOptedOut: 0, dropped: 0, skipped: 0 });
    expect(hoisted.sends[0].out.content).toMatch(/^Basra Yousuf's interview request for "Senior care in San Jose" \(.+\) is still waiting on you\. Reply ACCEPT or DECLINE, or PROPOSE a different time\.$/);
    expect(hoisted.bells[0]).toMatchObject({ sourcePath: "video_interviews/iv1", eventId: "decision-nudge-1", recipientId: "cg1", title: "Still waiting on you", data: { interviewId: "iv1" } });
    // Bell ⇄ text (C11): the text went first, the bell followed it.
    expect(hoisted.order).toEqual(["text", "bell"]);
    expect(hoisted.sessionSets[0].data.pendingDecision).toMatchObject({ kind: "interview_request", recordId: "iv1" });
    expect(hoisted.updates[0]).toEqual({ path: "video_interviews/iv1", data: { decisionNudgeCount: 1, decisionNudgedAt: new Date(NOW).toISOString() } });
  });

  it("skips: too new, answered, the caregiver's own proposal out, an interview whose time has passed", async () => {
    hoisted.docs.set("video_interviews/new", { status: "requested", caregiverId: "cg1", createdAt: ago(60_000), scheduledTime: "2099-03-28T16:00:00.000Z" });
    hoisted.docs.set("video_interviews/done", { status: "accepted", caregiverId: "cg1", createdAt: ago(9 * NUDGE_DELAY_MS) });
    hoisted.docs.set("video_interviews/mine", { status: "requested", caregiverId: "cg1", createdAt: ago(9 * NUDGE_DELAY_MS), scheduledTime: "2099-03-28T16:00:00.000Z", reschedulePendingTime: "x", rescheduledBy: "caregiver" });
    hoisted.docs.set("video_interviews/past", { status: "requested", caregiverId: "cg1", createdAt: ago(9 * NUDGE_DELAY_MS), scheduledTime: "2000-01-01T16:00:00.000Z" });
    const r = await runPendingDecisionNudges(NOW);
    expect(r.nudged).toBe(0);
    expect(hoisted.sends).toHaveLength(0);
  });

  it("booking request, replacement request and schedule change each get their own words and cycle", async () => {
    hoisted.docs.set("booking_requests/br1", { status: "pending", caregiverId: "cg1", clientName: "Fam A", createdAt: ago(NUDGE_DELAY_MS + 1) });
    hoisted.docs.set("booking_requests/rep", { status: "pending", caregiverId: "cg1", clientName: "Fam B", isShiftReplacement: true, schedule: { startDate: "2099-03-11" }, createdAt: ago(REPLACEMENT_DELAY_MS + 1) });
    hoisted.docs.set("booking_requests/fresh", { status: "pending", caregiverId: "cg1", clientName: "Fam C", createdAt: ago(60_000) });
    hoisted.docs.set("booking_amendments/am1", { status: "pending", caregiverId: "cg1", clientName: "Fam D", createdAt: ago(NUDGE_DELAY_MS + 1) });
    const r = await runPendingDecisionNudges(NOW);
    expect(r).toEqual({ nudged: 3, bellKeptOptedOut: 0, dropped: 0, skipped: 1 });
    const texts = hoisted.sends.map((s) => s.out.content);
    expect(texts).toContain("Fam A's booking request is still waiting on you. Reply ACCEPT or DECLINE, or DETAILS to see the full request.");
    expect(texts.some((t) => t.startsWith("Fam B needs a replacement caregiver on ") && t.endsWith("— the request is still waiting on you and expires in 10 minutes. Reply ACCEPT or DECLINE, or DETAILS to see the full request."))).toBe(true);
    expect(texts).toContain("Fam D's schedule change request is still waiting on you. Reply ACCEPT or DECLINE.");
    expect(hoisted.sessionSets.map((s) => s.data.pendingDecision.kind).sort()).toEqual(["amendment", "booking_request", "booking_request"]);
  });

  // B6: the 10-minute expiry sweep (shiftGenerator.ts) runs only the replacement items — the other kinds stay on the hourly job.
  it("only:'replacement' loads replacement requests alone, nudges inside the window, and skips one at/after expiry", async () => {
    hoisted.docs.set("video_interviews/iv1", { status: "requested", caregiverId: "cg1", clientName: "Fam", scheduledTime: "2099-03-28T16:00:00.000Z", createdAt: ago(NUDGE_DELAY_MS + 60_000) });
    hoisted.docs.set("booking_requests/br1", { status: "pending", caregiverId: "cg1", clientName: "Fam A", createdAt: ago(NUDGE_DELAY_MS + 1) });
    hoisted.docs.set("booking_requests/rep", { status: "pending", caregiverId: "cg1", clientName: "Fam B", isShiftReplacement: true, schedule: { startDate: "2099-03-11" }, createdAt: ago(REPLACEMENT_DELAY_MS + 1) });
    hoisted.docs.set("booking_requests/stale", { status: "pending", caregiverId: "cg1", clientName: "Fam C", isShiftReplacement: true, schedule: { startDate: "2099-03-11" }, createdAt: ago(REPLACEMENT_EXPIRY_MS + 1) });
    hoisted.docs.set("booking_amendments/am1", { status: "pending", caregiverId: "cg1", clientName: "Fam D", createdAt: ago(NUDGE_DELAY_MS + 1) });
    const r = await runPendingDecisionNudges(NOW, { only: "replacement" });
    expect(r).toEqual({ nudged: 1, bellKeptOptedOut: 0, dropped: 0, skipped: 1 });
    expect(hoisted.sends).toHaveLength(1);
    expect(hoisted.sends[0].out.content).toMatch(/^Fam B needs a replacement caregiver on /);
    expect(hoisted.sessionSets[0].data.pendingDecision).toMatchObject({ kind: "booking_request", recordId: "rep", label: "a replacement request from Fam B" });
    // A second sweep inside the window does not nudge again.
    const r2 = await runPendingDecisionNudges(NOW + 5 * 60_000, { only: "replacement" });
    expect(r2.nudged).toBe(0);
  });

  // Bell ⇄ text in lockstep (caregiver sweep C11, 2026-10-11): the bell is written
  // only when the text went. No bell-only path for a dropped text any more.
  it("text dropped by the send layer (wait-tool / cap / dedup / block) → no bell, window not stamped, retried next run", async () => {
    hoisted.sendResult = false;
    hoisted.docs.set("booking_requests/br1", { status: "pending", caregiverId: "cg1", clientName: "Fam", createdAt: ago(NUDGE_DELAY_MS + 1) });
    const r1 = await runPendingDecisionNudges(NOW);
    expect(r1).toEqual({ nudged: 0, bellKeptOptedOut: 0, dropped: 1, skipped: 0 });
    expect(hoisted.sends).toHaveLength(1);
    expect(hoisted.bells).toHaveLength(0);
    expect(hoisted.updates).toHaveLength(0);
    // The next run tries again (same nudge number → the bell key is unchanged, so it can never double).
    hoisted.sendResult = true;
    const r2 = await runPendingDecisionNudges(NOW + 60 * 60_000);
    expect(r2).toEqual({ nudged: 1, bellKeptOptedOut: 0, dropped: 0, skipped: 0 });
    expect(hoisted.bells).toHaveLength(1);
    expect(hoisted.bells[0].eventId).toBe("decision-nudge-1");
    expect(hoisted.updates[0].data.decisionNudgeCount).toBe(1);
  });

  it("no Evia session (never texted Evia) → no text, no bell, nothing stamped", async () => {
    hoisted.docs.set("booking_requests/br1", { status: "pending", caregiverId: "cg2", clientName: "Fam", createdAt: ago(NUDGE_DELAY_MS + 1) });
    const r = await runPendingDecisionNudges(NOW);
    expect(r).toEqual({ nudged: 0, bellKeptOptedOut: 0, dropped: 1, skipped: 0 });
    expect(hoisted.sends).toHaveLength(0);
    expect(hoisted.bells).toHaveLength(0);
    expect(hoisted.updates).toHaveLength(0);
  });

  it("text sent → the bell is written after it and the window is stamped", async () => {
    hoisted.docs.set("booking_requests/br1", { status: "pending", caregiverId: "cg1", clientName: "Fam", createdAt: ago(NUDGE_DELAY_MS + 1) });
    const r = await runPendingDecisionNudges(NOW);
    expect(r).toEqual({ nudged: 1, bellKeptOptedOut: 0, dropped: 0, skipped: 0 });
    expect(hoisted.order).toEqual(["text", "bell"]);
    expect(hoisted.bells[0]).toMatchObject({ sourcePath: "booking_requests/br1", eventId: "decision-nudge-1", recipientId: "cg1", type: "booking_request" });
    expect(hoisted.updates[0]).toEqual({ path: "booking_requests/br1", data: { decisionNudgeCount: 1, decisionNudgedAt: new Date(NOW).toISOString() } });
    const r2 = await runPendingDecisionNudges(NOW + 60_000);
    expect(r2).toEqual({ nudged: 0, bellKeptOptedOut: 0, dropped: 0, skipped: 1 });
  });

  it("the one exception: a caregiver who texted STOP keeps the bell (the site is her only channel) and the window is stamped", async () => {
    hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1", optedOut: true });
    hoisted.docs.set("booking_requests/br1", { status: "pending", caregiverId: "cg1", clientName: "Fam", createdAt: ago(NUDGE_DELAY_MS + 1) });
    const r = await runPendingDecisionNudges(NOW);
    expect(r).toEqual({ nudged: 0, bellKeptOptedOut: 1, dropped: 0, skipped: 0 });
    expect(hoisted.sends).toHaveLength(0);
    expect(hoisted.sessionSets).toHaveLength(0); // nothing parked on a STOPped session
    expect(hoisted.bells).toHaveLength(1);
    expect(hoisted.updates[0].data.decisionNudgeCount).toBe(1);
  });
});
