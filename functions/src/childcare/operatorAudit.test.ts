import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore: any = () => ({});
  firestore.Timestamp = { fromMillis: (millis: number) => ({ millis }) };
  return {
    __esModule: true,
    default: { firestore, apps: [{}] },
    firestore,
    apps: [{}],
  };
});

import {
  CHILDCARE_OPERATOR_AUDIT_RETENTION_MS,
  buildChildcareOperatorAuditRecord,
} from "./operatorAudit";

const NOW = new Date("2026-07-25T01:00:00.000Z");

describe("childcare operator audit contract", () => {
  it("records structured actor, object, reason, transition, and six-year retention", () => {
    expect(buildChildcareOperatorAuditRecord({
      eventType: "childcare_review_moderated",
      actorUid: "operator-1",
      objectRef: "crev_review1",
      reasonCode: "approve_safe",
      details: {
        fromState: "pending",
        toState: "published",
        sourceVersion: 1,
        stateVersion: 2,
        redactionVersion: "operator-redaction-v1",
      },
      now: NOW,
    })).toMatchObject({
      eventType: "childcare_review_moderated",
      userId: "operator-1",
      data: {
        objectRef: "crev_review1",
        reasonCode: "approve_safe",
        fromState: "pending",
        toState: "published",
      },
      legalHold: false,
      retentionClass: "security_six_year",
      ttl: { millis: NOW.getTime() + CHILDCARE_OPERATOR_AUDIT_RETENTION_MS },
    });
  });

  it("preserves legal-hold records by omitting expiration", () => {
    expect(buildChildcareOperatorAuditRecord({
      eventType: "childcare_review_moderated",
      actorUid: "operator-1",
      objectRef: "crev_review1",
      reasonCode: "unpublish_policy",
      details: { fromState: "published", toState: "unpublished" },
      now: NOW,
      legalHold: true,
    })).toMatchObject({
      legalHold: true,
      retentionClass: "legal_hold",
      ttl: null,
    });
  });

  it.each([
    [{ childName: "Mia" }, /detail/],
    [{ toState: "free form child context" }, /detail value/],
  ])("rejects unapproved or free-form detail: %j", (details, error) => {
    expect(() => buildChildcareOperatorAuditRecord({
      eventType: "childcare_review_moderated",
      actorUid: "operator-1",
      objectRef: "crev_review1",
      reasonCode: "approve_safe",
      details,
      now: NOW,
    })).toThrow(error);
  });

  it("rejects free-form reasons and non-opaque object references", () => {
    expect(() => buildChildcareOperatorAuditRecord({
      eventType: "childcare_review_moderated",
      actorUid: "operator-1",
      objectRef: "review for Mia",
      reasonCode: "because this contains details",
      details: {},
      now: NOW,
    })).toThrow(/object/);
  });
});
