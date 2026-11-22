// True when two phone numbers are the same line, whatever the formatting ("+1 (505) 528-1528" vs "5055281528").
const lastTen = (p?: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);

export function samePhone(a?: string | null, b?: string | null): boolean {
  const x = lastTen(a);
  const y = lastTen(b);
  return x.length === 10 && x === y;
}
