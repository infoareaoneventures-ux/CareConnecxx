import { describe, it, expect, vi, beforeEach } from "vitest";

const quickComplete = vi.fn();
vi.mock("../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("./caraAgent", () => ({ sendViaInteractionAgent: vi.fn(async () => {}) }));
vi.mock("../triggers/userTriggerManager", () => ({
  createUserTrigger: vi.fn(async () => {}),
  listUserTriggers: vi.fn(async () => []),
  deleteUserTrigger: vi.fn(async () => {}),
}));

import { classifyTriggerAction, resolveCancelTarget } from "./schedulingHandler";

const trig = (id: string, label: string) => ({ id, label }) as any;

beforeEach(() => quickComplete.mockReset());

describe("classifyTriggerAction", () => {
  it("maps the LLM verdict to an action", async () => {
    quickComplete.mockResolvedValueOnce("LIST");
    expect(await classifyTriggerAction("show my reminders")).toBe("list");
    quickComplete.mockResolvedValueOnce("CANCEL");
    expect(await classifyTriggerAction("stop the med reminder")).toBe("cancel");
    quickComplete.mockResolvedValueOnce("CREATE");
    expect(await classifyTriggerAction("remind me Mondays at 9")).toBe("create");
    quickComplete.mockResolvedValueOnce("QUESTION");
    expect(await classifyTriggerAction("how do reminders work?")).toBe("question");
  });

  it("does not misroute negation to cancel (LLM-driven, not keyword .includes)", async () => {
    quickComplete.mockResolvedValueOnce("CREATE");
    // The word "cancel" is present but the intent is not to cancel.
    expect(await classifyTriggerAction("please don't cancel anything")).not.toBe("cancel");
  });

  it("defaults to create when the LLM errors", async () => {
    quickComplete.mockRejectedValueOnce(new Error("down"));
    expect(await classifyTriggerAction("something")).toBe("create");
  });
});

describe("resolveCancelTarget", () => {
  it("returns null when there are no triggers", async () => {
    expect(await resolveCancelTarget("cancel it", [])).toBeNull();
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("returns the sole trigger without an LLM call", async () => {
    const t = trig("a", "medications");
    expect(await resolveCancelTarget("cancel that", [t])).toBe(t);
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("picks the LLM-selected index among several", async () => {
    const ts = [trig("a", "medications"), trig("b", "physical therapy")];
    quickComplete.mockResolvedValueOnce("1");
    expect(await resolveCancelTarget("cancel the PT one", ts)).toBe(ts[1]);
  });

  it("returns null when the LLM is unsure", async () => {
    const ts = [trig("a", "meds"), trig("b", "PT")];
    quickComplete.mockResolvedValueOnce("NONE");
    expect(await resolveCancelTarget("cancel something", ts)).toBeNull();
  });
});
