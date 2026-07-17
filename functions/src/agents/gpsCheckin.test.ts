import { describe, it, expect, vi, beforeEach } from "vitest";

// U7 (hallucination hardening 2026-07-17, R12): the family arrival-alert
// briefing must be grounded — it interpolates the senior's real name when one
// is on file (appointment attribution first, senior profile fallback), and
// when no name exists anywhere it explicitly forbids the LLM from inventing
// one ("Do not name the senior — say 'their visit'"). The old briefing said
// "with their loved one" while the voice pushed for names — the Marcus shape.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const adds: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
  });
  const makeCollRef = (path: string) => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    add: async (data: any) => { adds.push({ path, data }); return { id: `auto-${adds.length}` }; },
  });

  return {
    docState, adds,
    collection: vi.fn((name: string) => makeCollRef(name)),
    reset: () => { docState.clear(); adds.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection }) },
  firestore: () => ({ collection: hoisted.collection }),
}));

vi.mock("firebase-functions/v1", () => {
  class HttpsError extends Error {
    constructor(public code: string, msg: string) { super(msg); }
  }
  return { https: { HttpsError, onCall: (f: any) => f } };
});

const sendMessage = vi.fn(async (..._a: unknown[]) => ({ message_id: "m1" }));
vi.mock("../linq/client", () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const generateCaraMessage = vi.fn(async ({ fallback }: any) => fallback);
vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: (...a: unknown[]) => (generateCaraMessage as any)(...a),
}));

import { submitGpsCheckin } from "./gpsCheckin";

const LAT = 37.3352;
const LON = -121.8811;

function seed(opts: { apptSeniorName?: string; profileName?: string } = {}) {
  hoisted.docState.set("appointments/a1", {
    caregiverId: "cg1",
    caregiverName: "Maria",
    clientId: "c1",
    date: "2026-07-20",
    ...(opts.apptSeniorName ? { seniorName: opts.apptSeniorName } : {}),
  });
  hoisted.docState.set("senior_profiles/c1", {
    latitude: LAT,
    longitude: LON,
    ...(opts.profileName ? { name: opts.profileName } : {}),
  });
  hoisted.docState.set("users/c1", { chatId: "chat-fam" });
}

// The firebase-functions/v1 mock returns the raw handler, so we call it directly.
const run = () =>
  (submitGpsCheckin as any)(
    { caregiverId: "cg1", appointmentId: "a1", latitude: LAT, longitude: LON },
    { auth: { uid: "cg1" } },
  );

function briefingContext(): string {
  expect(generateCaraMessage).toHaveBeenCalledTimes(1);
  const args = generateCaraMessage.mock.calls[0][0] as any;
  expect(args.audience).toBe("family");
  return String(args.context);
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
});

describe("submitGpsCheckin — family arrival-alert briefing grounding (U7, R12)", () => {
  it("names the senior from the appointment's own attribution when present", async () => {
    seed({ apptSeniorName: "Rosie", profileName: "SomeoneElse" });
    const res = await run();
    expect(res.validated).toBe(true);

    const context = briefingContext();
    expect(context).toContain("arrived for today's visit with Rosie");
    expect(context).not.toContain("their loved one");
    expect(context).not.toContain("Do not name the senior");
    expect(sendMessage).toHaveBeenCalledWith("chat-fam", expect.any(String));
  });

  it("falls back to the senior profile's name when the appointment carries none", async () => {
    seed({ profileName: "Albert" });
    await run();

    const context = briefingContext();
    expect(context).toContain("arrived for today's visit with Albert");
    expect(context).not.toContain("Do not name the senior");
  });

  it("with no name anywhere, the briefing forbids inventing one", async () => {
    seed();
    await run();

    const context = briefingContext();
    expect(context).toContain("Do not name the senior — say 'their visit'; never invent a name.");
    // No ungrounded name-shaped placeholder left behind.
    expect(context).not.toContain("with their loved one");
    expect(context).not.toContain("visit with ");
  });

  it("whitespace-only names count as absent (no blank-name briefing)", async () => {
    seed({ apptSeniorName: "   ", profileName: "  " });
    await run();

    const context = briefingContext();
    expect(context).toContain("Do not name the senior");
  });
});
