import { describe, it, expect } from "vitest";
import {
  ACTIVITY_FEED_EVENTS,
  describeForFeed,
  looksLikePhone,
  ownerResolutionPlan,
} from "./activityFeedMap";
import type { AuditEventType } from "../observability/auditLog";

describe("activity feed allow-list (security-critical)", () => {
  it("projects allow-listed family events with a static description", () => {
    expect(describeForFeed("message_sent")).toMatch(/Evia/);
    expect(describeForFeed("booking_created")).toMatch(/Evia/);
    expect(describeForFeed("caregiver_matched")).toMatch(/Evia/);
  });

  it("EXCLUDES sensitive / clinical events", () => {
    expect(describeForFeed("crisis_detected")).toBeNull();
    expect(describeForFeed("health_data_accessed")).toBeNull();
    expect(describeForFeed("safety_violation")).toBeNull();
  });

  it("EXCLUDES caregiver-only and user-relayed events (not 'what Evia did for the family')", () => {
    expect(describeForFeed("caregiver_sent_message")).toBeNull();
    expect(describeForFeed("instant_payout_requested")).toBeNull();
    expect(describeForFeed("review_submitted")).toBeNull();
    expect(describeForFeed("journal_liked")).toBeNull();
    expect(describeForFeed("care_journal_created")).toBeNull();
  });

  it("EXCLUDES internal/system/bookkeeping events", () => {
    expect(describeForFeed("message_received")).toBeNull();
    expect(describeForFeed("session_created")).toBeNull();
    expect(describeForFeed("email_change_requested")).toBeNull();
    expect(describeForFeed("invoice_created")).toBeNull();
  });

  it("every included entry has a non-empty static description; excluded have none", () => {
    for (const [evt, policy] of Object.entries(ACTIVITY_FEED_EVENTS)) {
      if (policy.included) {
        expect(describeForFeed(evt as AuditEventType), `${evt} must describe`).toBeTruthy();
      } else {
        expect(describeForFeed(evt as AuditEventType), `${evt} must be null`).toBeNull();
      }
    }
  });

  it("no description embeds dynamic/PII-shaped content (static strings only)", () => {
    for (const policy of Object.values(ACTIVITY_FEED_EVENTS)) {
      if (policy.included && policy.description) {
        expect(policy.description).not.toMatch(/[{}$]|undefined|null/);
      }
    }
  });
});

describe("looksLikePhone", () => {
  it.each(["+15551234567", "15551234567", "5551234567"])("treats %s as a phone", (s) => {
    expect(looksLikePhone(s)).toBe(true);
  });
  it.each(["", "system", "abc123def456ghi789", "uK3jX..."])("treats %s as not a phone", (s) => {
    expect(looksLikePhone(s)).toBe(false);
  });
});

describe("ownerResolutionPlan (no mis-keyed writes)", () => {
  it("uses event.phone when present", () => {
    expect(ownerResolutionPlan({ phone: "+15551112222", userId: "+15551112222" })).toEqual({ phone: "+15551112222" });
  });
  it("treats a phone-shaped userId as a phone", () => {
    expect(ownerResolutionPlan({ userId: "+15553334444" })).toEqual({ phone: "+15553334444" });
  });
  it("treats a non-phone userId as a uid candidate (family-side events only)", () => {
    expect(ownerResolutionPlan({ userId: "firebaseUid123" })).toEqual({ uidCandidate: "firebaseUid123" });
  });
  it("yields no candidate for 'system' or empty userId (event will be skipped)", () => {
    expect(ownerResolutionPlan({ userId: "system" })).toEqual({});
    expect(ownerResolutionPlan({ userId: "" })).toEqual({});
    expect(ownerResolutionPlan({})).toEqual({});
  });
});
