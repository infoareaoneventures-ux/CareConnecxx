import * as admin from "firebase-admin";

export const CHILDCARE_OPERATOR_AUDIT_SCHEMA_VERSION = "childcare-operator-audit-v1";
export const CHILDCARE_OPERATOR_AUDIT_RETENTION_MS = 6 * 365 * 24 * 60 * 60 * 1000;

const SAFE_TOKEN = /^[a-z0-9_.:-]{1,256}$/i;
const ALLOWED_DETAIL_KEYS = new Set([
  "fromState",
  "redactionVersion",
  "sourceVersion",
  "stateVersion",
  "toState",
]);

export interface ChildcareOperatorAuditInput {
  eventType: "childcare_review_moderated";
  actorUid: string;
  objectRef: string;
  reasonCode: string;
  details: Record<string, unknown>;
  now?: Date;
  legalHold?: boolean;
}

function requireSafeToken(value: string, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!SAFE_TOKEN.test(normalized)) {
    throw new Error(`invalid childcare operator audit ${field}`);
  }
  return normalized;
}

function normalizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) {
      throw new Error(`invalid childcare operator audit detail: ${key}`);
    }
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      output[key] = value;
    } else if (typeof value === "string" && SAFE_TOKEN.test(value)) {
      output[key] = value;
    } else if (value !== null) {
      throw new Error(`invalid childcare operator audit detail value: ${key}`);
    }
  }
  return output;
}

export function buildChildcareOperatorAuditRecord(
  input: ChildcareOperatorAuditInput,
): Record<string, unknown> {
  const now = input.now ?? new Date();
  const legalHold = input.legalHold === true;
  return {
    schemaVersion: CHILDCARE_OPERATOR_AUDIT_SCHEMA_VERSION,
    careVertical: "child",
    eventType: input.eventType,
    userId: requireSafeToken(input.actorUid, "actor"),
    data: {
      objectRef: requireSafeToken(input.objectRef, "object"),
      reasonCode: requireSafeToken(input.reasonCode, "reason"),
      ...normalizeDetails(input.details),
    },
    timestamp: now.toISOString(),
    retentionClass: legalHold ? "legal_hold" : "security_six_year",
    legalHold,
    ttl: legalHold
      ? null
      : admin.firestore.Timestamp.fromMillis(
        now.getTime() + CHILDCARE_OPERATOR_AUDIT_RETENTION_MS,
      ),
  };
}
