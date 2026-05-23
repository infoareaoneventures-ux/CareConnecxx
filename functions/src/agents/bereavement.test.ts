import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: {
    firestore: () => ({ collection: () => ({}) }),
  },
  firestore: () => ({ collection: () => ({}) }),
}));

const quickComplete = vi.fn();
vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
}));

vi.mock("../linq/client", () => ({ sendMessage: vi.fn() }));
vi.mock("./careMemory", () => ({ generateCareMemoryKeepsake: vi.fn() }));
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn() }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn() }));

import { isBereavementTrigger } from "./bereavement";

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
