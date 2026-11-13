// Exact hours in a family's text → the day-parts Evia stores (2026-11-14, fix plan: live text test).
// The site's care-plan step keeps a day-part (morning / afternoon / evening / overnight), not clock times, so
// "Saturdays 9am to 1pm" used to land as just "morning" and the afternoon hour was lost. A stated clock range now
// maps to every day-part it touches, and the reply says exact hours are chosen when booking.
// A written range like "9am to 1pm" is arithmetic, not intent, so it is read here and not by the model.

const PARTS: Array<{ name: "morning" | "afternoon" | "evening" | "overnight"; from: number; to: number }> = [
  { name: "morning", from: 5, to: 12 },
  { name: "afternoon", from: 12, to: 17 },
  { name: "evening", from: 17, to: 21 },
];

function to24(hour: number, meridiem: string | undefined): number | null {
  if (hour < 1 || hour > 12) return meridiem ? null : (hour >= 0 && hour <= 23 ? hour : null);
  if (!meridiem) return hour;
  const pm = meridiem.toLowerCase() === "pm";
  return pm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
}

/** "9am to 1pm", "9-1pm", "from 10 to 2 pm", "9:00 AM – 1:00 PM" → ["morning", "afternoon"]. Empty when no clock range is stated. */
export function timeOfDayFromClock(text: string): string[] {
  const m = String(text ?? "").match(/(\d{1,2})(?::\d{2})?\s*(am|pm)?\s*(?:to|-|–|—|until|till)\s*(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i);
  if (!m) return [];
  const endMer = m[4];
  let startMer = m[2];
  const startNum = Number(m[1]);
  const endNum = Number(m[3]);
  // "9-1pm": the start has no am/pm; it is the one that makes a forward range (9am, not 9pm).
  if (!startMer) startMer = startNum > endNum && endMer.toLowerCase() === "pm" ? "am" : endMer;
  const start = to24(startNum, startMer);
  let end = to24(endNum, endMer);
  if (start === null || end === null) return [];
  if (end <= start) end += 24; // runs past midnight
  const out: string[] = [];
  const overlap = (a: number, b: number) => {
    for (const shift of [0, 24]) { if (Math.min(end, b + shift) - Math.max(start, a + shift) >= 1) return true; }
    return false;
  };
  for (const part of PARTS) if (overlap(part.from, part.to)) out.push(part.name);
  if (overlap(21, 29)) out.push("overnight"); // 9pm to 5am
  return out;
}

/** The note added to the reply when exact hours were turned into day-parts. */
export const CLOCK_TIMES_NOTE = "I note the time of day for now — you'll set the exact hours when you book.";
