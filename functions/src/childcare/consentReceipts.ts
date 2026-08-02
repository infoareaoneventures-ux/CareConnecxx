// ── Versioned childcare consent receipts (plan 2026-07-22-002, U4 / R23) ─────
//
// Terms, privacy, screening disclosure, guardian attestation, communication
// consent, and childcare-policy acceptance are RECEIPTS, never mutable
// booleans. One immutable doc per (adult, policyType, policyVersion) in
// `consent_receipts` (Core Data Contracts) — re-accepting the same version is
// idempotent; a policy-version change produces a NEW receipt and retains the
// old one.
//
// Policy versions come from the jurisdiction policy's consentVersions
// (childcare/jurisdictionPolicy.ts). An UNPOPULATED version does NOT block
// dark-mode testing: the receipt is written in the "pending-policy-version"
// state — but activation stays blocked because the U1 readiness evaluator
// reports `consent_version_missing` for every unpopulated key (that linkage
// is pinned by consentReceipts.test.ts).
//
// PRIVACY: receipts carry the ADULT's uid, policy identifiers, channel, and
// source only — never child PII, phone-message text, or safety data (R57).
// Server-only collection: firestore.rules denies all browser access.

import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";
import {
  CHILDCARE_CONSENT_VERSION_KEYS,
  loadJurisdictionPolicy,
  type ChildcareConsentVersionKey,
} from "./jurisdictionPolicy";

export const CONSENT_RECEIPTS_COLLECTION = "consent_receipts";

/** Sentinel recorded when the jurisdiction policy has no version yet. */
export const PENDING_POLICY_VERSION = "pending-policy-version";

export type ConsentReceiptState = "recorded" | "pending-policy-version";
export type ConsentChannel = "sms" | "web";

export interface ConsentReceiptDoc {
  receiptId: string;
  adultUid: string;
  policyType: ChildcareConsentVersionKey;
  /** Real policy version, or PENDING_POLICY_VERSION. */
  policyVersion: string;
  state: ConsentReceiptState;
  channel: ConsentChannel;
  /** Machine-stable source slug (e.g. "childcare_family_signup"). */
  source: string;
  /** Jurisdiction the versions were read from (state code), or "" if unknown. */
  jurisdiction: string;
  careVertical: "child";
  createdAt: string;
  revokedAt: string | null;
}

type Db = admin.firestore.Firestore;

function sanitizeIdSegment(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
}

/** Deterministic receipt ID — idempotency per (adult, policyType, version). */
export function consentReceiptDocId(
  adultUid: string,
  policyType: ChildcareConsentVersionKey,
  policyVersion: string,
): string {
  return `${sanitizeIdSegment(adultUid)}__${policyType}__${sanitizeIdSegment(policyVersion)}`;
}

function isUnpopulatedVersion(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return true;
  const t = v.trim();
  return t.length === 0 || t.startsWith("FILL_IN");
}

export interface WriteConsentReceiptsParams {
  adultUid: string;
  /** State code whose jurisdiction policy supplies consent versions. */
  jurisdictionState: string;
  channel: ConsentChannel;
  source: string;
  /** Subset of policy types to record; defaults to all six keys (R23). */
  policyTypes?: readonly ChildcareConsentVersionKey[];
  db?: Db;
  now?: Date;
}

export interface WriteConsentReceiptsResult {
  receipts: ConsentReceiptDoc[];
  /** How many receipts were newly created this call (vs already existing). */
  createdCount: number;
  /** How many landed in the pending-policy-version state. */
  pendingCount: number;
}

/**
 * Write the versioned consent receipts for a childcare adult. Idempotent:
 * deterministic doc IDs + `create()` — a duplicate first inbound or a retried
 * turn converges on the same receipt set (AE15).
 */
export async function writeChildcareConsentReceipts(
  params: WriteConsentReceiptsParams,
): Promise<WriteConsentReceiptsResult> {
  const db = params.db ?? admin.firestore();
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const adultUid = String(params.adultUid ?? "").trim();
  if (!adultUid) throw new Error("consentReceipts: adultUid is required");

  const policy = await loadJurisdictionPolicy(params.jurisdictionState, db).catch(() => null);
  const versions = (policy?.consentVersions ?? {}) as Record<string, unknown>;
  const jurisdiction = String(params.jurisdictionState ?? "").trim().toUpperCase();
  const keys = params.policyTypes ?? CHILDCARE_CONSENT_VERSION_KEYS;

  const receipts: ConsentReceiptDoc[] = [];
  let createdCount = 0;
  let pendingCount = 0;

  for (const policyType of keys) {
    const rawVersion = versions[policyType];
    const pending = isUnpopulatedVersion(rawVersion);
    const policyVersion = pending ? PENDING_POLICY_VERSION : String(rawVersion).trim();
    const receiptId = consentReceiptDocId(adultUid, policyType, policyVersion);
    const doc: ConsentReceiptDoc = {
      receiptId,
      adultUid,
      policyType,
      policyVersion,
      state: pending ? "pending-policy-version" : "recorded",
      channel: params.channel,
      source: params.source,
      jurisdiction,
      careVertical: "child",
      createdAt: nowIso,
      revokedAt: null,
    };
    if (pending) pendingCount++;
    try {
      await db.collection(CONSENT_RECEIPTS_COLLECTION).doc(receiptId).create(doc);
      createdCount++;
      receipts.push(doc);
    } catch (err: unknown) {
      // ALREADY_EXISTS ⇒ idempotent replay: keep the ORIGINAL receipt.
      const code = (err as { code?: number | string })?.code;
      if (code === 6 || code === "already-exists" || /already exists/i.test(String((err as Error)?.message ?? ""))) {
        const existing = await db.collection(CONSENT_RECEIPTS_COLLECTION).doc(receiptId).get();
        receipts.push((existing.data() ?? doc) as ConsentReceiptDoc);
      } else {
        throw err;
      }
    }
  }

  await logAudit({
    eventType: "childcare_consent_receipts_recorded",
    userId: adultUid,
    data: {
      jurisdiction,
      source: params.source,
      channel: params.channel,
      createdCount,
      pendingCount,
      policyTypes: [...keys],
    },
  }).catch(() => {});

  return { receipts, createdCount, pendingCount };
}

/**
 * Revoke an adult's communication-consent receipts (opt-out / STOP). Receipts
 * are never deleted — revocation stamps revokedAt (R23: receipts, not
 * booleans). Best-effort per doc; idempotent (already-revoked rows keep their
 * original revokedAt).
 */
export async function revokeCommunicationConsentReceipts(
  adultUid: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<number> {
  const db = opts.db ?? admin.firestore();
  const nowIso = (opts.now ?? new Date()).toISOString();
  const clean = String(adultUid ?? "").trim();
  if (!clean) return 0;

  const snap = await db
    .collection(CONSENT_RECEIPTS_COLLECTION)
    .where("adultUid", "==", clean)
    .where("policyType", "==", "communicationConsent")
    .get();

  let revoked = 0;
  for (const doc of snap.docs) {
    const data = doc.data() as Partial<ConsentReceiptDoc>;
    if (data.revokedAt) continue; // idempotent — keep the original stamp
    await doc.ref.update({ revokedAt: nowIso }).catch(() => {});
    revoked++;
  }

  if (revoked > 0) {
    await logAudit({
      eventType: "childcare_consent_receipt_revoked",
      userId: clean,
      data: { policyType: "communicationConsent", revoked },
    }).catch(() => {});
  }
  return revoked;
}
