import { describe, it, expect, vi, beforeEach } from "vitest";

const quickComplete = vi.fn();
vi.mock("./openaiClient", () => ({
  quickComplete: (...args: unknown[]) => quickComplete(...args),
}));

import { detectLanguage, languageFromSession, t as tr, flowLabel } from "./language";

describe("detectLanguage", () => {
  beforeEach(() => quickComplete.mockReset());

  it("returns null for very short text without calling LLM", async () => {
    expect(await detectLanguage("hi")).toBeNull();
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("detects Spanish via heuristic (special chars) without LLM", async () => {
    expect(await detectLanguage("¿Puedes ayudarme con mi abuela?")).toBe("es");
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("detects Spanish via heuristic (common words) without LLM", async () => {
    expect(await detectLanguage("Necesito un cuidador para mi mamá")).toBe("es");
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("detects English via heuristic without LLM", async () => {
    expect(await detectLanguage("I need a caregiver for my mom")).toBe("en");
    expect(quickComplete).not.toHaveBeenCalled();
  });

  it("falls back to LLM when heuristics are ambiguous", async () => {
    quickComplete.mockResolvedValue("es");
    // No clear heuristic markers — should call LLM
    const result = await detectLanguage("test xyzzy frobnicate");
    expect(result).toBe("es");
    expect(quickComplete).toHaveBeenCalled();
  });

  it("returns null when LLM says 'other'", async () => {
    quickComplete.mockResolvedValue("other");
    const result = await detectLanguage("xyzzy abcdef qwerty");
    expect(result).toBeNull();
  });

  it("returns null when LLM output is unrecognized (treated as 'other')", async () => {
    quickComplete.mockResolvedValue("fr");
    const result = await detectLanguage("xyzzy abcdef qwerty");
    expect(result).toBeNull();
  });
});

describe("languageFromSession", () => {
  it("defaults to en", () => {
    expect(languageFromSession({})).toBe("en");
    expect(languageFromSession(null)).toBe("en");
    expect(languageFromSession(undefined)).toBe("en");
  });

  it("returns 'es' when preferredLanguage is 'es'", () => {
    expect(languageFromSession({ preferredLanguage: "es" })).toBe("es");
  });

  it("falls back to 'en' for unknown languages", () => {
    expect(languageFromSession({ preferredLanguage: "fr" })).toBe("en");
  });
});

describe("t (message bank)", () => {
  it("produces English by default", () => {
    expect(tr.crisis_medical("en")).toContain("911");
    expect(tr.welcome_back("en")).toMatch(/welcome back/i);
  });

  it("produces Spanish when lang='es'", () => {
    expect(tr.crisis_medical("es")).toContain("911");
    expect(tr.crisis_medical("es")).toContain("emergencia");
    expect(tr.welcome_back("es")).toContain("Bienvenido");
  });

  it("formats OTP greeting with the code", () => {
    expect(tr.otp_greeting("123-456", "en")).toContain("123-456");
    expect(tr.otp_greeting("123-456", "es")).toContain("123-456");
  });

  it("handles singular/plural for attempts left", () => {
    expect(tr.otp_wrong(1, "en")).toMatch(/1 try/);
    expect(tr.otp_wrong(3, "en")).toMatch(/3 tries/);
    expect(tr.otp_wrong(1, "es")).toMatch(/1 intento\b/);
    expect(tr.otp_wrong(3, "es")).toMatch(/3 intentos/);
  });
});

describe("flowLabel", () => {
  it("returns localized flow names", () => {
    expect(flowLabel("refund", "en")).toBe("requesting a refund");
    expect(flowLabel("refund", "es")).toBe("solicitar un reembolso");
    expect(flowLabel("job_posting", "es")).toBe("publicar un trabajo");
  });

  it("returns the key when unknown", () => {
    expect(flowLabel("unknown_flow", "en")).toBe("unknown_flow");
  });
});
