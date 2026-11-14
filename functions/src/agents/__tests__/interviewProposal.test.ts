import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// "Keep current time" on the other side's proposed interview time (caregiver
// sweep B5, founder 2026-10-11): ONE write (interviewProposal.ts) behind Evia's
// KEEP reply and the accept_interview_reschedule tool's action:"keep", and the
// SAME field set written directly by the two Interviews tabs (PostsPage.tsx /
// JobBoard.tsx handleKeepCurrentTime) — pinned here statically so the three
// never drift. The proposal is cleared, status and scheduledTime stay, so
// onVideoInterviewWrite's "isn't able to move the interview" branch is the
// one notice the proposer gets.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  audits: [] as any[],
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })),
        update: vi.fn(async (d: any) => {
          hoisted.updates.push({ path: `${name}/${id}`, data: d });
          const next = { ...(hoisted.docs.get(`${name}/${id}`) ?? {}) };
          for (const [k, v] of Object.entries(d)) { if ((v as any)?.__delete) delete next[k]; else next[k] = v; }
          hoisted.docs.set(`${name}/${id}`, next);
        }),
      }),
    }),
  }), { FieldValue: { serverTimestamp: () => ({ __ts: true }), delete: () => ({ __delete: true }) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async (e: any) => { hoisted.audits.push(e); }) }));

import { keepInterviewTime, keepInterviewTimePatch, keptInterviewLine, KEEP_INTERVIEW_TIME_FIELDS } from "../interviewProposal";

const CG = "cg1";
const FAM = "fam1";
const base = { caregiverId: CG, clientId: FAM, clientName: "Basra Yousuf", caregiverName: "Alice Mahad", status: "accepted", scheduledTime: "2099-10-05T18:00:00.000Z" };
const familyProposal = { ...base, reschedulePendingTime: "2099-10-06T19:00:00.000Z", rescheduledBy: "client" };
const caregiverProposal = { ...base, reschedulePendingTime: "2099-10-06T19:00:00.000Z", rescheduledBy: "caregiver", rescheduledViaAgent: true };
const CLEARED = { reschedulePendingTime: { __delete: true }, rescheduledBy: { __delete: true }, rescheduledViaAgent: { __delete: true }, updatedAt: { __ts: true } };

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.audits.length = 0; });

