const FORBIDDEN_TELEMETRY_KEYS = new Set([
  "phone",
  "userid",
  "childid",
  "childids",
  "name",
  "question",
  "reply",
  "text",
  "message",
  "prompt",
  "error",
  "stack",
]);

const PHONE_LIKE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

export interface ChildcareTelemetryScanResult {
  safe: boolean;
  violations: string[];
}

/** Runtime/test scanner for persisted child quality and security telemetry. */
export function scanChildcareTelemetryPayload(payload: unknown): ChildcareTelemetryScanResult {
  const violations: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (PHONE_LIKE.test(value)) violations.push(`${path}:phone_like`);
      if (EMAIL_LIKE.test(value)) violations.push(`${path}:email_like`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if (FORBIDDEN_TELEMETRY_KEYS.has(key.toLowerCase())) violations.push(`${next}:forbidden_key`);
      visit(child, next);
    }
  };
  visit(payload, "");
  return { safe: violations.length === 0, violations };
}

export function assertChildcareTelemetryPayloadSafe(payload: unknown): void {
  const result = scanChildcareTelemetryPayload(payload);
  if (!result.safe) {
    throw new Error(`unsafe childcare telemetry: ${result.violations.join(", ")}`);
  }
}
