import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const collState = new Map<string, any[]>();
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => ({ id, path: `${path}/${id}`, get: async () => ({ exists: false, data: () => undefined }) });
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = async () => {
      const items = collState.get(path) ?? [];
      return { docs: items.map((d: any) => ({ id: d.id, data: () => d, ref: { path: `${path}/${d.id}` } })) };
    };
    return ref;
  };
  return {
    collState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => collState.clear(),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {}),
}));

import { queryVisitsMerged, getVisitDoc, visitSeniorName } from "./visitQuery";

describe("queryVisitsMerged", () => {
  beforeEach(() => hoisted.reset());

  it("merges appointments and shifts docs into one array", async () => {
    hoisted.collState.set("appointments", [{ id: "a1", date: "2026-09-01", status: "confirmed" }]);
    hoisted.collState.set("shifts", [{ id: "s1", date: "2026-09-01", status: "scheduled" }]);
    const docs = await queryVisitsMerged({
      dateOp: "==", dateValue: "2026-09-01",
      apptStatuses: ["confirmed", "pending_caregiver_confirmation"],
      shiftStatuses: ["scheduled"],
    });
    expect(docs.map(d => d.id).sort()).toEqual(["a1", "s1"]);
  });

  it("skips the shifts query entirely when shiftStatuses is empty", async () => {
    hoisted.collState.set("appointments", [{ id: "a1", date: "2026-09-01", status: "cancelled" }]);
    hoisted.collState.set("shifts", [{ id: "s1", date: "2026-09-01", status: "cancelled" }]);
    const docs = await queryVisitsMerged({
      dateOp: "==", dateValue: "2026-09-01",
      apptStatuses: ["cancelled"],
      shiftStatuses: [],
    });
    expect(docs.map(d => d.id)).toEqual(["a1"]);
  });

  it("supports a status-only query with no date filter at all", async () => {
    hoisted.collState.set("appointments", [{ id: "a1", status: "in-progress" }]);
    hoisted.collState.set("shifts", [{ id: "s1", status: "in-progress" }]);
    const docs = await queryVisitsMerged({
      apptStatuses: ["in-progress"],
      shiftStatuses: ["in-progress"],
    });
    expect(docs.map(d => d.id).sort()).toEqual(["a1", "s1"]);
  });

  it("returns an empty array when both collections have no matches", async () => {
    const docs = await queryVisitsMerged({
      dateOp: "==", dateValue: "2026-09-01",
      apptStatuses: ["confirmed"],
      shiftStatuses: ["scheduled"],
    });
    expect(docs).toEqual([]);
  });
});

describe("getVisitDoc", () => {
  beforeEach(() => hoisted.reset());

  it("returns the appointments doc when it exists there", async () => {
    hoisted.collectionMock.mockImplementationOnce((path: string) => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({ from: "appointments" }) }) }),
    }));
    const snap = await getVisitDoc("v1");
    expect(snap.exists).toBe(true);
    expect(snap.data()).toMatchObject({ from: "appointments" });
  });

  it("falls back to shifts when no appointments doc exists", async () => {
    let call = 0;
    hoisted.collectionMock.mockImplementation((path: string) => ({
      doc: () => ({
        get: async () => {
          call++;
          if (path === "appointments") return { exists: false, data: () => undefined };
          return { exists: true, data: () => ({ from: "shifts" }) };
        },
      }),
    }));
    const snap = await getVisitDoc("v1");
    expect(snap.exists).toBe(true);
    expect(snap.data()).toMatchObject({ from: "shifts" });
    expect(call).toBe(2);
  });
});

describe("visitSeniorName", () => {
  it("prefers appointments' top-level seniorName", () => {
    expect(visitSeniorName({ seniorName: "Linda Doe", clientName: "Doe" })).toBe("Linda Doe");
  });

  it("falls back to shifts' careRecipients[0].name", () => {
    expect(visitSeniorName({ careRecipients: [{ name: "Ana Rivera" }], clientName: "Rivera" })).toBe("Ana Rivera");
  });

  it("falls back to clientName, then the default fallback", () => {
    expect(visitSeniorName({ clientName: "Doe" })).toBe("Doe");
    expect(visitSeniorName({})).toBe("your loved one");
    expect(visitSeniorName({}, "the client")).toBe("the client");
  });
});