describe("the write — the proposal cleared, nothing else", () => {
  it("the patch is exactly KEEP_INTERVIEW_TIME_FIELDS: the proposal, its Evia marker, updatedAt — never status, scheduledTime or remindersScheduledAt", () => {
    expect(Object.keys(keepInterviewTimePatch()).sort()).toEqual([...KEEP_INTERVIEW_TIME_FIELDS].sort());
    expect(keepInterviewTimePatch()).toEqual(CLEARED);
  });

  it("care provider keeps the current time against the family's proposal — status and scheduledTime untouched, the audit names the dropped time", async () => {
    hoisted.docs.set("video_interviews/iv1", familyProposal);
    const r = await keepInterviewTime({ by: "caregiver", userId: CG, interviewId: "iv1", source: "test" });
    expect(r).toEqual({
      ok: true, interviewId: "iv1", keptBy: "caregiver", clientName: "Basra Yousuf", caregiverName: "Alice Mahad",
      scheduledTime: "2099-10-05T18:00:00.000Z", scheduledTimeLocal: "Monday, October 5 at 11:00 AM PT",
    });
    expect(hoisted.updates).toEqual([{ path: "video_interviews/iv1", data: CLEARED }]);
    expect(hoisted.docs.get("video_interviews/iv1")).toEqual({ ...base, updatedAt: { __ts: true } });
    expect(hoisted.audits[0]).toMatchObject({ eventType: "interview_time_kept", userId: CG, data: { source: "test", interviewId: "iv1", keptBy: "caregiver", declinedProposal: "2099-10-06T19:00:00.000Z" } });
  });

  it("family keeps the current time against the care provider's proposal — the same patch (the Evia marker goes with the proposal)", async () => {
    hoisted.docs.set("video_interviews/iv1", caregiverProposal);
    const r = await keepInterviewTime({ by: "client", userId: FAM, interviewId: "iv1", source: "test" });
    expect(r).toMatchObject({ ok: true, keptBy: "client" });
    expect(hoisted.updates[0].data).toEqual(CLEARED);
    expect(hoisted.docs.get("video_interviews/iv1")).toEqual({ ...base, updatedAt: { __ts: true } });
  });

  it("works on a still-pending (requested) interview too — the proposal banner shows on pending rows as well", async () => {
    hoisted.docs.set("video_interviews/iv1", { ...familyProposal, status: "requested" });
    expect(await keepInterviewTime({ by: "caregiver", userId: CG, interviewId: "iv1", source: "test" })).toMatchObject({ ok: true });
    expect(hoisted.docs.get("video_interviews/iv1").status).toBe("requested");
  });

  it("refuses: your own proposal, someone else's interview, no proposal, a finished interview, a missing one — no write", async () => {
    hoisted.docs.set("video_interviews/iv1", familyProposal);
    expect(await keepInterviewTime({ by: "client", userId: FAM, interviewId: "iv1", source: "t" })).toMatchObject({ ok: false, code: "INVALID_INPUT", message: expect.stringContaining("your own") });
    expect(await keepInterviewTime({ by: "caregiver", userId: "other", interviewId: "iv1", source: "t" })).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    hoisted.docs.set("video_interviews/iv1", base);
    expect(await keepInterviewTime({ by: "caregiver", userId: CG, interviewId: "iv1", source: "t" })).toMatchObject({ ok: false, code: "INVALID_INPUT", message: "There is no pending reschedule proposal on this interview" });
    hoisted.docs.set("video_interviews/iv1", { ...familyProposal, status: "cancelled" });
    expect(await keepInterviewTime({ by: "caregiver", userId: CG, interviewId: "iv1", source: "t" })).toMatchObject({ ok: false, code: "INVALID_INPUT", message: expect.stringContaining("cancelled") });
    expect(await keepInterviewTime({ by: "caregiver", userId: CG, interviewId: "nope", source: "t" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(hoisted.updates).toHaveLength(0);
  });

  it("the confirm names the OTHER side and the time that stands", async () => {
    hoisted.docs.set("video_interviews/iv1", familyProposal);
    const cg = await keepInterviewTime({ by: "caregiver", userId: CG, interviewId: "iv1", source: "t" });
    expect(keptInterviewLine(cg as any)).toBe("Kept the current time — your interview with Basra Yousuf stays at Monday, October 5 at 11:00 AM PT.");
    hoisted.docs.set("video_interviews/iv1", caregiverProposal);
    const fam = await keepInterviewTime({ by: "client", userId: FAM, interviewId: "iv1", source: "t" });
    expect(keptInterviewLine(fam as any)).toBe("Kept the current time — your interview with Alice Mahad stays at Monday, October 5 at 11:00 AM PT.");
    expect(keptInterviewLine({ ...(fam as any), scheduledTimeLocal: null })).toBe("Kept the current time — your interview with Alice Mahad stays as it is.");
  });
});

// ── The site writes the same field set directly (both Interviews tabs) ───────
describe("the site's Keep current time handlers write exactly KEEP_INTERVIEW_TIME_FIELDS (static pin)", () => {
  const root = path.resolve(__dirname, "../../../..");
  const keysOfKeepUpdate = (file: string): string[] => {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const start = src.indexOf("const handleKeepCurrentTime = async");
    expect(start, `${file} has no handleKeepCurrentTime`).toBeGreaterThan(-1);
    const updateAt = src.indexOf(".update({", start);
    const end = src.indexOf("});", updateAt);
    const block = src.slice(updateAt + ".update({".length, end);
    return [...block.matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1]).sort();
  };
  const deletesIn = (file: string): string[] => {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const start = src.indexOf("const handleKeepCurrentTime = async");
    const updateAt = src.indexOf(".update({", start);
    const block = src.slice(updateAt, src.indexOf("});", updateAt));
    return [...block.matchAll(/([A-Za-z]+): firebase\.firestore\.FieldValue\.delete\(\)/g)].map((m) => m[1]).sort();
  };

  it("components/client/PostsPage.tsx (family: the care provider's proposal)", () => {
    expect(keysOfKeepUpdate("components/client/PostsPage.tsx")).toEqual([...KEEP_INTERVIEW_TIME_FIELDS].sort());
    expect(deletesIn("components/client/PostsPage.tsx")).toEqual(["reschedulePendingTime", "rescheduledBy", "rescheduledViaAgent"]);
  });

  it("components/caregiver/JobBoard.tsx (care provider: the family's proposal) — and it is not gated", () => {
    expect(keysOfKeepUpdate("components/caregiver/JobBoard.tsx")).toEqual([...KEEP_INTERVIEW_TIME_FIELDS].sort());
    expect(deletesIn("components/caregiver/JobBoard.tsx")).toEqual(["reschedulePendingTime", "rescheduledBy", "rescheduledViaAgent"]);
    const src = fs.readFileSync(path.join(root, "components/caregiver/JobBoard.tsx"), "utf8");
    const fn = src.slice(src.indexOf("const handleKeepCurrentTime = async"), src.indexOf("const toggleChip"));
    expect(fn).not.toContain("gateFresh"); // Keep is a decline — Decline / Cancel aren't gated either
  });

  it("firestore.rules lets either party write those four fields from the browser (rescheduledViaAgent removal only)", () => {
    const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
    const block = rules.slice(rules.indexOf("match /video_interviews/{interviewId}"), rules.indexOf("allow delete", rules.indexOf("match /video_interviews/{interviewId}")));
    for (const f of KEEP_INTERVIEW_TIME_FIELDS) expect(block).toContain(`'${f}'`);
  });
});
