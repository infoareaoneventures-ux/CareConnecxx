import { describe, expect, it } from "vitest";
import { detectFrustrationSignals, normalize } from "./frustrationSignals";

describe("frustrationSignals", () => {
  it("normalizes punctuation and casing without keeping formatting noise", () => {
    expect(normalize("Hey, Cara!!")).toBe("hey cara");
  });

  it("flags explicit frustration and missing-link complaints", () => {
    expect(detectFrustrationSignals({ text: "Cara still didn't send the link" })).toMatchObject({
      frustrationDetected: true,
    });
    expect(detectFrustrationSignals({ text: "this is horrible, I need a real person" })).toMatchObject({
      frustrationDetected: true,
    });
  });

  it("flags repeated greeting loops without treating a first greeting as frustrated", () => {
    expect(detectFrustrationSignals({ text: "Hey cara" })).toEqual({
      frustrationDetected: false,
      rephraseLoopDetected: false,
      repeatedGreetingDetected: false,
    });

    expect(detectFrustrationSignals({
      text: "Hey cara",
      recentHistory: [
        { role: "user", content: "hey cara" },
        { role: "assistant", content: "I am checking that now." },
      ],
    })).toMatchObject({
      repeatedGreetingDetected: true,
    });
  });

  it("flags repeated or closely rephrased requests", () => {
    expect(detectFrustrationSignals({
      text: "can you please send me the setup link for my mom",
      recentHistory: [
        { role: "user", content: "please send the setup link for my mom" },
        { role: "assistant", content: "I am checking that now." },
      ],
    })).toMatchObject({
      rephraseLoopDetected: true,
    });
  });

  it("does not flag ordinary short replies", () => {
    expect(detectFrustrationSignals({
      text: "yes",
      recentHistory: [{ role: "user", content: "no" }],
    })).toEqual({
      frustrationDetected: false,
      rephraseLoopDetected: false,
      repeatedGreetingDetected: false,
    });
  });
});
