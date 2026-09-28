import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Bookings page's two cancel buttons, over text
// (caregiverCancelShiftHandler.ts): the ✕ on a visit and Cancel Booking —
// the page's options, its two dialogs, its two writes.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sent: [] as string[],
  parse: vi.fn(async () => "NO"),
}));
vi.mock("firebase-admin", () => {
  const ref = (name: string, id: string) => ({
    path: `${name}/${id}`,
    get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
    update: vi.fn(async (d: any) => { hoisted.updates.push({ path: `${name}/${id}`, data: d }); if (hoisted.docs.has(`${name}/${id}`)) hoisted.docs.set(`${name}/${id}`, { ...hoisted.docs.get(`${name}/${id}`), ...d }); }),
  });
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, any]>): any => ({
        where: (f: string, _o: string, v: any) => q([...filters, [f, v]]),
        orderBy: () => q(filters), limit: () => q(filters),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()]
            .filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, v]) => f === "date" ? true : Array.isArray(v) ? v.includes(d[f]) : d[f] === v))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d, ref: ref(name, p.split("/")[1]) }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return { doc: (id: string) => ref(name, id), where: (f: string, _o: string, v: any) => q([[f, v]]) };
    },
    batch: () => ({
      update: (r: any, d: any) => { hoisted.updates.push({ path: r.path, data: d }); const cur = hoisted.docs.get(r.path); if (cur) hoisted.docs.set(r.path, { ...cur, ...d }); },
      commit: vi.fn(async () => {}),
    }),
  }), { FieldValue: { delete: () => "__delete__", serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../utils/parseWithClaude", () => ({ parseWithClaude: (...a: any[]) => (hoisted.parse as any)(...a) }));
vi.mock("./humanReply", () => ({ answerHumanMidFlow: vi.fn(async ({ reAsk }: any) => `Answer. ${reAsk}`) }));

import { handleCaregiverCancelShift, cancelShiftLikeThePage, cancelBookingLikeThePage, loadCancelOptions } from "./caregiverCancelShiftHandler";

const PHONE = "+15555550100", CHAT = "chat", CG = "cg1";
const shift = (id: string, over: Record<string, unknown>) => hoisted.docs.set(`shifts/${id}`, { caregiverId: CG, status: "scheduled", clientName: "Basra Yousuf", clientId: "fam1", bookingRequestId: "br1", startTime: "11:00", endTime: "14:00", ...over });
const laParts = (d: Date) => { const p: Record<string, string> = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d)) p[x.type] = x.value; return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` }; };
const VISIT_CONFIRM = "Cancel this shift only? The rest of your booking stays active. Reply YES to cancel, or NO to keep it.";
const BOOKING_CONFIRM = "Cancel this shift and all future scheduled shifts for this booking? Reply YES to cancel, or NO to keep it.";

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sent.length = 0; hoisted.parse.mockReset(); hoisted.parse.mockResolvedValue("NO"); });

describe("the options — each visit with a ✕, then the whole booking", () => {
  it("lists scheduled, not-overdue visits (this visit only) and one whole-booking option per booking, numbered", async () => {
    shift("b", { date: "2099-10-03", startTime: "19:30", endTime: "21:30" });
    shift("a", { date: "2099-09-28" });
    shift("old", { date: "2000-01-01" });
    shift("live", { date: "2099-09-29", status: "in-progress" });
    shift("z", { date: "2099-10-10", bookingRequestId: "br2", clientName: "Fam Two" });
    const opts = await loadCancelOptions(CG);
    expect(opts.map((o) => `${o.index}:${o.kind}:${o.id}`)).toEqual(["1:visit:a", "2:visit:b", "3:visit:z", "4:booking:a", "5:booking:z"]);
    expect(opts[3]).toMatchObject({ clientName: "Basra Yousuf", count: 2 });
    hoisted.parse.mockResolvedValueOnce("0"); // the message names nothing in particular
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "I need to cancel something", {}, CHAT);
    expect(hoisted.sent[0]).toBe([
      "What do you need to cancel?",
      "1. Mon, Sep 28, 2099 at 11:00 AM – 2:00 PM — Basra Yousuf (this visit only)",
      "2. Sat, Oct 3, 2099 at 7:30 PM – 9:30 PM — Basra Yousuf (this visit only)",
      "3. Sat, Oct 10, 2099 at 11:00 AM – 2:00 PM — Fam Two (this visit only)",
      "4. The whole booking with Basra Yousuf — every upcoming visit (2)",
      "5. The whole booking with Fam Two — every upcoming visit (1)",
      "", "Reply with the number, or CANCEL to back out.",
    ].join("\n"));
  });
  it("a message that names one thing skips the list: 'cancel the booking with Basra' → the booking's dialog; the bare CANCEL keyword always lists", async () => {
    shift("a", { date: "2099-09-28" });
    shift("b", { date: "2099-10-03", startTime: "19:30", endTime: "21:30" });
    hoisted.parse.mockResolvedValueOnce("3"); // resolveOptionFromText → the whole booking
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "cancel my whole booking with Basra", {}, CHAT);
    expect(hoisted.sent[0]).toBe(`The whole booking with Basra Yousuf — every upcoming visit (2).\n\n${BOOKING_CONFIRM}`);
    expect(hoisted.updates.find((u) => u.data.cancelKind)!.data).toMatchObject({ cancelShiftId: "a", cancelKind: "booking" });
    hoisted.sent.length = 0; hoisted.parse.mockClear();
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "CANCEL", {}, CHAT);
    expect(hoisted.sent[0]).toMatch(/^What do you need to cancel\?/);
    expect(hoisted.parse).not.toHaveBeenCalled();
  });
  it("nothing cancellable → says so and clears the step", async () => {
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "cancel", {}, CHAT);
    expect(hoisted.sent[0]).toBe("You don't have any upcoming shifts to cancel.");
  });
});

describe("confirm — the page's dialogs, then the page's writes", () => {
  const options = JSON.stringify([
    { index: 1, kind: "visit", id: "a", bookingRequestId: "br1", date: "2099-09-28", startTime: "11:00", endTime: "14:00", clientName: "Basra Yousuf", clientId: "fam1" },
    { index: 2, kind: "visit", id: "b", bookingRequestId: "br1", date: "2099-10-03", startTime: "19:30", endTime: "21:30", clientName: "Basra Yousuf", clientId: "fam1" },
    { index: 3, kind: "booking", id: "a", bookingRequestId: "br1", date: "2099-09-28", startTime: "11:00", endTime: "14:00", clientName: "Basra Yousuf", clientId: "fam1", count: 2 },
  ]);
  it("a number picks the visit and asks the ✕ dialog; the booking number asks the Cancel Booking dialog", async () => {
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "2", { cancelStep: "confirm_shift", cancelCandidates: options }, CHAT);
    expect(hoisted.sent[0]).toBe(`Sat, Oct 3, 2099 at 7:30 PM – 9:30 PM — Basra Yousuf (this visit only).\n\n${VISIT_CONFIRM}`);
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "3", { cancelStep: "confirm_shift", cancelCandidates: options }, CHAT);
    expect(hoisted.sent[1]).toBe(`The whole booking with Basra Yousuf — every upcoming visit (2).\n\n${BOOKING_CONFIRM}`);
  });
  it("YES on a visit writes exactly the ✕'s patch and clears the flow", async () => {
    shift("b", { date: "2099-10-03", startTime: "19:30", endTime: "21:30" });
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "YES", { cancelStep: "confirm_shift", cancelCandidates: options, cancelShiftId: "b", cancelKind: "visit" }, CHAT);
    expect(hoisted.updates.find((u) => u.path === "shifts/b")!.data).toEqual({ status: "cancelled", cancelledBy: "caregiver", updatedAt: "__ts__" });
    expect(hoisted.sent[0]).toBe("Cancelled — Sat, Oct 3, 2099 at 7:30 PM – 9:30 PM — Basra Yousuf (this visit only). The family has been notified.");
    expect(hoisted.parse).not.toHaveBeenCalled();
  });
  it("YES on the booking cancels this shift and every future scheduled shift of the booking (batch), then the booking itself when none was urgent — the page's toast", async () => {
    shift("a", { date: "2099-09-28" });
    shift("b", { date: "2099-10-03", startTime: "19:30", endTime: "21:30" });
    shift("done", { date: "2099-09-20", status: "completed" });
    shift("other", { date: "2099-10-04", caregiverId: "cg2" });
    hoisted.docs.set("booking_requests/br1", { status: "accepted" });
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "yes", { cancelStep: "confirm_shift", cancelCandidates: options, cancelShiftId: "a", cancelKind: "booking" }, CHAT);
    const patch = { status: "cancelled", cancelledBy: "caregiver", updatedAt: "__ts__" };
    expect(hoisted.updates.filter((u) => u.path.startsWith("shifts/")).map((u) => u.path).sort()).toEqual(["shifts/a", "shifts/b"]);
    expect(hoisted.docs.get("shifts/a")).toMatchObject(patch);
    expect(hoisted.docs.get("shifts/b")).toMatchObject(patch);
    expect(hoisted.docs.get("shifts/done").status).toBe("completed");
    expect(hoisted.docs.get("shifts/other").status).toBe("scheduled");
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")!.data).toEqual({ status: "cancelled", updatedAt: "__ts__" });
    expect(hoisted.sent[0]).toBe("Booking cancelled — Basra Yousuf, 2 visits. The family has been notified.");
  });
  it("a booking with a visit inside 24h: that visit becomes needs_replacement and the booking record is left alone (the page's rule)", async () => {
    const { date, time } = laParts(new Date(Date.now() + 2 * 60 * 60 * 1000));
    shift("a", { date, startTime: time, endTime: "23:59" });
    shift("b", { date: "2099-10-03" });
    hoisted.docs.set("booking_requests/br1", { status: "accepted" });
    const r = await cancelBookingLikeThePage(CG, "a");
    expect(r).toMatchObject({ ok: true, anyUrgent: true, count: 2, toast: "Cancelled — the family can pick a replacement for the urgent shift" });
    expect(hoisted.docs.get("shifts/a").status).toBe("needs_replacement");
    expect(hoisted.docs.get("shifts/b").status).toBe("cancelled");
    expect(hoisted.updates.find((u) => u.path === "booking_requests/br1")).toBeUndefined();
  });
  it("NO keeps it; a question mid-flow is answered and re-asked; CANCEL backs out; a non-scheduled visit is not re-written", async () => {
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "no", { cancelStep: "confirm_shift", cancelCandidates: options, cancelShiftId: "b", cancelKind: "visit" }, CHAT);
    expect(hoisted.sent.at(-1)).toMatch(/^Okay — keeping that one\./);
    hoisted.parse.mockResolvedValueOnce("YES"); // isQuestionOrOther → a question
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "will I still get paid?", { cancelStep: "confirm_shift", cancelCandidates: options, cancelShiftId: "a", cancelKind: "booking" }, CHAT);
    expect(hoisted.sent.at(-1)).toMatch(/^Answer\. Cancel this shift and all future scheduled shifts/);
    expect(hoisted.updates.find((u) => u.path.startsWith("shifts/"))).toBeUndefined();
    await handleCaregiverCancelShift(CG, "Maria", PHONE, "CANCEL", { cancelStep: "confirm_shift", cancelCandidates: options }, CHAT);
    expect(hoisted.sent.at(-1)).toBe("No problem — your shifts are unchanged.");
    shift("b", { date: "2099-10-03", status: "cancelled" });
    expect(await cancelShiftLikeThePage("b")).toEqual({ ok: false, reason: "not_scheduled", status: "cancelled" });
  });
});
