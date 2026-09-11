import { describe, it, expect, beforeEach, vi } from "vitest";

// Single-shift replacement (2026-09-10): when a caregiver cancels one shift,
// the client can pick a replacement caregiver, which creates a new
// booking_requests doc tagged isShiftReplacement/replacementForShiftId. These
// tests lock in what onBookingAccepted does with that tag on accept/decline/
// expiry, and the 30-minute auto-expiry sweep itself — see
// ClientVisitsPage.tsx's handleConfirmReplacement for the write side.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updateMock = vi.fn(async (path: string, data: any) => {
    const existing = docState.get(path) || {};
    docState.set(path, { ...existing, ...data });
  });

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    update: (data: any) => updateMock(path, data),
    set: async (data: any) => { docState.set(path, data); },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string, filters: Array<[string, string, any]> = []): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`),
    add: async (data: any) => { docState.set(`${path}/auto`, data); return makeDocRef(`${path}/auto`); },
    where: (field: string, op: string, value: any) => makeCollRef(path, [...filters, [field, op, value]]),
    limit: () => makeCollRef(path, filters),
    get: async () => {
      const prefix = `${path}/`;
      const docs = [...docState.entries()]
        .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .filter(([, data]) => filters.every(([field, op, value]) => {
          const actual = data?.[field];
          if (op === "==") return actual === value;
          if (op === "<") return (actual?.seconds ?? actual) < (value?.seconds ?? value);
          if (op === "in") return Array.isArray(value) && value.includes(actual);
          return true;
        }))
        .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data, ref: makeDocRef(key) }));
      return { empty: docs.length === 0, docs };
    },
  });

  const dbMock = { collection: (p: string) => makeCollRef(p) };

  return {
    docState, updateMock, dbMock,
    reset: () => { docState.clear(); updateMock.mockClear(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => ({ __delete: true }),
    },
    Timestamp: {
      fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000) }),
    },
  }),
}));

vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    firestore: { document: () => ({ onWrite: (h: any) => h }) },
    pubsub: { schedule: () => ({ onRun: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});

import { onBookingAccepted, expireStaleShiftReplacements } from "../shiftGenerator";

function change(before: any, after: any) {
  return {
    before: { exists: before !== null, data: () => before },
    after: { exists: after !== null, data: () => after },
  };
}

beforeEach(() => {
  hoisted.reset();
});

describe("onBookingAccepted — single-shift replacement resolution", () => {
  it("reopens the original shift (back to needs_replacement) when the replacement request is declined", async () => {
    hoisted.docState.set("shifts/shift1", {
      status: "needs_replacement",
      replacementRequestId: "br1",
      replacementCaregiverName: "Jordan",
    });

    await onBookingAccepted(
      change(
        { status: "pending" },
        { status: "declined", isShiftReplacement: true, replacementForShiftId: "shift1" },
      ) as any,
      { params: { bookingId: "br1" } } as any,
    );

    const shift = hoisted.docState.get("shifts/shift1");
    expect(shift.status).toBe("needs_replacement");
    expect(shift.replacementRequestId).toEqual({ __delete: true });
    expect(shift.replacementCaregiverName).toEqual({ __delete: true });
  });

  it("reopens the original shift when the replacement request is cancelled (e.g. the client withdraws it)", async () => {
    hoisted.docState.set("shifts/shift1", { status: "needs_replacement", replacementRequestId: "br1" });

    await onBookingAccepted(
      change(
        { status: "pending" },
        { status: "cancelled", isShiftReplacement: true, replacementForShiftId: "shift1" },
      ) as any,
      { params: { bookingId: "br1" } } as any,
    );

    expect(hoisted.docState.get("shifts/shift1").status).toBe("needs_replacement");
  });

  it("reopens the original shift when the replacement request expires (no response within 30 min)", async () => {
    hoisted.docState.set("shifts/shift1", { status: "needs_replacement", replacementRequestId: "br1" });

    await onBookingAccepted(
      change(
        { status: "pending" },
        { status: "expired", isShiftReplacement: true, replacementForShiftId: "shift1" },
      ) as any,
      { params: { bookingId: "br1" } } as any,
    );

    expect(hoisted.docState.get("shifts/shift1").status).toBe("needs_replacement");
  });

  it("does NOT touch the original shift for a normal (non-replacement) decline", async () => {
    hoisted.docState.set("shifts/shift1", { status: "needs_replacement", replacementRequestId: "br1" });

    await onBookingAccepted(
      change({ status: "pending" }, { status: "declined" }) as any,
      { params: { bookingId: "br1" } } as any,
    );

    // No isShiftReplacement flag — untouched, still waiting.
    expect(hoisted.docState.get("shifts/shift1").status).toBe("needs_replacement");
    expect(hoisted.docState.get("shifts/shift1").replacementRequestId).toBe("br1");
  });

  it("marks the original shift cancelled/superseded once the replacement caregiver accepts", async () => {
    hoisted.docState.set("shifts/shift1", { status: "needs_replacement", replacementRequestId: "br1" });

    await onBookingAccepted(
      change(
        { status: "pending" },
        {
          status: "accepted",
          isShiftReplacement: true,
          replacementForShiftId: "shift1",
          schedule: { dayShiftTimes: {} }, // empty — no new shifts to generate in this test
        },
      ) as any,
      { params: { bookingId: "br1" } } as any,
    );

    const shift = hoisted.docState.get("shifts/shift1");
    expect(shift.status).toBe("cancelled");
    expect(shift.cancelledBy).toBe("caregiver");
    expect(shift.supersededByBookingId).toBe("br1");
    expect(shift.replacementRequestId).toEqual({ __delete: true });
  });

  it("does NOT touch any shift for a normal (non-replacement) booking acceptance", async () => {
    await onBookingAccepted(
      change(
        { status: "pending" },
        { status: "accepted", schedule: { dayShiftTimes: {} } },
      ) as any,
      { params: { bookingId: "br2" } } as any,
    );

    expect(hoisted.updateMock).not.toHaveBeenCalled();
  });
});

describe("expireStaleShiftReplacements", () => {
  it("expires a pending replacement request older than 30 minutes", async () => {
    hoisted.docState.set("booking_requests/br1", {
      isShiftReplacement: true,
      status: "pending",
      createdAt: { seconds: Math.floor((Date.now() - 40 * 60 * 1000) / 1000) }, // 40 min ago
    });

    await expireStaleShiftReplacements(undefined as any);

    expect(hoisted.docState.get("booking_requests/br1").status).toBe("expired");
  });

  it("leaves a pending replacement request under 30 minutes old untouched", async () => {
    hoisted.docState.set("booking_requests/br2", {
      isShiftReplacement: true,
      status: "pending",
      createdAt: { seconds: Math.floor((Date.now() - 5 * 60 * 1000) / 1000) }, // 5 min ago
    });

    await expireStaleShiftReplacements(undefined as any);

    expect(hoisted.docState.get("booking_requests/br2").status).toBe("pending");
  });

  it("leaves a normal (non-replacement) pending booking request untouched no matter how old", async () => {
    hoisted.docState.set("booking_requests/br3", {
      status: "pending",
      createdAt: { seconds: Math.floor((Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000) }, // 5 days ago
    });

    await expireStaleShiftReplacements(undefined as any);

    expect(hoisted.docState.get("booking_requests/br3").status).toBe("pending");
  });
});
