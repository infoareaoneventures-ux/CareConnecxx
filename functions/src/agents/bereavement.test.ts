import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-admin", () => {
  // Chainable no-op Firestore: queries come back empty, doc reads miss, and
  // writes resolve — enough for activateBereavementMode's side-channel work.
  const makeQuery = (): any => ({
    where: () => makeQuery(),
    get:   async () => ({ empty: true, docs: [] }),
  });
  const collection = () => ({
    ...makeQuery(),
    doc: () => ({
      update: async () => {},
      get:    async () => ({ exists: false, data: () => undefined }),
    }),
  });
  const firestore = () => ({ collection, batch: () => ({ update: () => {}, commit: async () => {} }) });
  return { __esModule: true, default: { firestore }, firestore };
});

const quickComplete = vi.fn();
vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
}));

vi.mock("../linq/client", () => ({ sendMessage: vi.fn() }));
vi.mock("./careMemory", () => ({ generateCareMemoryKeepsake: vi.fn() }));
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn() }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn() }));

import { isBereavementTrigger, activateBereavementMode } from "./bereavement";
import { generateCaraMessage } from "../utils/caraMessage";
import { generateCareMemoryKeepsake } from "./careMemory";
import { logAudit } from "../observability/auditLog";

describe("isBereavementTrigger", () => {
  beforeEach(() => {
    quickComplete.mockReset();
  });

  it("returns false for bare 'Yes' without calling the LLM (regression: false condolence after a confirmation)", async () => {
    quickComplete.mockResolvedValue("YES"); // even if the LLM would echo, we must not call it
    const result = await isBereavementTrigger("Yes");
    expect(result).toBe(false);
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it.each(["yes", "no", "ok", "okay", "sure", "thanks", "yep", "y", "n", "hi"])(
    "returns false for trivial ack %p without calling the LLM",
    async (ack) => {
      quickComplete.mockResolvedValue("YES");
      expect(await isBereavementTrigger(ack)).toBe(false);
      expect(quickComplete).not.toHaveBeenCalled();
    },
  );

  it("returns false for short non-ack messages without calling the LLM", async () => {
    quickComplete.mockResolvedValue("YES");
    expect(await isBereavementTrigger("hello!")).toBe(false);
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("returns true on obvious keyword without calling the LLM", async () => {
    const result = await isBereavementTrigger("My mom passed away last night.");
    expect(result).toBe(true);
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("delegates to the LLM for ambiguous longer messages", async () => {
    quickComplete.mockResolvedValue("YES");
    const result = await isBereavementTrigger("We lost her this morning, the family is devastated.");
    expect(result).toBe(true);
    expect(quickComplete).toHaveBeenCalledOnce();
  });

  it("returns false when the LLM says NO", async () => {
    quickComplete.mockResolvedValue("NO");
    const result = await isBereavementTrigger("Can you reschedule the visit for tomorrow?");
    expect(result).toBe(false);
    expect(quickComplete).toHaveBeenCalledOnce();
  });

  it("returns false if the LLM call throws", async () => {
    quickComplete.mockRejectedValue(new Error("network"));
    const result = await isBereavementTrigger("Can you reschedule the visit for tomorrow?");
    expect(result).toBe(false);
  });
});

// U8 (hallucination hardening 2026-07-17, R11) — representative behavior test
// for the bereavement group: the grief-sensitive briefings interpolate the
// senior's name, so each carries a MINIMAL inline attribution line ("the care
// recipient was {name}") — full describeWhoIsWho copy would be too heavy here.
describe("activateBereavementMode — minimal who-is-who attribution (R11)", () => {
  beforeEach(() => {
    vi.mocked(generateCaraMessage).mockReset();
    vi.mocked(generateCaraMessage).mockImplementation(async (opts: any) => opts.fallback);
    // Keep the keepsake promise pending so the async .then() branch stays out
    // of this test (its contexts are pinned by the source-scan suite).
    vi.mocked(generateCareMemoryKeepsake).mockReturnValue(new Promise<string>(() => {}) as any);
    vi.mocked(logAudit).mockResolvedValue(undefined as any);
  });

  it("condolence briefing context attributes the passing to the care recipient, not the reader", async () => {
    await activateBereavementMode("user1", "chat1", "+15550001111", "Rosie");

    const calls = vi.mocked(generateCaraMessage).mock.calls.map((c) => c[0] as any);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const condolence = calls[0];
    expect(condolence.audience).toBe("family");
    expect(condolence.context).toContain("the care recipient was Rosie");
    // The attribution rides in the SAME context that interpolates the name.
    expect(condolence.context).toContain("Rosie has passed away");
  });
});
