import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory Firestore with transactional get/set, mirroring the create-if-absent
// semantics writeUserNotification relies on.
const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const makeRef = (path: string) => ({
    path,
    id: path.split("/").pop()!,
  });
  const dbObj = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        collection: (sub: string) => ({ doc: (sid: string) => makeRef(`${name}/${id}/${sub}/${sid}`) }),
      }),
    }),
    runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        get: async (ref: any) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref: any, data: Record<string, unknown>) => { docs.set(ref.path, data); },
      };
      return fn(tx);
    },
  };
  return { docs, dbObj };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => h.dbObj, {
    FieldValue: { serverTimestamp: () => ({ __ts: true }) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

import { writeUserNotification, notificationOperationId } from "../userNotification";

const base = {
  sourcePath: "shifts/shift-1",
  eventId: "evt-1",
  recipientId: "client-1",
  transitionType: "extra_visit_declined",
  type: "shift_declined",
  title: "Extra Visit Declined",
  body: "Your caregiver can't make it.",
};

beforeEach(() => h.docs.clear());

describe("writeUserNotification", () => {
  it("creates one notification at the deterministic id", async () => {
    const created = await writeUserNotification(base);
    expect(created).toBe(true);
    const opId = notificationOperationId(base.sourcePath, base.eventId, base.recipientId, base.transitionType);
    const path = `users/client-1/notifications/${opId}`;
    expect(h.docs.has(path)).toBe(true);
    expect(h.docs.get(path)).toMatchObject({ userId: "client-1", type: "shift_declined", isRead: false });
  });

  it("is idempotent — a retried/duplicate event maps to the same id and does not re-create", async () => {
    expect(await writeUserNotification(base)).toBe(true);
    // Second delivery of the SAME event (retry/replay) is a no-op.
    expect(await writeUserNotification(base)).toBe(false);
    expect(h.docs.size).toBe(1);
  });

  it("never overwrites owner-mutated state on replay (read / soft-delete survive)", async () => {
    await writeUserNotification(base);
    const opId = notificationOperationId(base.sourcePath, base.eventId, base.recipientId, base.transitionType);
    const path = `users/client-1/notifications/${opId}`;
    // Owner marks read + soft-deletes.
    h.docs.set(path, { ...h.docs.get(path)!, isRead: true, isDeleted: true });
    // A delayed replay must not reset that state.
    expect(await writeUserNotification(base)).toBe(false);
    expect(h.docs.get(path)).toMatchObject({ isRead: true, isDeleted: true });
  });

  it("distinct transitions on the same source produce distinct notifications", async () => {
    await writeUserNotification({ ...base, transitionType: "extra_visit_accepted", type: "shift_accepted" });
    await writeUserNotification({ ...base, transitionType: "extra_visit_declined" });
    expect(h.docs.size).toBe(2);
  });

  it("different recipients get different ids", () => {
    const a = notificationOperationId("shifts/s", "e", "u1", "t");
    const b = notificationOperationId("shifts/s", "e", "u2", "t");
    expect(a).not.toBe(b);
  });

  it("returns false without a recipient", async () => {
    expect(await writeUserNotification({ ...base, recipientId: "" })).toBe(false);
    expect(h.docs.size).toBe(0);
  });

  it("group-level dedupe: N per-appointment firings with a shared group source → one notification", async () => {
    // Mirrors appointmentUpdated's booking-confirmed path: the trigger fires once
    // per appointment in a recurring group, all with the same group sourcePath and
    // eventId "" — so create-if-absent collapses them to a single notification.
    const group = {
      sourcePath: "recurring_groups/grp-9",
      eventId: "",
      recipientId: "client-1",
      transitionType: "booking_confirmed",
      type: "booking",
      title: "Booking Confirmed!",
      body: "Your caregiver accepted your booking request.",
    };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await writeUserNotification(group));
    expect(results.filter(Boolean).length).toBe(1); // exactly one create
    expect(h.docs.size).toBe(1);
  });
});
