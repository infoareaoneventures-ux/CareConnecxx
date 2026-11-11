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

// Fields that hold what a person WROTE (2026-11-11, fix plan Wave 4: "snippets of messages are written to the server
// logs"): logged as a length only. The phone/email masking above never covered the words themselves.
const TEXT_FIELDS = new Set([
  "text", "message", "body", "content", "textpreview", "crisistext", "snippet", "usertext", "inboundtext",
  "originaltext", "lasttext", "newmessage", "prompt",
]);

export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactText(v);
  if (v == null || typeof v !== "object" || depth > 4) return v;
  if (v instanceof Error) {
    // An Error's message can carry a number or an address ("send failed for +1555…"): mask it, keep the stack.
    const masked = redactText(v.message);
    if (masked === v.message) return v;
    const copy = new Error(masked);
    copy.name = v.name;
    copy.stack = v.stack ? redactText(v.stack) : v.stack;
    return copy;
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // Dates, Buffers, Firestore refs… untouched
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof val === "string" && TEXT_FIELDS.has(k.toLowerCase()) ? `[${val.length} chars]` : redactValue(val, depth + 1);
  }
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
