// U3 — the MVR "wall".
//
// Guarantees the load-bearing requirement (R4): a standalone MVR-only Checkr
// report governs ONLY the Approved Driver badge (`isApprovedDriver` / `mvrStatus`)
// and never the shared verification fields (verified / verificationStatus /
// status / approvedAt / backgroundCheckStatus / backgroundCheckComplete). Also
// pins the criminal-report path (no regression) and initiateMvrOnlyCheck.

import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.CHECKR_WEBHOOK_SECRET = "";
  process.env.FUNCTIONS_EMULATOR = "true"; // skip signature verification
  process.env.CHECKR_PACKAGE = "criminal_basic";
  process.env.CHECKR_PACKAGE_MVR_ONLY = "mvr_only";
  process.env.CHECKR_KEY = "test_key";

  const docs = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const updates: Array<{ path: string; data: any }> = [];
  const adds: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    create: vi.fn(async (data: any) => {
      if (docs.has(path)) {
        const err: any = new Error("ALREADY_EXISTS");
        err.code = 6;
        throw err;
      }
      docs.set(path, data);
    }),
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      updates.push({ path, data });
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    }),
    delete: vi.fn(async () => { docs.delete(path); }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return {
        empty: items.length === 0,
        docs: items.map((d: any, i: number) => ({
          id: d.id ?? `doc-${i}`,
          data: () => d,
          ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`),
        })),
      };
    });
    ref.add = vi.fn(async (data: any) => {
      adds.push({ path, data });
      return { id: `auto-${adds.length}` };
    });
    return ref;
  };

  const collection = vi.fn((name: string) => makeCollRef(name));
  const firestoreFn: any = Object.assign(() => ({ collection }), {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      delete: () => ({ __delete: true }),
    },
  });

  return {
    docs, collState, updates, adds, collection, firestoreFn,
    reset: () => { docs.clear(); collState.clear(); updates.length = 0; adds.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: hoisted.firestoreFn,
}));

import { checkrWebhook, initiateMvrOnlyCheck } from "../checkr";

const CORE_FIELDS = [
  "verified", "verificationStatus", "status", "approvedAt",
  "backgroundCheckStatus", "backgroundCheckComplete",
];

function checkrReq(event: any) {
  return { method: "POST", headers: {}, body: event, rawBody: Buffer.from("") } as any;
}
function makeRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res;
}

// Seed a caregiver reachable by both the candidate-id query and direct doc get.
function seedCaregiver(uid: string, data: any) {
  const doc = { id: uid, backgroundCheckData: { checkrCandidateId: "cand1" }, ...data };
  hoisted.collState.set("caregivers", [doc]);
  hoisted.docs.set(`caregivers/${uid}`, doc);
}

// Collect every field written to the caregiver doc across the request.
function caregiverWrites(uid: string): Record<string, any> {
  return hoisted.updates
    .filter((u) => u.path === `caregivers/${uid}`)
    .reduce((acc, u) => ({ ...acc, ...u.data }), {} as Record<string, any>);
}

const reportEvent = (id: string, opts: { pkg: string; candidate?: string; result?: string }) => ({
  id: `evt_${id}`,
  type: "report.completed",
  data: {
    object: {
      id,
      candidate_id: opts.candidate ?? "cand1",
      package: opts.pkg,
      result: opts.result ?? "clear",
      assessment: opts.result ?? "clear",
      status: "complete",
    },
  },
});

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("MVR wall — standalone MVR report governs only the badge", () => {
  it("clear MVR report sets isApprovedDriver and leaves core verification untouched", async () => {
    seedCaregiver("cg1", { verified: false, verificationStatus: "submitted", status: "pending" });
    const res = makeRes();

    await (checkrWebhook as any)(checkrReq(reportEvent("rep_mvr", { pkg: "mvr_only", result: "clear" })), res);

    const w = caregiverWrites("cg1");
    expect(w.isApprovedDriver).toBe(true);
    expect(w.mvrStatus).toBe("clear");
    for (const f of CORE_FIELDS) expect(w).not.toHaveProperty(f);
    expect(res.json).toHaveBeenCalledWith({ received: true, mvr: true });
  });

  it("adverse MVR report withholds the badge and leaves core verification untouched", async () => {
    seedCaregiver("cg1", { verified: true, verificationStatus: "approved", status: "active" });
    const res = makeRes();

    await (checkrWebhook as any)(checkrReq(reportEvent("rep_mvr", { pkg: "mvr_only", result: "consider" })), res);

    const w = caregiverWrites("cg1");
    expect(w.isApprovedDriver).toBe(false);
    expect(w.mvrStatus).toBe("consider");
    for (const f of CORE_FIELDS) expect(w).not.toHaveProperty(f);
  });
});

describe("criminal report — unchanged core behavior (characterization)", () => {
  it("clear criminal report flips core verification and does NOT grant the driver badge", async () => {
    seedCaregiver("cg1", { verified: false, verificationStatus: "submitted", mvrPaid: false });
    const res = makeRes();

    await (checkrWebhook as any)(checkrReq(reportEvent("rep_crim", { pkg: "criminal_basic", result: "clear" })), res);

    const w = caregiverWrites("cg1");
    expect(w.verified).toBe(true);
    expect(w.verificationStatus).toBe("approved");
    expect(w.status).toBe("active");
    expect(w.isApprovedDriver).toBeUndefined(); // mvrPaid !== true
  });
});

describe("initiateMvrOnlyCheck", () => {
  it("is idempotent — already-initiated caregiver triggers no new check", async () => {
    seedCaregiver("cg1", { mvrCheckInitiated: true });
    await initiateMvrOnlyCheck("cg1");
    // No invitation write and no flag re-write beyond the seed.
    expect(hoisted.updates.filter((u) => u.path === "caregivers/cg1")).toHaveLength(0);
  });

  it("raises an admin alert when no Checkr candidate exists (never lose the purchase)", async () => {
    const doc = { id: "cg2" }; // no backgroundCheckData.checkrCandidateId
    hoisted.docs.set("caregivers/cg2", doc);
    await initiateMvrOnlyCheck("cg2");
    expect(hoisted.adds.some((a) => a.path === "admin_alerts" && a.data.type === "mvr_no_candidate")).toBe(true);
  });

  it("sends an MVR-only invitation on the existing candidate and sets flags", async () => {
    seedCaregiver("cg1", { state: "CA" });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: "inv_1" }), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);

    await initiateMvrOnlyCheck("cg1");

    // The invitation call used the MVR-only package on the existing candidate.
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toContain("/invitations");
    const body = JSON.parse(init.body);
    expect(body.candidate_id).toBe("cand1");
    expect(body.package).toBe("mvr_only");

    const w = caregiverWrites("cg1");
    expect(w.mvrPaid).toBe(true);
    expect(w.mvrCheckInitiated).toBe(true);
    expect(w.mvrStatus).toBe("pending");
  });
});
