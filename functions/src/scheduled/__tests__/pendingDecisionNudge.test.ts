import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver "still waiting on you" nudges (pendingDecisionNudge.ts): interview
// requests, booking requests, replacement requests, schedule changes.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sessionSets: [] as Array<{ phone: string; data: any }>,
  bells: [] as any[],
  sends: [] as any[],
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
vi.mock("../../agents/caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async (phone: string, out: any) => { hoisted.sends.push({ phone, out }); return hoisted.sendResult; }) }));
vi.mock("../../notifications/userNotification", () => ({ writeUserNotification: vi.fn(async (n: any) => { hoisted.bells.push(n); return true; }) }));
vi.mock("../../utils/caregiverPhone", () => ({ resolveCaregiverPhone: vi.fn(async (id: string) => (id === "cg1" ? "+1408" : undefined)) }));

import { shouldNudgePendingDecision, runPendingDecisionNudges, toMs, NUDGE_DELAY_MS, RENUDGE_COOLDOWN_MS, REPLACEMENT_DELAY_MS, REPLACEMENT_COOLDOWN_MS, MAX_NUDGES } from "../pendingDecisionNudge";

const NOW = Date.parse("2099-03-10T18:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionSets.length = 0; hoisted.bells.length = 0; hoisted.sends.length = 0; hoisted.sendResult = true; hoisted.docs.set("agent_sessions/+1408", { caregiverId: "cg1" }); });

describe("shouldNudgePendingDecision", () => {
  it("24h after the request, then every 48h; replacements 2h then every 12h and never after the visit date", () => {
    expect(shouldNudgePendingDecision({ createdMs: NOW - NUDGE_DELAY_MS + 1000, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - NUDGE_DELAY_MS - 1000, lastNudgedMs: null, nowMs: NOW })).toBe(true);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 5 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS + 1000, nowMs: NOW })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 5 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS - 1000, nowMs: NOW })).toBe(true);
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_DELAY_MS - 1000, lastNudgedMs: null, nowMs: NOW, replacement: true, visitDate: "2099-03-11", today: "2099-03-10" })).toBe(true);
    expect(shouldNudgePendingDecision({ createdMs: NOW - REPLACEMENT_DELAY_MS + 1000, lastNudgedMs: null, nowMs: NOW, replacement: true })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 3 * REPLACEMENT_DELAY_MS, lastNudgedMs: NOW - REPLACEMENT_COOLDOWN_MS + 1000, nowMs: NOW, replacement: true })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 3 * REPLACEMENT_DELAY_MS, lastNudgedMs: null, nowMs: NOW, replacement: true, visitDate: "2099-03-09", today: "2099-03-10" })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: null, lastNudgedMs: null, nowMs: NOW })).toBe(false);
    // Cap (founder 2026-09-29): three nudges for a booking request / schedule change / interview, then silence; replacements have no cap (they stop at the visit date).
    expect(shouldNudgePendingDecision({ createdMs: NOW - 9 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS - 1000, nowMs: NOW, nudgeCount: 2 })).toBe(true);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 9 * NUDGE_DELAY_MS, lastNudgedMs: NOW - RENUDGE_COOLDOWN_MS - 1000, nowMs: NOW, nudgeCount: MAX_NUDGES })).toBe(false);
    expect(shouldNudgePendingDecision({ createdMs: NOW - 9 * REPLACEMENT_DELAY_MS, lastNudgedMs: NOW - REPLACEMENT_COOLDOWN_MS - 1000, nowMs: NOW, replacement: true, visitDate: "2099-03-11", today: "2099-03-10", nudgeCount: 7 })).toBe(true);
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
    expect(r).toEqual({ nudged: 1, bellOnly: 0, skipped: 0 });
    expect(hoisted.sends[0].out.content).toMatch(/^Basra Yousuf's interview request for "Senior care in San Jose" \(.+\) is still waiting on you\. Reply ACCEPT or DECLINE, or PROPOSE a different time\.$/);
    expect(hoisted.bells[0]).toMatchObject({ sourcePath: "video_interviews/iv1", eventId: "decision-nudge-1", recipientId: "cg1", title: "Still waiting on you", data: { interviewId: "iv1" } });
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
    expect(r).toEqual({ nudged: 3, bellOnly: 0, skipped: 1 });
    const texts = hoisted.sends.map((s) => s.out.content);
    expect(texts).toContain("Fam A's booking request is still waiting on you. Reply ACCEPT or DECLINE, or DETAILS to see the full request.");
    expect(texts.some((t) => t.startsWith("Fam B needs a replacement caregiver on ") && t.endsWith("— the request is still waiting on you. Reply ACCEPT or DECLINE, or DETAILS to see the full request."))).toBe(true);
    expect(texts).toContain("Fam D's schedule change request is still waiting on you. Reply ACCEPT or DECLINE.");
    expect(hoisted.sessionSets.map((s) => s.data.pendingDecision.kind).sort()).toEqual(["amendment", "booking_request", "booking_request"]);
  });

  it("no Evia session → bell only; a dropped text still stamps the window (never a double bell)", async () => {
    hoisted.docs.set("booking_requests/br1", { status: "pending", caregiverId: "cg2", clientName: "Fam", createdAt: ago(NUDGE_DELAY_MS + 1) });
    const r1 = await runPendingDecisionNudges(NOW);
    expect(r1).toEqual({ nudged: 0, bellOnly: 1, skipped: 0 });
    expect(hoisted.bells).toHaveLength(1);
    expect(hoisted.updates[0].data.decisionNudgeCount).toBe(1);
    const r2 = await runPendingDecisionNudges(NOW + 60_000);
    expect(r2).toEqual({ nudged: 0, bellOnly: 0, skipped: 1 });
  });
});
