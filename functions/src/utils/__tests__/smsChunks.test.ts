import { describe, it, expect } from "vitest";
import { splitForSms, curlyQuotes } from "../smsChunks";

const services = [
  "Perfect, Saturdays and Sundays, mornings from 9 to 1, got it. Next, what services do you offer? Pick as many as apply:",
  "Senior care:", "Mobility Assistance", "Dementia / Memory Care", "Medication Reminders Only", "Personal Care", "Companionship",
  "Transportation", "Meal Preparation", "Light Housekeeping", "Child care:", "Supervision", "Baby Care", "Bathing & Dressing",
  "Meals & Snacks", "Activities & Play", "School & Homework", "Transportation", "Tidying & Laundry",
].join("\n");

describe("splitForSms", () => {
  it("a short text is one bubble, unchanged", () => {
    expect(splitForSms("Hello there")).toEqual(["Hello there"]);
    expect(splitForSms("")).toEqual([]);
  });
  it("the long services list splits at line breaks, never inside a word, and keeps every word in order", () => {
    const parts = splitForSms(services, 250);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(250);
    expect(parts.join("\n")).toBe(services);
    expect(parts.some((p) => p.endsWith("Supervis"))).toBe(false);
    expect(parts[0]).toContain("Pick as many as apply:");
  });
  it("prefers a sentence end over a space and a paragraph break over a sentence end", () => {
    const text = "First paragraph sentence one. Second sentence of it that goes on for a while to fill the space. ".repeat(3) + "\n\n" + "Another paragraph that is fairly long and keeps going. ".repeat(6);
    const parts = splitForSms(text, 300);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });
  it("an unbroken run longer than the limit is the only thing that is cut", () => {
    const parts = splitForSms("x".repeat(1000), 420);
    expect(parts.map((p) => p.length)).toEqual([420, 420, 160]);
  });
});

describe("curlyQuotes", () => {
  it("straight quoted phrases become curly, everything else is untouched", () => {
    expect(curlyQuotes('text me "show my jobs" any time')).toBe("text me \u201Cshow my jobs\u201D any time");
    expect(curlyQuotes('"Friendly dog, quiet street."')).toBe("\u201CFriendly dog, quiet street.\u201D");
    expect(curlyQuotes("no quotes here")).toBe("no quotes here");
    expect(curlyQuotes('a lone " quote')).toBe('a lone " quote');
  });
});
