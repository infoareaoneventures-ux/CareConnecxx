import { describe, it, expect, vi, beforeEach } from "vitest";

// A mid-flow question is answered FROM what is on the person's screen (live 2026-10-11: "Is the base correct"
// on a counter recap was answered "I don't have the details of the base… medication dose, mattress/base type").
const hoisted = vi.hoisted(() => ({ quick: vi.fn(async (_s: string, _u: string) => "Yes — $15/hr for 20 minutes 44 seconds is $5.18.") }));
vi.mock("../../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => (hoisted.quick as any)(...a) }));
vi.mock("../../utils/parseWithClaude", () => ({ parseWithClaude: vi.fn(async () => "") }));
vi.mock("../../config/featureFlags", () => ({ caraOutputGuardEnabled: () => false }));

import { answerMidFlow } from "../stepHandler";

const RECAP = ["Your counter — Basra Yousuf", "6:19:16 PM – 6:40:00 PM · 0:20:44", "$15/hr · Base pay $5.18", "mileage +$15.00", "Your total $20.18", "", "Reply SEND to send the counter, or CANCEL."].join("\n");

beforeEach(() => hoisted.quick.mockClear());

describe("answerMidFlow", () => {
  it("briefs the model with the screen text, the audience and the flow's facts, then re-asks", async () => {
    const out = await answerMidFlow("Is the base correct", RECAP, { audience: "caregiver", facts: "Base pay = time × rate." });
    const system = hoisted.quick.mock.calls[0][0] as string;
    expect(system).toContain("Audience: caregiver");
    expect(system).toContain("$15/hr · Base pay $5.18");
    expect(system).toContain("never say you don't have those details");
    expect(system).toContain("Facts: Base pay = time × rate.");
    expect(hoisted.quick.mock.calls[0][1]).toBe("Is the base correct");
    expect(out).toContain("$5.18");
    expect(out).toContain("Reply SEND to send the counter, or CANCEL.");
  });
  it("defaults to the family audience and no facts", async () => {
    await answerMidFlow("what time?", "What day works?");
    const system = hoisted.quick.mock.calls[0][0] as string;
    expect(system).toContain("Audience: family");
    expect(system).toContain("What day works?");
    expect(system).not.toContain("Facts:");
  });
});
