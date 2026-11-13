// Interview times offered for a date, from the care provider's own weekly availability (2026-11-11, fix plan Wave 3:
// the request form offered every half hour from 9 to 6 whatever the care provider's availability). A care provider
// with no availability set is offered the full day, as before. Availability is given per day as the blocks the care
// provider works (morning 6–12, afternoon 12–6, evening 6–11), as produced by services/availabilityService.weeklySlotsToBl.
const DAY_IDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const ALL_INTERVIEW_SLOTS: string[] = (() => {
  const out: string[] = [];
  for (let h = 9; h <= 18; h++) { out.push(`${String(h).padStart(2, '0')}:00`); if (h < 18) out.push(`${String(h).padStart(2, '0')}:30`); }
  return out;
})();

function blockOf(slot: string): 'morning' | 'afternoon' | 'evening' {
  const h = parseInt(slot.slice(0, 2), 10);
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

export function interviewSlotsFor(
  dateStr: string,
  weeklyBlocks: Record<string, string[]> | null | undefined,
): { slots: string[]; filtered: boolean; availableThatDay: boolean } {
  const hasAny = !!weeklyBlocks && Object.values(weeklyBlocks).some((b) => b && b.length > 0);
  if (!hasAny || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { slots: ALL_INTERVIEW_SLOTS, filtered: false, availableThatDay: true };
  const day = DAY_IDS[new Date(`${dateStr}T12:00:00`).getDay()];
  const blocks = new Set((weeklyBlocks![day] ?? []).map((b) => String(b).toLowerCase()));
  const slots = ALL_INTERVIEW_SLOTS.filter((s) => blocks.has(blockOf(s)));
  return { slots, filtered: true, availableThatDay: slots.length > 0 };
}
