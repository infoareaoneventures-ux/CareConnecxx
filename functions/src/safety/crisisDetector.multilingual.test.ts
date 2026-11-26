import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/openaiClient", () => ({
  quickComplete: vi.fn(),
}));

import { detectCrisis, classifyEmergency } from "./crisisDetector";
import { quickComplete } from "../utils/openaiClient";

const mockQuickComplete = quickComplete as unknown as ReturnType<typeof vi.fn>;

describe("detectCrisis — Spanish keywords (accent-insensitive)", () => {
  it("detects Spanish medical crisis", () => {
    expect(detectCrisis("no puedo respirar")).toBe("medical");
    expect(detectCrisis("creo que tiene un infarto")).toBe("medical");
  });

  it("detects accented Spanish medical text via diacritic stripping", () => {
    expect(detectCrisis("le dio un ataque al corazón")).toBe("medical");
  });

  it("detects Spanish emotional crisis", () => {
    expect(detectCrisis("me quiero morir")).toBe("emotional");
    expect(detectCrisis("ya no puedo más con esto")).toBe("emotional");
  });

  it("still detects English crisis text (regression)", () => {
    expect(detectCrisis("he has chest pain")).toBe("medical");
    expect(detectCrisis("I want to kill myself")).toBe("emotional");
  });

  it("returns null for benign Spanish", () => {
    expect(detectCrisis("¿cómo cancelo mi cita?")).toBeNull();
    expect(detectCrisis("hola, necesito ayuda con el horario")).toBeNull();
  });
});

describe("classifyEmergency — the reader for everything the keywords miss (any language)", () => {
  beforeEach(() => { mockQuickComplete.mockReset(); });

  it.each([
    ["MEDICAL", { kind: "medical", aboutSelf: false }],
    ["SELF_HARM_ME", { kind: "emotional", aboutSelf: true }],
    ["SELF_HARM_OTHER", { kind: "emotional", aboutSelf: false }],
    ["HELP", { kind: "help", aboutSelf: true }],
    ["NONE", null],
    ["not sure", null],
  ])("maps %s", async (verdict, expected) => {
    mockQuickComplete.mockResolvedValue(verdict);
    expect(await classifyEmergency("some message")).toEqual(expected);
  });

  it("a model outage is not an emergency (the keyword scan is the safety net)", async () => {
    mockQuickComplete.mockRejectedValue(new Error("down"));
    expect(await classifyEmergency("some message")).toBeNull();
  });
});
