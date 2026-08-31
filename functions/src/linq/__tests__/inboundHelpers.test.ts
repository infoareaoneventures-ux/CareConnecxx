import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-31: handleRecurringConfirm used to create a separate Evia-only
// `recurring_schedules` doc + a batch of `appointments` docs. The website has
// no such separate recurring-schedule collection at all — booking_requests's
// own schedule.ongoing/dayShiftTimes IS the site's real recurring mechanism,
// and it's the same doc the original booking already created. These tests
// lock in the fix: update that same doc instead of building a parallel one.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
  });
  const makeCollRef = (path: string): any => ({ doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`) });

  return {
    docState, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: () => ({ __delete: true }) },
  }),
}));

const sendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../client", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));

import { handleRecurringConfirm } from "../inboundHelpers";

const PHONE = "+15550001111";

describe("handleRecurringConfirm", () => {
  beforeEach(() => { hoisted.reset(); sendMessage.mockClear(); });

  it("no-ops (just clears the flag) when there's no pending schedule", async () => {
    await handleRecurringConfirm(PHONE, "chat1", {} as any);
    const update = hoisted.updates.find(u => u.path === `agent_sessions/${PHONE}`);
    expect(update?.data.awaitingRecurringConfirmation).toEqual({ __delete: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fails soft when the pending schedule has no bookingRequestId link", async () => {
    const session = { pendingRecurringSchedule: { caregiverId: "cg1", caregiverName: "Alice", days: ["Mon"], startTime: "09:00", endTime: "12:00", durationHours: 3, hourlyRate: 25 } } as any;
    await handleRecurringConfirm(PHONE, "chat1", session);
    expect(sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("wasn't able to find that booking"));
    const update = hoisted.updates.find(u => u.path === `agent_sessions/${PHONE}`);
    expect(update?.data.pendingRecurringSchedule).toEqual({ __delete: true });
    expect(hoisted.updates.some(u => u.path.startsWith("booking_requests/"))).toBe(false);
  });

  it("updates the SAME booking_requests doc's schedule instead of creating recurring_schedules/appointments", async () => {
    const session = {
      pendingRecurringSchedule: {
        caregiverId: "cg1", caregiverName: "Alice", days: ["Mon", "Wed"],
        startTime: "09:00", endTime: "12:00", durationHours: 3, hourlyRate: 25,
        bookingRequestId: "br1",
      },
    } as any;
    await handleRecurringConfirm(PHONE, "chat1", session);

    const bookingReqUpdate = hoisted.updates.find(u => u.path === "booking_requests/br1");
    expect(bookingReqUpdate?.data.schedule).toMatchObject({
      ongoing: true,
      endDate: null,
      dayShiftTimes: {
        Mon: [{ start: "09:00", end: "12:00" }],
        Wed: [{ start: "09:00", end: "12:00" }],
      },
    });
    expect(typeof bookingReqUpdate?.data.schedule.startDate).toBe("string");

    // Never creates the old parallel collections
    expect(hoisted.updates.some(u => u.path.startsWith("recurring_schedules/"))).toBe(false);
    expect(hoisted.updates.some(u => u.path.startsWith("appointments/"))).toBe(false);

    const sessionUpdate = hoisted.updates.find(u => u.path === `agent_sessions/${PHONE}`);
    expect(sessionUpdate?.data.awaitingRecurringConfirmation).toEqual({ __delete: true });
    expect(sessionUpdate?.data.pendingRecurringSchedule).toEqual({ __delete: true });
    expect(sendMessage).toHaveBeenCalledWith("chat1", expect.stringContaining("Alice"));
  });
});
