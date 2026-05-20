// US Federal Holidays 2024-2030 (fixed dates and computed floating dates)

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const d = new Date(year, month - 1, 1);
  let count = 0;
  while (true) {
    if (d.getDay() === weekday) { count++; if (count === n) break; }
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split("T")[0];
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const d = new Date(year, month, 0); // last day of month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function observedDate(date: Date): string {
  const day = date.getDay();
  if (day === 6) { date.setDate(date.getDate() - 1); } // Sat → Fri
  if (day === 0) { date.setDate(date.getDate() + 1); } // Sun → Mon
  return date.toISOString().split("T")[0];
}

export function getHolidaysForYear(year: number): Holiday[] {
  const fixed = (month: number, day: number, name: string): Holiday => {
    const d = new Date(year, month - 1, day);
    return { date: observedDate(d), name };
  };
  return [
    fixed(1, 1, "New Year's Day"),
    { date: nthWeekdayOfMonth(year, 1, 1, 3), name: "Martin Luther King Jr. Day" },
    { date: nthWeekdayOfMonth(year, 2, 1, 3), name: "Presidents' Day" },
    { date: lastWeekdayOfMonth(year, 5, 1), name: "Memorial Day" },
    fixed(6, 19, "Juneteenth"),
    fixed(7, 4, "Independence Day"),
    { date: nthWeekdayOfMonth(year, 9, 1, 1), name: "Labor Day" },
    { date: nthWeekdayOfMonth(year, 10, 4, 4), name: "Thanksgiving Day" },
    fixed(12, 25, "Christmas Day"),
  ];
}

const holidayCache = new Map<string, Set<string>>();

export function isUSFederalHoliday(date: string): boolean {
  const year = parseInt(date.split("-")[0], 10);
  if (!holidayCache.has(String(year))) {
    const holidays = getHolidaysForYear(year);
    holidayCache.set(String(year), new Set(holidays.map(h => h.date)));
  }
  return holidayCache.get(String(year))!.has(date);
}

export function getHolidayName(date: string): string | null {
  const year = parseInt(date.split("-")[0], 10);
  const holidays = getHolidaysForYear(year);
  return holidays.find(h => h.date === date)?.name ?? null;
}
