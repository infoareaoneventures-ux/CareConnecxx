import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const collState = new Map<string, any[]>();
  const queried: string[] = [];
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => ({ id, path: `${path}/${id}`, get: async () => ({ exists: false, data: () => undefined }) });
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = async () => {
      queried.push(path);
      const items = collState.get(path) ?? [];
      return { docs: items.map((d: any) => ({ id: d.id, data: () => d, ref: { path: `${path}/${d.id}` } })) };
    };
    return ref;
  };
  return {
    collState, queried,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { collState.clear(); queried.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {}),
}));

import { queryVisits, getVisitDoc, visitSeniorName } from "./visitQuery";

// 2026-09-17: the legacy Evia-only `appointments` collection is no longer
// read here — the site's My Bookings / Calendar read `shifts` only, and a
// live SMS test caught Evia reporting "two visits on Thursday 9/24" that
// existed nowhere on the site (stale `appointments` docs from the retired
// recurring_schedules extender).
describe("queryVisits (shifts only)", () => {
  beforeEach(() => hoisted.reset());

  it("returns shifts docs and never touches the appointments collection", async () => {
    hoisted.collState.set("appointments", [{ id: "a1", date: "2026-09-01", status: "confirmed" }]);
    hoisted.collState.set("shifts", [{ id: "s1", date: "2026-09-01", status: "scheduled" }]);
    const docs = await queryVisits({ dateOp: "==", dateValue: "2026-09-01", shiftStatuses: ["scheduled"] });
    expect(docs.map(d => d.id)).toEqual(["s1"]);
    expect(hoisted.queried).toEqual(["shifts"]);
  });

  it("skips the query entirely when shiftStatuses is empty", async () => {
    hoisted.collState.set("shifts", [{ id: "s1", date: "2026-09-01", status: "cancelled" }]);
    const docs = await queryVisits({ dateOp: "==", dateValue: "2026-09-01", shiftStatuses: [] });
    expect(docs).toEqual([]);
    expect(hoisted.queried).toEqual([]);
  });

  it("supports a status-only query with no date filter at all", async () => {
    hoisted.collState.set("shifts", [{ id: "s1", status: "in-progress" }]);
    const docs = await queryVisits({ shiftStatuses: ["in-progress"] });
    expect(docs.map(d => d.id)).toEqual(["s1"]);
  });

  it("returns an empty array when nothing matches", async () => {
    const docs = await queryVisits({ dateOp: "==", dateValue: "2026-09-01", shiftStatuses: ["scheduled"] });
    expect(docs).toEqual([]);
  });

  // 2026-08-31: this function always adds its own `status in [...]` filter on
  // top of whatever the caller passes — a "today or tomorrow" window must be a
  // >=/dateUpperBound range, never a second "in" clause (invalid in Firestore).
  it("a >=/dateUpperBound range is accepted alongside the status filter", async () => {
    hoisted.collState.set("shifts", [
      { id: "s1", date: "2026-09-01", status: "scheduled" },
      { id: "s2", date: "2026-09-02", status: "scheduled" },
    ]);
    const docs = await queryVisits({ dateOp: ">=", dateValue: "2026-09-01", dateUpperBound: "2026-09-02", shiftStatuses: ["scheduled"] });
    expect(docs.map(d => d.id).sort()).toEqual(["s1", "s2"]);
  });
});

describe("getVisitDoc", () => {
  beforeEach(() => hoisted.reset());

  it("returns the appointments doc when it exists there", async () => {
    hoisted.collectionMock.mockImplementationOnce((_path: string) => ({
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
  it("prefers a top-level seniorName", () => {
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
