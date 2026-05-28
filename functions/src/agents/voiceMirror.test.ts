import { describe, it, expect } from "vitest";
import { computeVoiceProfile, buildVoiceDirective } from "./voiceMirror";

// Helper — build a history with N user messages of a given style.
const userMsgs = (texts: string[]) =>
  texts.map((content) => ({ role: "user", content }));

const mixed = (userTexts: string[]) => {
  // Realistic shape — alternate user + assistant. Only user messages matter to
  // the profile, but interleaving them surfaces accidental "assistant" picks.
  const out: Array<{ role: string; content: string }> = [];
  for (const t of userTexts) {
    out.push({ role: "user", content: t });
    out.push({ role: "assistant", content: "Got it." });
  }
  return out;
};

describe("computeVoiceProfile", () => {
  it("returns null when the sample is too small (<3 user messages)", () => {
    expect(computeVoiceProfile(userMsgs(["hi"]))).toBeNull();
    expect(computeVoiceProfile(userMsgs(["hi", "thanks"]))).toBeNull();
  });

  it("ignores [SYSTEM] summary-injection messages", () => {
    // The conversation history loader injects a faked-user message starting
    // with [SYSTEM] when there's a rollup summary. That message is Cara's
    // own context, not the family's voice — voiceMirror must skip it.
    const out = computeVoiceProfile([
      { role: "user", content: "[SYSTEM]\nEarlier they discussed cardiology." },
      { role: "user", content: "ok" },
      { role: "user", content: "k" },
    ]);
    // Only 2 real user messages — below MIN_SAMPLE, should return null.
    expect(out).toBeNull();
  });

  it("detects short / casual texters", () => {
    const profile = computeVoiceProfile(mixed([
      "hey",
      "k thx",
      "yeah ok",
      "sure",
      "lol nope",
    ]))!;
    expect(profile.sampleSize).toBe(5);
    expect(profile.avgLength).toBeLessThan(15);
    expect(profile.formalityScore).toBeLessThan(0.5);
    expect(profile.emojiRate).toBe(0);
    expect(profile.languagePref).toBe("en");
  });

  it("detects long / formal writers", () => {
    const profile = computeVoiceProfile(mixed([
      "Good morning. I would like to confirm Thursday's appointment please.",
      "Hello, could you please let me know what time Maria will arrive tomorrow morning. Thank you.",
      "Thank you for your help last week. Could you check whether the medication has been updated as requested.",
      "Good afternoon. Please confirm that the care plan reflects the new dietary restrictions we discussed.",
    ]))!;
    expect(profile.avgLength).toBeGreaterThan(60);
    expect(profile.formalityScore).toBeGreaterThan(0.65);
    expect(profile.emojiRate).toBe(0);
  });

  it("detects emoji users", () => {
    const profile = computeVoiceProfile(mixed([
      "thanks so much 💙",
      "love it 😊",
      "see you tomorrow 🙏",
      "mom is doing great today 💕",
    ]))!;
    expect(profile.emojiRate).toBeGreaterThanOrEqual(1);
  });

  it("detects Spanish-speaking families", () => {
    const profile = computeVoiceProfile(mixed([
      "Hola Cara, necesito ayuda con la cita de mamá mañana.",
      "Gracias, ¿puedes confirmar la hora por favor?",
      "Sí, mamá está bien hoy, gracias.",
      "Buenos días, necesito cambiar la cita del doctor.",
    ]))!;
    expect(profile.languagePref).toBe("es");
  });

  it("detects mixed-language usage", () => {
    const profile = computeVoiceProfile(mixed([
      "Hola, can you check on mom's appointment?",
      "thanks!",
      "Necesito ayuda por favor",
      "ok sounds good",
    ]))!;
    expect(profile.languagePref).toBe("mixed");
  });

  it("caps the sample at the most recent MAX_SAMPLE messages", () => {
    // If old messages dominated, profile would reflect history rather than
    // current register. Verify that only the most recent ~12 are sampled.
    const old = Array.from({ length: 50 }, () => "Good morning. This is a long, formal message about the appointment please.");
    const recent = Array.from({ length: 12 }, () => "k thx");
    const profile = computeVoiceProfile(userMsgs([...old, ...recent]))!;
    expect(profile.sampleSize).toBe(12);
    expect(profile.avgLength).toBeLessThan(15); // dominated by recent short messages
    expect(profile.formalityScore).toBeLessThan(0.5);
  });
});

describe("buildVoiceDirective", () => {
  it("returns empty string for null profile", () => {
    expect(buildVoiceDirective(null)).toBe("");
  });

  it("wraps output in <voice_mirror> for downstream prompt anchoring", () => {
    const profile = computeVoiceProfile(mixed([
      "hey", "k", "yeah ok", "sure thx",
    ]))!;
    const dir = buildVoiceDirective(profile);
    expect(dir).toMatch(/^<voice_mirror>/);
    expect(dir).toMatch(/<\/voice_mirror>$/);
  });

  it("emits Spanish directive when family writes Spanish", () => {
    const profile = computeVoiceProfile(mixed([
      "Hola, necesito ayuda con la cita de mamá.",
      "Gracias por favor",
      "Sí, está bien hoy",
      "Buenos días, doctora",
    ]))!;
    const dir = buildVoiceDirective(profile);
    expect(dir).toMatch(/Spanish/);
    expect(dir).toMatch(/respond in/i);
  });

  it("emits emoji-encouraging directive when family uses emoji", () => {
    const profile = computeVoiceProfile(mixed([
      "thanks 💙",
      "great 😊",
      "love it 🙏",
      "amazing 💕",
    ]))!;
    const dir = buildVoiceDirective(profile);
    expect(dir).toMatch(/emoji/i);
    expect(dir).not.toMatch(/don't lead with/i);
  });

  it("emits no-emoji directive when family never uses them", () => {
    const profile = computeVoiceProfile(mixed([
      "hi", "thanks", "see you tomorrow", "ok",
    ]))!;
    const dir = buildVoiceDirective(profile);
    expect(dir).toMatch(/don't lead with/i);
  });

  it("emits short-reply directive for terse texters", () => {
    const profile = computeVoiceProfile(mixed([
      "hey", "k", "yeah", "sure", "ok",
    ]))!;
    const dir = buildVoiceDirective(profile);
    expect(dir).toMatch(/short/i);
  });

  it("emits longer-reply guidance for verbose writers", () => {
    const profile = computeVoiceProfile(mixed([
      "Good morning Cara. I wanted to ask about Mom's medication schedule. We're trying to figure out the new dosing.",
      "Could you please check whether Maria has updated the care notes from last Tuesday's visit. Thanks.",
      "Hello, would you mind confirming the appointment time for Thursday and letting me know if anything has changed.",
      "Thank you for all your help. I'd like to discuss the care plan in more detail when you have a moment.",
    ]))!;
    const dir = buildVoiceDirective(profile);
    expect(dir).toMatch(/longer/);
  });
});
