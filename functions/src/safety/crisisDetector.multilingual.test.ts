import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/openaiClient", () => ({
  quickComplete: vi.fn(),
}));

import { detectCrisis, classifyCrisisMultilingual } from "./crisisDetector";
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

describe("classifyCrisisMultilingual — no-keyword LLM gate", () => {
  beforeEach(() => mockQuickComplete.mockReset());

  it("maps MEDICAL → medical", async () => {
    mockQuickComplete.mockResolvedValue("MEDICAL");
    expect(await classifyCrisisMultilingual("se está poniendo morado")).toBe("medical");
  });

  it("maps EMOTIONAL → emotional", async () => {
    mockQuickComplete.mockResolvedValue("EMOTIONAL");
    expect(await classifyCrisisMultilingual("siento que ya no vale la pena")).toBe("emotional");
  });

  it("maps NONE → null", async () => {
    mockQuickComplete.mockResolvedValue("NONE");
    expect(await classifyCrisisMultilingual("¿cómo cancelo mi cita?")).toBeNull();
  });

  it("returns null (not a crisis) when the classifier errors — keyword net stays primary", async () => {
    mockQuickComplete.mockRejectedValueOnce(new Error("llm down"));
    expect(await classifyCrisisMultilingual("cualquier cosa")).toBeNull();
  });
});
