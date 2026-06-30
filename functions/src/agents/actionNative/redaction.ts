const SENSITIVE_FIELD_PATTERN =
  /^(authorization|cookie|api[_-]?key|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|bearer|stripe[_-]?secret|checkr[_-]?key)$/i;

export function redactSensitiveFields(value: unknown): unknown {
  return redactWalk(value, new WeakSet<object>());
}

function redactWalk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map(item => redactWalk(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_FIELD_PATTERN.test(key) ? "[REDACTED]" : redactWalk(child, seen);
  }
  return out;
}

export function safePreview(value: unknown, maxChars = 800): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(redactSensitiveFields(value));
  } catch {
    rendered = String(value);
  }
  return rendered.length > maxChars ? `${rendered.slice(0, maxChars)}...` : rendered;
}
