import { describe, it, expect, vi, beforeEach } from "vitest";

// The Jobs page's Apply modal and interview Propose-new-time form as scripted
// flows: same steps, back-out anywhere, SUBMIT/SEND or CANCEL at the end, the
// site's exact writes.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sent: string[] = [];
  const adds: Array<{ coll: string; data: any }> = [];
  const applySentinel = (cur: any, k: string, v: any) => { if (v && typeof v === "object" && v.__delete) { delete cur[k]; return; } cur[k] = v; };
  const makeDoc = (coll: string, id: string): any => {
    const path = `${coll}/${id}`;
    return {
      id,
      get: vi.fn(async () => ({ exists: docState.has(path), id, data: () => docState.get(path) })),
      update: vi.fn(async (d: any) => { const cur = { ...(docState.get(path) ?? {}) }; for (const [k, v] of Object.entries(d)) applySentinel(cur, k, v); docState.set(path, cur); }),
      set: vi.fn(async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d })),
    };
  };
  const makeQuery = (coll: string, filters: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...filters, [f, op, v]]),
    limit: () => makeQuery(coll, filters),
    orderBy: () => makeQuery(coll, filters),
    get: vi.fn(async () => {
      let items = Array.from(docState.entries()).filter(([p]) => p.startsWith(`${coll}/`) && p.split("/").length === 2).map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
      for (const [f, , v] of filters) items = items.filter((it) => it.data()[f] === v);
      return { empty: items.length === 0, docs: items };
    }),
  });
  const makeColl = (coll: string): any => ({
    doc: (id: string) => makeDoc(coll, id),
    add: vi.fn(async (d: any) => { const id = `auto-${adds.length + 1}`; adds.push({ coll, data: d }); docState.set(`${coll}/${id}`, d); return { id }; }),
    ...makeQuery(coll, []),
  });
  return { docState, sent, adds, collectionMock: vi.fn((c: string) => makeColl(c)), reset: () => { docState.clear(); sent.length = 0; adds.length = 0; } };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }), serverTimestamp: () => ({ __ts: true }), arrayUnion: (...v: unknown[]) => ({ __arrayUnion: v }), arrayRemove: (...v: unknown[]) => ({ __arrayRemove: v }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: any) => { hoisted.sent.push(typeof m === "string" ? m : JSON.stringify(m)); return { message_id: "m" }; }) }));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../ai/scoring", () => ({ haversineMiles: () => undefined }));
