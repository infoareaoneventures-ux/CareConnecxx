import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Firestore fake: dot-path updates, __delete sentinel, serialized
// transactions (mirrors Firestore's optimistic-lock outcome for our claims).
const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const queryResults = new Map<string, any[]>(); // collection path → docs for where().get()

  const applyUpdate = (path: string, data: Record<string, any>) => {
    const obj = docState.get(path) ?? {};
    for (const [key, value] of Object.entries(data)) {
      const parts = key.split(".");
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = cur[parts[i]] ?? {};
        cur = cur[parts[i]];
      }
      const leaf = parts[parts.length - 1];
      if (value && typeof value === "object" && value.__delete) delete cur[leaf];
      else cur[leaf] = value;
    }
    docState.set(path, obj);
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => makeSnap(path),
    update: vi.fn(async (data: any) => applyUpdate(path, data)),
    set: vi.fn(async (data: any) => docState.set(path, data)),
  });

  const makeSnap = (path: string) => ({
    exists: docState.has(path),
    data:   () => docState.get(path),
    ref:    makeDocRef(path),
    id:     path.split("/").pop(),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = async () => {
      const items = queryResults.get(path) ?? [];
      return { empty: items.length === 0, docs: items.map((d: any) => ({ id: d.id, data: () => d })) };
    };
    return ref;
  };

  // Serialize transactions so concurrent invocations resolve like Firestore's
  // optimistic locking: second reader sees the first writer's claim.
  let txChain: Promise<unknown> = Promise.resolve();
  const runTransaction = (fn: (tx: any) => Promise<any>) => {
    const run = txChain.then(() =>
      fn({
        get:    async (ref: any) => makeSnap(ref.path),
        update: (ref: any, data: any) => applyUpdate(ref.path, data),
      })
    );
    txChain = run.catch(() => {});
    return run;
  };

  const dbMock = { collection: (p: string) => makeCollRef(p), runTransaction };

  return {
    docState, queryResults, dbMock,
    reset: () => { docState.clear(); queryResults.clear(); txChain = Promise.resolve(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, {
    FieldValue: { delete: () => ({ __delete: true }) },
  }),
}));

