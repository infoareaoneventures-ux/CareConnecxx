import { describe, it, expect, vi, beforeEach } from "vitest";

// B3 (caregiver sweep, 2026-10-11): browse_job_board carries the Jobs page's
// sidebar. The tool hands the model's filter object through
// normalizeJobBoardFilters (the page's option sets only — never a guessed
// value, never a distance) to jobBoardText.sendJobList, which texts the list
// itself and reports the set it applied.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async (data: any) => { docState.set(path, data); }),
    update: vi.fn(async (data: any) => { docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };
  return { docState, collectionMock: vi.fn((p: string) => makeCollRef(p)), reset: () => docState.clear() };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = () => ({ collection: hoisted.collectionMock, batch: () => ({ set: vi.fn(), update: vi.fn(), commit: vi.fn(async () => undefined) }) });
  return {
    __esModule: true,
    default: { firestore: firestoreFn },
    firestore: Object.assign(firestoreFn, {
      FieldValue: {
        delete: () => ({ __delete: true }),
        arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
        serverTimestamp: () => ({ __serverTimestamp: true }),
      },
    }),
  };
});

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn().mockResolvedValue("sent"), sendMessage: vi.fn().mockResolvedValue({ message_id: "m" }) }));

const findCaregiverSession = vi.fn(async (_cg: string, _phone?: unknown) => ({ phone: "+15551110000", chatId: "cg-chat" }) as { phone: string; chatId: string } | null);
vi.mock("../../agents/caregiverAccessGate", async (importActual) => ({
  ...(await importActual<typeof import("../../agents/caregiverAccessGate")>()),
  findCaregiverSession: (...a: any[]) => (findCaregiverSession as any)(...a),
}));

const sendJobList = vi.fn(async (_phone: string, _chat: string, _cg: string, opts: any) => ({
  sent: true, count: 2, total: 3, remaining: 1,
  items: [{ number: 1, jobId: "job1", title: "Job 1" }, { number: 2, jobId: "job2", title: "Job 2" }],
  filters: opts?.filters ?? {}, filtersLabel: "$25+/hr, Morning, Sat, Sun",
}));
vi.mock("../../agents/jobBoardText", () => ({ sendJobList: (...a: any[]) => (sendJobList as any)(...a) }));

import { handleToolCall, MCP_TOOLS } from "../server";

const CAREGIVER = "cg_1";

describe("browse_job_board — the sidebar filters pass through, validated", () => {
  beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); findCaregiverSession.mockResolvedValue({ phone: "+15551110000", chatId: "cg-chat" }); });

  it("the schema offers exactly the page's sidebar (no distance control) plus refine", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "browse_job_board")!;
    const props = (tool.input_schema as any).properties;
    expect(Object.keys(props.filters.properties).sort()).toEqual(["careTypes", "days", "payMax", "payMin", "search", "seniors", "timeOfDay"]);
    expect(props.radiusMiles).toBeUndefined();
    expect(props.refine.type).toBe("boolean");
    expect(props.filters.properties.timeOfDay.items.enum).toEqual(["morning", "afternoon", "evening", "overnight"]);
    expect(props.filters.properties.days.items.enum).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(props.filters.properties.seniors.items.enum).toEqual(["1", "2", "3+"]);
    expect(props.filters.properties.careTypes.items.enum).toHaveLength(15); // senior eight + child eight, Transportation once (2026-10-18)
    expect(tool.description).toContain("NO distance filter");
  });

  // The first call warms server.ts's dynamic imports (jobBoardText, caregiverAccessGate, jobBoardPage) — give it room under a full parallel run.
  it("passes the model's filters through the page's option sets to sendJobList and reports the set applied", { timeout: 20_000 }, async () => {
    const r = await handleToolCall("browse_job_board", {
      caregiverId: CAREGIVER, phone: "+15551110000",
      filters: { timeOfDay: ["morning", "dawn"], payMin: 25, days: ["Saturday", "Sun"], radiusMiles: 5, careTypes: ["Hair Styling"] },
    }) as any;
    expect(sendJobList).toHaveBeenCalledTimes(1);
    expect(sendJobList.mock.calls[0].slice(0, 3)).toEqual(["+15551110000", "cg-chat", CAREGIVER]);
    expect(sendJobList.mock.calls[0][3]).toEqual({ sort: "newest", limit: undefined, filters: { payMin: 25, timeOfDay: ["morning"], days: ["Sat", "Sun"] }, more: false, refine: false });
    expect(r.success).toBe(true);
    expect(r.filters).toEqual({ payMin: 25, timeOfDay: ["morning"], days: ["Sat", "Sun"] });
    expect(r.filtersLabel).toBe("$25+/hr, Morning, Sat, Sun");
    expect(r.jobs).toHaveLength(2);
    expect(r.note).toContain("send nothing else this turn");
  });

  it("no filters → the default view ({}), refine and more are passed as booleans, sort/limit as before", async () => {
    await handleToolCall("browse_job_board", { caregiverId: CAREGIVER, more: true, sort: "nearest", limit: 4.7 });
    expect(sendJobList.mock.calls[0][3]).toEqual({ sort: "nearest", limit: 4, filters: {}, more: true, refine: false });
    await handleToolCall("browse_job_board", { caregiverId: CAREGIVER, refine: true, filters: { days: ["Sat", "Sun"] } });
    expect(sendJobList.mock.calls[1][3]).toEqual({ sort: "newest", limit: undefined, filters: { days: ["Sat", "Sun"] }, more: false, refine: true });
  });

  it("without an Evia conversation the tool refuses (nothing is texted)", async () => {
    findCaregiverSession.mockResolvedValueOnce(null);
    const r = await handleToolCall("browse_job_board", { caregiverId: CAREGIVER, filters: { payMin: 25 } }) as any;
    expect(r._toolError).toBe(true);
    expect(sendJobList).not.toHaveBeenCalled();
  });
});