// Deterministic LLM router: the flows only ask the model to classify / extract.
const quickComplete = vi.fn(async (prompt: string, text: string) => {
  if (prompt.includes("OPTIONAL cover letter")) return /^(skip|no|none)/i.test(text) ? "SKIP" : "LETTER";
  if (prompt.includes("reply SUBMIT")) return /submit|send|yes/i.test(text) ? "SUBMIT" : /cancel|no/i.test(text) ? "CANCEL" : "OTHER";
  if (prompt.includes("reply SEND")) return /send|yes/i.test(text) ? "SEND" : /cancel/i.test(text) ? "CANCEL" : "OTHER";
  if (prompt.includes("naming the DATE")) return /9\/28/.test(text) ? "2099-09-28" : /monday/i.test(text) ? "2099-09-28" : "NONE";
  if (prompt.includes("naming a TIME")) { const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text); if (!m) return "NONE"; let h = Number(m[1]) % 12; if (m[3].toLowerCase() === "pm") h += 12; return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`; }
  return "NONE";
});
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (quickComplete as any)(...a) }));
const backOut = vi.fn(async (text: string) => /never mind|forget it|cancel this/i.test(text));
const questionOrOther = vi.fn(async (text: string) => /\?$/.test(text));
vi.mock("../stepHandler", () => ({
  isBackOutRequest: (t: string) => backOut(t),
  isQuestionOrOther: (t: string) => questionOrOther(t),
  answerMidFlow: vi.fn(async (_t: string, reAsk: string) => `Answer. ${reAsk}`),
}));

import { startApplyFlow, handleApplyFlowStep, startInterviewRescheduleFlow, handleInterviewRescheduleFlowStep } from "../caregiverJobFlows";

const PHONE = "+15550001111"; const CHAT = "chat-1";
const cleared = { name: "Mahad", membershipStatus: "active", verified: true, experience: "3-5 years", skills: ["Companionship", "Transportation"], rating: 5, reviewCount: 0 };
const session = () => ({ ...hoisted.docState.get(`agent_sessions/${PHONE}`), caregiverId: "cg1", chatId: CHAT, phone: PHONE } as any);

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set("caregivers/cg1", { ...cleared });
  hoisted.docState.set(`agent_sessions/${PHONE}`, { caregiverId: "cg1", chatId: CHAT, userType: "caregiver" });
  hoisted.docState.set("job_posts/job1", { status: "open", title: "Senior care in San Jose", clientId: "fam1", clientName: "Basra", rate: 26, careTypes: ["Companionship"] });
});

describe("Apply flow — the Apply for Position modal", () => {
  it("opens with the modal's contents and asks the optional cover letter; skip → SUBMIT writes the site's application", async () => {
    const r = await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" });
    expect(r.started).toBe(true);
    expect(hoisted.sent[0]).toContain("Apply for Position — Senior care in San Jose");
    expect(hoisted.sent[0]).toContain("Your Profile\nExperience: 3-5 years");
    expect(hoisted.sent[0]).not.toContain("Rating"); // no review backs the 5 — like the profile page
    expect(hoisted.sent[0]).toContain("Skills: Companionship, Transportation");
    expect(hoisted.sent[0]).toContain("Client's budget: $26/hr");
    expect(hoisted.sent[0]).toContain("Cover letter (optional)");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).applyFlowStep).toBe("apply_cover");

    await handleApplyFlowStep(PHONE, CHAT, "skip", session());
    expect(hoisted.sent[1]).toContain("Reply SUBMIT to send your application, or CANCEL.");
    expect(hoisted.sent[1]).toContain("Cover letter: (none)");

    await handleApplyFlowStep(PHONE, CHAT, "SUBMIT", session());
    const app = hoisted.adds.find((a) => a.coll === "job_applications")!.data;
    expect(app).toMatchObject({ jobId: "job1", caregiverId: "cg1", clientId: "fam1", caregiverName: "Mahad", coverLetter: "", proposedRate: null, status: "pending", jobTitle: "Senior care in San Jose", jobRate: 26, skills: ["Companionship", "Transportation"] });
    expect(hoisted.sent[2]).toBe("Application submitted for Senior care in San Jose!");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).applyFlowStep).toBeUndefined();
  });

  it("a typed cover letter is stored and shown in the recap", async () => {
    await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" });
    await handleApplyFlowStep(PHONE, CHAT, "I have 4 years with dementia clients and I'm nearby.", session());
    expect(hoisted.sent[1]).toContain('Cover letter: "I have 4 years with dementia clients and I\'m nearby."');
    await handleApplyFlowStep(PHONE, CHAT, "yes send it", session());
    expect(hoisted.adds[0].data.coverLetter).toBe("I have 4 years with dementia clients and I'm nearby.");
  });

  it("CANCEL at the end, or a back-out at any step, sends nothing and clears the flow", async () => {
    await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" });
    await handleApplyFlowStep(PHONE, CHAT, "never mind", session());
    expect(hoisted.adds).toHaveLength(0);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).applyFlowStep).toBeUndefined();
    expect(hoisted.sent.at(-1)).toContain("nothing was sent");
    await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" });
    await handleApplyFlowStep(PHONE, CHAT, "skip", session());
    await handleApplyFlowStep(PHONE, CHAT, "CANCEL", session());
    expect(hoisted.adds).toHaveLength(0);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).applyFlowStep).toBeUndefined();
  });

  it("a question mid-flow is answered and the step stays", async () => {
    await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" });
    await handleApplyFlowStep(PHONE, CHAT, "does the family see my cover letter?", session());
    expect(hoisted.sent[1]).toContain("Answer.");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).applyFlowStep).toBe("apply_cover");
  });

  it("the site's gate stands in for Apply Now: background check, then transport docs for a Transportation job (nothing written)", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Maria", membershipStatus: "active" });
    expect((await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" })).reason).toBe("gated");
    expect(hoisted.sent.some((m) => m.includes("Background check required"))).toBe(true);
    hoisted.docState.set("job_posts/job1", { status: "open", title: "Rides", clientId: "fam1", careTypes: ["Transportation"] });
    hoisted.docState.set("caregivers/cg1", { name: "Maria", membershipStatus: "active", backgroundCheckStatus: "clear", services: ["Transportation"] });
    expect((await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" })).reason).toBe("gated");
    expect(hoisted.sent.some((m) => m.includes("Transport documents required"))).toBe(true);
    expect(hoisted.adds).toHaveLength(0);
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).applyFlowStep).toBeUndefined();
  });

  it("does not start when gated, already applied, or the job is closed", async () => {
    hoisted.docState.set("caregivers/cg1", { ...cleared, membershipStatus: "inactive", membershipPaid: false });
    expect((await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" })).reason).toBe("gated");
    expect(hoisted.sent[0]).toContain("Membership required");
    hoisted.reset(); hoisted.docState.set("caregivers/cg1", { ...cleared }); hoisted.docState.set(`agent_sessions/${PHONE}`, {});
    hoisted.docState.set("job_posts/job1", { status: "open", title: "x", clientId: "fam1" });
    hoisted.docState.set("job_applications/a1", { jobId: "job1", caregiverId: "cg1" });
    expect((await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" })).reason).toBe("duplicate");
    hoisted.docState.set("job_posts/job1", { status: "filled", title: "x", clientId: "fam1" });
    expect((await startApplyFlow(PHONE, CHAT, session(), { caregiverId: "cg1", jobId: "job1" })).reason).toBe("not_open");
  });
});

describe("Interview reschedule flow — Propose new time / Reschedule", () => {
  beforeEach(() => {
    hoisted.docState.set("video_interviews/iv1", { caregiverId: "cg1", clientId: "fam1", clientName: "Basra Yousuf", jobTitle: "Senior care in San Jose", status: "accepted", scheduledTime: "2099-09-27T17:00:00.000Z" });
  });

  it("asks the date, then the time from the site's picker, then SEND writes the site's proposal (the time itself doesn't move)", async () => {
    const r = await startInterviewRescheduleFlow(PHONE, CHAT, session(), { caregiverId: "cg1", interviewId: "iv1" });
    expect(r.started).toBe(true);
    expect(hoisted.sent[0]).toContain("Reschedule your interview with Basra Yousuf (Senior care in San Jose)");
    expect(hoisted.sent[0]).toContain("What date?");

    await handleInterviewRescheduleFlowStep(PHONE, CHAT, "9/28", session());
    expect(hoisted.sent[1]).toContain("What time? The site offers 9:00 AM to 6:00 PM");

    await handleInterviewRescheduleFlowStep(PHONE, CHAT, "10:15am", session()); // not a picker slot
    expect(hoisted.sent[2]).toContain("Sorry, I didn't quite catch that.");

    await handleInterviewRescheduleFlowStep(PHONE, CHAT, "10:30am", session());
    expect(hoisted.sent[3]).toContain("New time: Monday, September 28 at 10:30 AM");
    expect(hoisted.sent[3]).toContain("Reply SEND to propose it to Basra Yousuf");

    await handleInterviewRescheduleFlowStep(PHONE, CHAT, "SEND", session());
    const iv = hoisted.docState.get("video_interviews/iv1");
    expect(iv.reschedulePendingTime).toBe("2099-09-28T17:30:00.000Z");
    expect(iv.rescheduledBy).toBe("caregiver");
    expect(iv.scheduledTime).toBe("2099-09-27T17:00:00.000Z"); // unchanged until the family confirms
    expect(iv.status).toBe("accepted");
    expect(iv.rescheduledViaAgent).toBeUndefined();
    expect(hoisted.sent[4]).toBe("New time proposed — waiting on the family to confirm");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).interviewRescheduleFlowStep).toBeUndefined();
  });

  it("date and time in one message skips straight to the confirmation", async () => {
    await startInterviewRescheduleFlow(PHONE, CHAT, session(), { caregiverId: "cg1", interviewId: "iv1" });
    await handleInterviewRescheduleFlowStep(PHONE, CHAT, "9/28 at 9am", session());
    expect(hoisted.sent[1]).toContain("New time: Monday, September 28 at 9:00 AM");
    expect(hoisted.docState.get(`agent_sessions/${PHONE}`).interviewRescheduleFlowStep).toBe("rs_confirm");
  });

  it("CANCEL at the end leaves the interview untouched; won't start while the caregiver's own proposal is out", async () => {
    await startInterviewRescheduleFlow(PHONE, CHAT, session(), { caregiverId: "cg1", interviewId: "iv1" });
    await handleInterviewRescheduleFlowStep(PHONE, CHAT, "9/28 at 9am", session());
    await handleInterviewRescheduleFlowStep(PHONE, CHAT, "cancel", session());
    expect(hoisted.docState.get("video_interviews/iv1").reschedulePendingTime).toBeUndefined();
    expect(hoisted.sent.at(-1)).toContain("nothing was sent");
    hoisted.docState.set("video_interviews/iv1", { caregiverId: "cg1", status: "accepted", reschedulePendingTime: "x", rescheduledBy: "caregiver", clientName: "B" });
    expect((await startInterviewRescheduleFlow(PHONE, CHAT, session(), { caregiverId: "cg1", interviewId: "iv1" })).reason).toBe("own_proposal_out");
  });

  it("a pending request is gated like the site's form; a declined interview can't be rescheduled", async () => {
    hoisted.docState.set("caregivers/cg1", { ...cleared, membershipStatus: "inactive", membershipPaid: false });
    hoisted.docState.set("video_interviews/iv1", { caregiverId: "cg1", status: "requested", clientName: "B" });
    expect((await startInterviewRescheduleFlow(PHONE, CHAT, session(), { caregiverId: "cg1", interviewId: "iv1" })).reason).toBe("gated");
    hoisted.docState.set("caregivers/cg1", { ...cleared });
    hoisted.docState.set("video_interviews/iv1", { caregiverId: "cg1", status: "declined", clientName: "B" });
    expect((await startInterviewRescheduleFlow(PHONE, CHAT, session(), { caregiverId: "cg1", interviewId: "iv1" })).reason).toBe("terminal");
  });
});
