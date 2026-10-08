// Console-level redaction for function logs (2026-10-07). Phone numbers (E.164 and US
// 10-digit forms) and email addresses are masked in every console.log/info/warn/error
// argument — strings and plain objects alike — so a log line like
//   cara.turn { phone: '+14087261330', … }
// reads  { phone: '+1•••••••1330' }. Installed once from index.ts. Keeps the last 4
// digits so a line can still be matched to a person by someone who already knows them.
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
const E164 = /\+\d{10,15}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactText(s: string): string {
  if (!s) return s;
  return s
    .replace(E164, (m) => `${m.slice(0, 2)}${"•".repeat(Math.max(0, m.length - 6))}${m.slice(-4)}`)
    .replace(PHONE, (_m, _a, _b, last4) => `•••-•••-${last4}`)
    .replace(EMAIL, (m) => {
      const [user, domain] = m.split("@");
      return `${user.slice(0, 2)}***@${domain}`;
    });
}

export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactText(v);
  if (v == null || typeof v !== "object" || depth > 4) return v;
  if (v instanceof Error) return v; // keep stacks intact (stack text rarely carries PII; message is below)
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(val, depth + 1);
  return out;
}

let installed = false;
export function installLogRedaction(): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => orig(...args.map((a) => redactValue(a)));
  }
}