// Builder mock: .runWith().firestore.document().onWrite(handler) → handler
vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    runWith: () => builder,
    firestore: { document: () => ({ onWrite: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});

const { createAssets, trySendMock, scheduleTriggerMock, cancelTriggersByRefMock, opsAlert } = vi.hoisted(() => ({
  createAssets: vi.fn(),
  trySendMock: vi.fn(),
  scheduleTriggerMock: vi.fn().mockResolvedValue("trig-1"),
  cancelTriggersByRefMock: vi.fn().mockResolvedValue(0),
  opsAlert: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../agents/interviewLinks", () => ({ createInterviewCallAssets: createAssets }));
vi.mock("../../utils/toolNotify", () => ({ trySend: trySendMock }));
vi.mock("../triggerEngine", () => ({
  scheduleTrigger: scheduleTriggerMock,
  cancelTriggersByRef: cancelTriggersByRefMock,
}));
vi.mock("../../observability/caraOpsAlerts", () => ({ createCaraOpsAlert: opsAlert }));

import { onVideoInterviewLinkEnsure } from "../interviewLinkTrigger";
import { parseScheduledTimeMs } from "../../utils/scheduledTime";

const handler = onVideoInterviewLinkEnsure as unknown as (change: any, context: any) => Promise<void>;

const FUTURE_MS  = Date.now() + 3 * 24 * 60 * 60 * 1000;
const FUTURE_ISO = new Date(FUTURE_MS).toISOString();

function makeChange(id: string, before: any | null) {
  const path = `video_interviews/${id}`;
  return {
    before: { exists: before !== null, data: () => before },
    after:  {
      exists: hoisted.docState.has(path),
      data:   () => hoisted.docState.get(path),
      ref:    {
        id, path,
        get:    async () => ({ exists: hoisted.docState.has(path), data: () => hoisted.docState.get(path), ref: { path } }),
        update: async (data: any) => {
          const applied: Record<string, any> = data;
          // reuse the fake's dot-path semantics through a transaction update
          await hoisted.dbMock.runTransaction(async (tx: any) => tx.update({ path }, applied));
        },
      },
    },
  };
}

async function fire(id: string, before: any | null = null) {
  await handler(makeChange(id, before), { params: { interviewId: id } });
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
  createAssets.mockResolvedValue({ callUrl: "https://meet.google.com/abc-defg-hij", icsUrl: "https://signed/ics" });
  trySendMock.mockResolvedValue({ sent: true });
  scheduleTriggerMock.mockResolvedValue("trig-1");
  hoisted.docState.set("caregivers/cg1", { phone: "+14085551111", name: "Maria" });
  hoisted.docState.set("users/cl1", { phone: "+14085552222", name: "The Nguyen Family" });
});

describe("parseScheduledTimeMs", () => {
  it("interprets naive strings as Pacific wall-clock (not UTC)", () => {
    const ms = parseScheduledTimeMs("2026-07-10T14:00:00");
    expect(new Date(ms).toISOString()).toBe("2026-07-10T21:00:00.000Z"); // PDT = UTC-7
  });
  it("passes through offset/Z strings unchanged", () => {
    expect(parseScheduledTimeMs("2026-07-10T21:00:00.000Z")).toBe(Date.parse("2026-07-10T21:00:00.000Z"));
    expect(parseScheduledTimeMs("2026-07-10T14:00:00-07:00")).toBe(Date.parse("2026-07-10T21:00:00Z"));
  });
});

describe("onVideoInterviewLinkEnsure", () => {
  it("web 'requested' create → SMS-accept path for the caregiver, no link yet", async () => {
    hoisted.docState.set("video_interviews/iv1", {
      status: "requested", clientId: "cl1", caregiverId: "cg1",
      clientName: "The Nguyen Family", caregiverName: "Maria", scheduledTime: FUTURE_ISO,
    });
    await fire("iv1", null);
    expect(trySendMock).toHaveBeenCalledTimes(1);
    expect(trySendMock.mock.calls[0][0]).toBe("+14085551111");
    expect(trySendMock.mock.calls[0][1]).toContain("video interview");
    expect(createAssets).not.toHaveBeenCalled();
    expect(hoisted.docState.get("video_interviews/iv1").requestNotifiedAt).toBeTruthy();
  });

  it("web doc reaching 'accepted' → generates link, delivers to both, schedules reminders", async () => {
    hoisted.docState.set("video_interviews/iv2", {
      status: "accepted", clientId: "cl1", caregiverId: "cg1",
      clientName: "The Nguyen Family", caregiverName: "Maria", scheduledTime: FUTURE_ISO,
    });
    await fire("iv2", { status: "requested" });

    const doc = hoisted.docState.get("video_interviews/iv2");
    expect(createAssets).toHaveBeenCalledTimes(1);
    expect(doc.callUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(doc.linkDelivery.client.status).toBe("sent");
    expect(doc.linkDelivery.caregiver.status).toBe("sent");
    expect(doc.remindersScheduledAt).toBeTruthy();
    expect(doc.linkWork?.claimedAt).toBeUndefined(); // claim released
    expect(trySendMock).toHaveBeenCalledTimes(2);
    const msgs = trySendMock.mock.calls.map((c) => c[1] as string);
    for (const m of msgs) expect(m).toContain("https://meet.google.com/abc-defg-hij");
    // Reminders: both parties, calibration-exempt, 1h before, cancellable by refId
    expect(scheduleTriggerMock).toHaveBeenCalledTimes(2);
    for (const call of scheduleTriggerMock.mock.calls) {
      expect(call[1]).toEqual({ bypassCalibration: true });
      expect(new Date(call[0].scheduledAt).getTime()).toBe(FUTURE_MS - 60 * 60 * 1000);
      expect(call[0].refId).toBe("video_interview_iv2");
    }
  });

  it("agreed → declined transition cancels pending reminders and clears remindersScheduledAt", async () => {
    hoisted.docState.set("video_interviews/iv9", {
      status: "declined", declinedBy: "client", clientId: "cl1", caregiverId: "cg1",
      scheduledTime: FUTURE_ISO, callUrl: "https://meet.google.com/xyz",
      linkDelivery: { client: { status: "sent", at: "x" }, caregiver: { status: "sent", at: "x" } },
      remindersScheduledAt: "2026-07-05T00:00:00Z",
    });
    await fire("iv9", { status: "confirmed" });
    expect(cancelTriggersByRefMock).toHaveBeenCalledWith("video_interview_iv9");
    expect(hoisted.docState.get("video_interviews/iv9").remindersScheduledAt).toBeUndefined();
    // dead interview: no link work, no sends, no new reminders
    expect(createAssets).not.toHaveBeenCalled();
    expect(scheduleTriggerMock).not.toHaveBeenCalled();
  });

  it("requested → declined (never agreed) does not attempt cancellation", async () => {
    hoisted.docState.set("video_interviews/iv10", {
      status: "declined", declinedBy: "caregiver", clientId: "cl1", caregiverId: "cg1",
      scheduledTime: FUTURE_ISO,
    });
    await fire("iv10", { status: "requested" });
    expect(cancelTriggersByRefMock).not.toHaveBeenCalled();
  });

  it("fully-processed doc write → precheck no-op (no regeneration, no re-sends)", async () => {
    hoisted.docState.set("video_interviews/iv3", {
      status: "confirmed", clientId: "cl1", caregiverId: "cg1", scheduledTime: FUTURE_ISO,
      callUrl: "https://meet.google.com/xyz", icsUrl: "https://signed/ics",
      linkDelivery: { client: { status: "sent", at: "x" }, caregiver: { status: "sent", at: "x" } },
      remindersScheduledAt: "2026-07-05T00:00:00Z",
    });
    await fire("iv3", { status: "scheduled" });
    expect(createAssets).not.toHaveBeenCalled();
    expect(trySendMock).not.toHaveBeenCalled();
    expect(scheduleTriggerMock).not.toHaveBeenCalled();
  });

  it("MCP-shaped create (link + delivery markers present) → schedules reminders only", async () => {
    hoisted.docState.set("video_interviews/iv4", {
      status: "scheduled", clientId: "cl1", caregiverId: "cg1",
      clientName: "The Nguyen Family", caregiverName: "Maria", scheduledTime: FUTURE_ISO,
      callUrl: "https://meet.google.com/abc", icsUrl: "https://signed/ics",
      linkDelivery: {
        client:    { status: "delivered_in_chat", at: "x" },
        caregiver: { status: "sent", at: "x" },
      },
    });
    await fire("iv4", null);
    expect(createAssets).not.toHaveBeenCalled();
    expect(trySendMock).not.toHaveBeenCalled(); // zero duplicate sends
    expect(scheduleTriggerMock).toHaveBeenCalledTimes(2);
    expect(hoisted.docState.get("video_interviews/iv4").remindersScheduledAt).toBeTruthy();
  });

  it("two concurrent events on the same link-less doc → exactly one space, one send set", async () => {
    hoisted.docState.set("video_interviews/iv5", {
      status: "accepted", clientId: "cl1", caregiverId: "cg1",
      clientName: "F", caregiverName: "Maria", scheduledTime: FUTURE_ISO,
    });
    await Promise.all([fire("iv5", { status: "requested" }), fire("iv5", { status: "requested" })]);
    expect(createAssets).toHaveBeenCalledTimes(1);
    // one send per recipient, not two
    const caregiverSends = trySendMock.mock.calls.filter((c) => c[0] === "+14085551111");
    const clientSends    = trySendMock.mock.calls.filter((c) => c[0] === "+14085552222");
    expect(caregiverSends.length).toBe(1);
    expect(clientSends.length).toBe(1);
  });

  it("link generation failure → no crash, claim released for a later retry", async () => {
    createAssets.mockRejectedValue(new Error("invalid_grant"));
    hoisted.docState.set("video_interviews/iv6", {
      status: "accepted", clientId: "cl1", caregiverId: "cg1",
      clientName: "F", caregiverName: "Maria", scheduledTime: FUTURE_ISO,
    });
    await expect(fire("iv6", { status: "requested" })).resolves.toBeUndefined();
    const doc = hoisted.docState.get("video_interviews/iv6");
    expect(doc.callUrl).toBeUndefined();
    expect(doc.linkWork?.claimedAt).toBeUndefined(); // released → next write retries
  });

  it("declined status → not agreed, nothing happens", async () => {
    hoisted.docState.set("video_interviews/iv7", {
      status: "declined", clientId: "cl1", caregiverId: "cg1", scheduledTime: FUTURE_ISO,
    });
    await fire("iv7", { status: "scheduled" });
    expect(createAssets).not.toHaveBeenCalled();
    expect(trySendMock).not.toHaveBeenCalled();
    expect(scheduleTriggerMock).not.toHaveBeenCalled();
  });

  it("legacy naive scheduledTime → reminder at the correct Pacific-relative instant", async () => {
    // Use a fixed future date in naive local form
    const naiveDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const y = naiveDate.getFullYear(), mo = String(naiveDate.getMonth() + 1).padStart(2, "0"), d = String(naiveDate.getDate()).padStart(2, "0");
    const naive = `${y}-${mo}-${d}T14:00:00`;
    const expectedStartMs = parseScheduledTimeMs(naive);
    hoisted.docState.set("video_interviews/iv8", {
      status: "accepted", clientId: "cl1", caregiverId: "cg1",
      clientName: "F", caregiverName: "Maria", scheduledTime: naive,
    });
    await fire("iv8", { status: "requested" });
    expect(scheduleTriggerMock).toHaveBeenCalled();
    const scheduledAt = new Date(scheduleTriggerMock.mock.calls[0][0].scheduledAt).getTime();
    expect(scheduledAt).toBe(expectedStartMs - 60 * 60 * 1000);
  });

  it("interview under 90 minutes away → no stale pre-start reminder", async () => {
    hoisted.docState.set("video_interviews/iv9", {
      status: "accepted", clientId: "cl1", caregiverId: "cg1",
      clientName: "F", caregiverName: "Maria",
      scheduledTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await fire("iv9", { status: "requested" });
    expect(scheduleTriggerMock).not.toHaveBeenCalled();
    expect(hoisted.docState.get("video_interviews/iv9").remindersScheduledAt).toBeTruthy();
  });

  it("missing caregiver phone → terminal missing_phone outcome + ops alert, no retry loop", async () => {
    hoisted.docState.delete("caregivers/cg1");
    hoisted.docState.set("caregivers/cg1", { name: "Maria" }); // no phone
    hoisted.docState.set("video_interviews/iv10", {
      status: "accepted", clientId: "cl1", caregiverId: "cg1",
      clientName: "F", caregiverName: "Maria", scheduledTime: FUTURE_ISO,
    });
    await fire("iv10", { status: "requested" });
    const doc = hoisted.docState.get("video_interviews/iv10");
    expect(doc.linkDelivery.caregiver.status).toBe("missing_phone");
    expect(opsAlert).toHaveBeenCalledWith(expect.objectContaining({ type: "interview_link_undeliverable" }));
  });
});
