// U6 — swap double-accept race. Two caregivers accepting the same open swap
// must not both win: the status is re-checked INSIDE the transaction, so the
// race loser leaves the winner's appointment assignment intact.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  // When set, simulates another caregiver winning the race between the
  // pre-check read and our transaction (i.e. the swap flips to accepted inside
  // the race window, before our tx.get runs).
  const raceWindow = { flip: false };

  const makeDocRef = (path: string) => ({
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
  });
  const makeColl = (name: string) => ({ doc: (id: string) => makeDocRef(`${name}/${id}`) });

  const firestoreFn: any = () => ({
    collection: (name: string) => makeColl(name),
    runTransaction: async (fn: any) => {
      if (raceWindow.flip) {
        docState.set("shift_swap_requests/sw1", {
          ...(docState.get("shift_swap_requests/sw1") ?? {}),
          status: "accepted",
          toCaregiverId: "OTHER_CG",
        });
      }
      const tx = {
        get: async (ref: any) => ({ exists: docState.has(ref.path), data: () => docState.get(ref.path) }),
        update: (ref: any, data: any) => { docState.set(ref.path, { ...(docState.get(ref.path) ?? {}), ...data }); },
      };
      return fn(tx);
    },
  });

  const sendMessage = vi.fn(async () => {});

  return {
    docState, raceWindow, firestoreFn, sendMessage,
    reset: () => { docState.clear(); raceWindow.flip = false; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestoreFn },
  firestore: hoisted.firestoreFn,
}));

const sendMessage = hoisted.sendMessage;
vi.mock("../../linq/client", () => ({ sendMessage: hoisted.sendMessage }));
vi.mock("../../utils/parseWithClaude", () => ({ parseWithClaude: vi.fn() }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: vi.fn() }));
vi.mock("../../utils/caregiverEligibility", () => ({ isCaregiverBookable: () => true }));

import { handleSwapAcceptance } from "../caregiverSwapHandler";

const openSwap = () => ({
  status: "open",
  appointmentId: "appt1",
  fromCaregiverId: "cg1",
  fromCaregiverName: "Alice",
  clientId: "client1",
  date: "2026-06-20",
});

describe("U6 — swap acceptance race guard", () => {
  beforeEach(() => { hoisted.reset(); sendMessage.mockClear(); });

  it("assigns the appointment to the accepting caregiver on an open swap", async () => {
    hoisted.docState.set("shift_swap_requests/sw1", openSwap());
    hoisted.docState.set("appointments/appt1", { caregiverId: "cg1" });

    await handleSwapAcceptance("cg2", "Bob", "sw1", "chat2");

    expect(hoisted.docState.get("shift_swap_requests/sw1").status).toBe("accepted");
    expect(hoisted.docState.get("shift_swap_requests/sw1").toCaregiverId).toBe("cg2");
    expect(hoisted.docState.get("appointments/appt1").caregiverId).toBe("cg2");
    expect(sendMessage).toHaveBeenCalledWith("chat2", expect.stringContaining("You've got it"));
  });

  it("does NOT reassign when another caregiver wins inside the race window", async () => {
    hoisted.docState.set("shift_swap_requests/sw1", openSwap()); // pre-check sees 'open'
    hoisted.docState.set("appointments/appt1", { caregiverId: "cg1" });
    hoisted.raceWindow.flip = true; // another tx commits 'accepted' before our tx.get

    await handleSwapAcceptance("cg2", "Bob", "sw1", "chat2");

    // The appointment must NOT be overwritten to the race loser.
    expect(hoisted.docState.get("appointments/appt1").caregiverId).not.toBe("cg2");
    expect(sendMessage).toHaveBeenCalledWith("chat2", expect.stringContaining("already been filled"));
  });

  it("short-circuits at the pre-check when the swap is already filled", async () => {
    hoisted.docState.set("shift_swap_requests/sw1", { ...openSwap(), status: "accepted", toCaregiverId: "cg1" });
    hoisted.docState.set("appointments/appt1", { caregiverId: "cg1" });

    await handleSwapAcceptance("cg2", "Bob", "sw1", "chat2");

    expect(hoisted.docState.get("appointments/appt1").caregiverId).toBe("cg1");
    expect(sendMessage).toHaveBeenCalledWith("chat2", expect.stringContaining("already been filled"));
  });

  it("handles a swap request that no longer exists", async () => {
    await handleSwapAcceptance("cg2", "Bob", "missing", "chat2");
    expect(sendMessage).toHaveBeenCalledWith("chat2", expect.stringContaining("no longer available"));
  });
});
