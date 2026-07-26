// Childcare U4 (plan 2026-07-22-002, R23): versioned consent receipts.
//
// Pins: one immutable receipt per (adult, policyType, policyVersion) with
// create-once idempotency; unpopulated jurisdiction versions record the
// pending-policy-version state WITHOUT blocking dark-mode testing, while the
// U1 readiness evaluator keeps activation blocked (that linkage is asserted
// here); STOP revocation stamps revokedAt and never deletes; receipts carry
// no child PII.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../observability/auditLog", () => ({
  logAudit: vi.fn(async () => {}),
}));

import { makeFakeDb } from "./__tests__/fakeFirestore";
import {
  CONSENT_RECEIPTS_COLLECTION,
  PENDING_POLICY_VERSION,
  consentReceiptDocId,
  writeChildcareConsentReceipts,
  revokeCommunicationConsentReceipts,
} from "./consentReceipts";
import { CHILDCARE_CONSENT_VERSION_KEYS, evaluatePolicyReadiness, CA_PILOT_POLICY_SEED } from "./jurisdictionPolicy";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const UID = "adult-uid-1";

function policyWithVersions() {
  return {
    ...CA_PILOT_POLICY_SEED,
    consentVersions: {
      terms: "childcare-terms-v1",
      privacy: "childcare-privacy-v1",
      screeningDisclosure: "childcare-screening-disclosure-v1",
      guardianAttestation: "childcare-guardian-attestation-v1",
      communicationConsent: "childcare-communication-consent-v1",
      childcarePolicy: "childcare-policy-v1",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("writeChildcareConsentReceipts", () => {
  it("records one versioned receipt per policy type from the jurisdiction policy", async () => {
    const fake = makeFakeDb({ "jurisdiction_care_policies/CA": policyWithVersions() as any });
    const result = await writeChildcareConsentReceipts({
      adultUid: UID,
      jurisdictionState: "CA",
      channel: "web",
      source: "childcare_family_signup",
      db: fake.db,
      now: NOW,
    });
    expect(result.receipts).toHaveLength(CHILDCARE_CONSENT_VERSION_KEYS.length);
    expect(result.createdCount).toBe(CHILDCARE_CONSENT_VERSION_KEYS.length);
    expect(result.pendingCount).toBe(0);
    const terms = fake.get(`${CONSENT_RECEIPTS_COLLECTION}/${consentReceiptDocId(UID, "terms", "childcare-terms-v1")}`);
    expect(terms).toMatchObject({
      adultUid: UID,
      policyType: "terms",
      policyVersion: "childcare-terms-v1",
      state: "recorded",
      channel: "web",
      jurisdiction: "CA",
      careVertical: "child",
      revokedAt: null,
    });
  });

  it("unpopulated versions record the pending-policy-version state (dark-mode testable)", async () => {
    // CA seed ships with ALL consent versions null (founder work list).
    const fake = makeFakeDb({ "jurisdiction_care_policies/CA": CA_PILOT_POLICY_SEED as any });
    const result = await writeChildcareConsentReceipts({
      adultUid: UID,
      jurisdictionState: "CA",
      channel: "sms",
      source: "childcare_family_signup",
      db: fake.db,
      now: NOW,
    });
    expect(result.pendingCount).toBe(CHILDCARE_CONSENT_VERSION_KEYS.length);
    for (const receipt of result.receipts) {
      expect(receipt.state).toBe("pending-policy-version");
      expect(receipt.policyVersion).toBe(PENDING_POLICY_VERSION);
    }
  });

  it("readiness-evaluator linkage: pending receipts coexist with a BLOCKED activation (consent_version_missing)", () => {
    // The same unpopulated versions that produce pending receipts must keep
    // the U1 evaluator failing closed — receipts never unlock activation.
    const issues = evaluatePolicyReadiness(CA_PILOT_POLICY_SEED, { now: NOW, expectedState: "CA" });
    const consentIssues = issues.filter((i) => i.code === "consent_version_missing");
    expect(consentIssues).toHaveLength(CHILDCARE_CONSENT_VERSION_KEYS.length);
  });

  it("absent jurisdiction policy ⇒ every receipt pending (no throw)", async () => {
    const fake = makeFakeDb();
    const result = await writeChildcareConsentReceipts({
      adultUid: UID,
      jurisdictionState: "CA",
      channel: "web",
      source: "childcare_family_signup",
      db: fake.db,
      now: NOW,
    });
    expect(result.pendingCount).toBe(CHILDCARE_CONSENT_VERSION_KEYS.length);
  });

  it("is idempotent: a duplicate write converges on the ORIGINAL receipts (AE15)", async () => {
    const fake = makeFakeDb({ "jurisdiction_care_policies/CA": policyWithVersions() as any });
    const args = {
      adultUid: UID,
      jurisdictionState: "CA",
      channel: "web" as const,
      source: "childcare_family_signup",
      db: fake.db,
    };
    const first = await writeChildcareConsentReceipts({ ...args, now: NOW });
    const second = await writeChildcareConsentReceipts({ ...args, now: new Date(NOW.getTime() + 60_000) });
    expect(first.createdCount).toBe(CHILDCARE_CONSENT_VERSION_KEYS.length);
    expect(second.createdCount).toBe(0);
    // Original createdAt preserved — the replay did not overwrite.
    expect(second.receipts[0].createdAt).toBe(NOW.toISOString());
  });

  it("a consent VERSION change produces a NEW receipt and retains the old one", async () => {
    const fake = makeFakeDb({ "jurisdiction_care_policies/CA": policyWithVersions() as any });
    await writeChildcareConsentReceipts({
      adultUid: UID, jurisdictionState: "CA", channel: "web",
      source: "childcare_family_signup", policyTypes: ["terms"], db: fake.db, now: NOW,
    });
    fake.seed("jurisdiction_care_policies/CA", {
      ...policyWithVersions(),
      consentVersions: { ...policyWithVersions().consentVersions, terms: "childcare-terms-v2" },
    } as any);
    const second = await writeChildcareConsentReceipts({
      adultUid: UID, jurisdictionState: "CA", channel: "web",
      source: "childcare_family_signup", policyTypes: ["terms"], db: fake.db, now: NOW,
    });
    expect(second.createdCount).toBe(1);
    expect(fake.get(`${CONSENT_RECEIPTS_COLLECTION}/${consentReceiptDocId(UID, "terms", "childcare-terms-v1")}`)).toBeDefined();
    expect(fake.get(`${CONSENT_RECEIPTS_COLLECTION}/${consentReceiptDocId(UID, "terms", "childcare-terms-v2")}`)).toBeDefined();
  });

  it("receipts carry the adult + policy identifiers ONLY (no child PII fields)", async () => {
    const fake = makeFakeDb({ "jurisdiction_care_policies/CA": policyWithVersions() as any });
    const result = await writeChildcareConsentReceipts({
      adultUid: UID, jurisdictionState: "CA", channel: "web",
      source: "childcare_family_signup", policyTypes: ["terms"], db: fake.db, now: NOW,
    });
    expect(Object.keys(result.receipts[0]).sort()).toEqual([
      "adultUid", "careVertical", "channel", "createdAt", "jurisdiction",
      "policyType", "policyVersion", "receiptId", "revokedAt", "source", "state",
    ]);
  });

  it("rejects an empty adultUid", async () => {
    const fake = makeFakeDb();
    await expect(writeChildcareConsentReceipts({
      adultUid: " ", jurisdictionState: "CA", channel: "web",
      source: "x", db: fake.db,
    })).rejects.toThrow(/adultUid/);
  });
});

describe("revokeCommunicationConsentReceipts (opt-out / STOP)", () => {
  it("stamps revokedAt on communicationConsent receipts only — never deletes", async () => {
    const fake = makeFakeDb({ "jurisdiction_care_policies/CA": policyWithVersions() as any });
    await writeChildcareConsentReceipts({
      adultUid: UID, jurisdictionState: "CA", channel: "web",
      source: "childcare_family_signup", db: fake.db, now: NOW,
    });
    const revoked = await revokeCommunicationConsentReceipts(UID, { db: fake.db, now: new Date("2026-07-23T00:00:00.000Z") });
    expect(revoked).toBe(1);
    const comm = fake.get(`${CONSENT_RECEIPTS_COLLECTION}/${consentReceiptDocId(UID, "communicationConsent", "childcare-communication-consent-v1")}`);
    expect(comm?.revokedAt).toBe("2026-07-23T00:00:00.000Z");
    // Terms receipt untouched.
    const terms = fake.get(`${CONSENT_RECEIPTS_COLLECTION}/${consentReceiptDocId(UID, "terms", "childcare-terms-v1")}`);
    expect(terms?.revokedAt).toBeNull();
  });

  it("is idempotent — a second STOP keeps the original revocation stamp", async () => {
    const fake = makeFakeDb({ "jurisdiction_care_policies/CA": policyWithVersions() as any });
    await writeChildcareConsentReceipts({
      adultUid: UID, jurisdictionState: "CA", channel: "web",
      source: "childcare_family_signup", db: fake.db, now: NOW,
    });
    const t1 = new Date("2026-07-23T00:00:00.000Z");
    await revokeCommunicationConsentReceipts(UID, { db: fake.db, now: t1 });
    const again = await revokeCommunicationConsentReceipts(UID, { db: fake.db, now: new Date("2026-07-24T00:00:00.000Z") });
    expect(again).toBe(0);
    const comm = fake.get(`${CONSENT_RECEIPTS_COLLECTION}/${consentReceiptDocId(UID, "communicationConsent", "childcare-communication-consent-v1")}`);
    expect(comm?.revokedAt).toBe(t1.toISOString());
  });

  it("no-ops for an unknown adult", async () => {
    const fake = makeFakeDb();
    expect(await revokeCommunicationConsentReceipts("nobody", { db: fake.db })).toBe(0);
  });
});
