import { describe, it, expect, beforeEach, vi } from "vitest";

// 2026-09-08 (live-caught): asked about "the 5pm interview," Evia produced a
// confident answer splicing one real interview's date onto a different real
// interview's time. Root cause traced to list_interviews handing the model
// several interviews' worth of raw UTC scheduledTime values and expecting it
// to mentally convert each to Pacific before reasoning about "today"/"5pm" —
// exactly the kind of per-item timezone arithmetic that produces this class
// of cross-item mistake. This locks in the fix: each result now carries a
// precomputed scheduledTimeLocal so the model never has to do that math.

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, Array<{ id: string; data: any }>>();

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`),
    where: (..._a: any[]) => makeCollRef(path),
    limit: (..._a: any[]) => makeCollRef(path),
    get: vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d) => ({ id: d.id, data: () => d.data })) };
    }),
  });

  return {
    docState, collState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }), storage: () => ({}), apps: [] },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  }),
  storage: () => ({}),
}));

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));

import { handleToolCall } from "../server";

const CLIENT = "client_1";

describe("list_interviews", () => {
  beforeEach(() => hoisted.reset());

  it("includes a precomputed local-time label alongside the raw UTC scheduledTime", async () => {
    hoisted.collState.set("video_interviews", [
      {
        id: "iv_1",
        data: {
          clientId: CLIENT, caregiverId: "cg1", caregiverName: "Basra Yousuf",
          scheduledTime: "2026-09-08T00:00:00.000Z", status: "accepted",
        },
      },
    ]);

    const r = await handleToolCall("list_interviews", { clientId: CLIENT }) as any;

    expect(r.success).toBe(true);
    expect(r.interviews).toHaveLength(1);
    expect(r.interviews[0].scheduledTime).toBe("2026-09-08T00:00:00.000Z");
    expect(r.interviews[0].scheduledTimeLocal).toBe("Monday, September 7 at 5:00 PM");
  });

  it("returns null (not a crash) for a missing or unparseable scheduledTime", async () => {
    hoisted.collState.set("video_interviews", [
      { id: "iv_1", data: { clientId: CLIENT, caregiverId: "cg1", status: "requested" } },
      { id: "iv_2", data: { clientId: CLIENT, caregiverId: "cg1", scheduledTime: "not-a-date", status: "requested" } },
    ]);

    const r = await handleToolCall("list_interviews", { clientId: CLIENT }) as any;

    expect(r.success).toBe(true);
    expect(r.interviews.every((iv: any) => iv.scheduledTimeLocal === null)).toBe(true);
  });
});
