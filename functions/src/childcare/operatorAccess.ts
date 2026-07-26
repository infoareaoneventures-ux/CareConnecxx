import * as admin from "firebase-admin";
import {
  OPERATOR_SCOPE_CHILD_BILLING,
  OPERATOR_SCOPE_CHILD_SAFETY,
  OPERATOR_SCOPE_CHILD_SCREENING,
  OPERATOR_SCOPE_CHILD_SUPPORT,
  type OperatorScope,
} from "../admin/requireOperatorScope";

export type ChildcareOperatorResourceType =
  | "booking"
  | "appointment"
  | "shift"
  | "payment"
  | "refund"
  | "dispute"
  | "payout"
  | "conversation"
  | "incident"
  | "file"
  | "review"
  | "safety_projection"
  | "screening";

interface OperatorResourcePolicy {
  scopes: readonly OperatorScope[];
  reasonCodes: readonly string[];
  nativeChildCollection: boolean;
  resolveRef(
    db: admin.firestore.Firestore,
    objectRef: string,
  ): admin.firestore.DocumentReference;
  project(data: Record<string, unknown>, objectRef: string): Record<string, unknown>;
}

const safe = (
  data: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> => Object.fromEntries(
  keys
    .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
    .map((key) => [key, data[key]]),
);

const sharedRef = (collection: string) =>
  (db: admin.firestore.Firestore, objectRef: string) =>
    db.collection(collection).doc(objectRef);

const sharedProject = (keys: readonly string[]) =>
  (data: Record<string, unknown>, objectRef: string) => ({
    objectRef,
    ...safe(data, keys),
  });

const SUPPORT_REASONS = ["support_case", "safety_review"] as const;
const SAFETY_REASONS = [
  "incident_triage",
  "incident_investigation",
  "safety_review",
] as const;
const BILLING_REASONS = [
  "billing_reconciliation",
  "refund_review",
  "payout_hold_review",
] as const;

export const CHILDCARE_OPERATOR_RESOURCE_POLICY: Record<
  ChildcareOperatorResourceType,
  OperatorResourcePolicy
> = {
  booking: {
    scopes: [
      OPERATOR_SCOPE_CHILD_SUPPORT,
      OPERATOR_SCOPE_CHILD_SAFETY,
      OPERATOR_SCOPE_CHILD_BILLING,
    ],
    reasonCodes: [...SUPPORT_REASONS, ...BILLING_REASONS],
    nativeChildCollection: false,
    resolveRef: sharedRef("booking_requests"),
    project: sharedProject([
      "careVertical", "status", "clientId", "caregiverId", "createdAt",
      "updatedAt", "acceptedAt", "cancelledAt", "paymentAuthorization",
    ]),
  },
  appointment: {
    scopes: [OPERATOR_SCOPE_CHILD_SUPPORT, OPERATOR_SCOPE_CHILD_SAFETY],
    reasonCodes: SUPPORT_REASONS,
    nativeChildCollection: false,
    resolveRef: sharedRef("appointments"),
    project: sharedProject([
      "careVertical", "status", "clientId", "caregiverId", "date",
      "startTime", "endTime", "createdAt", "updatedAt",
    ]),
  },
  shift: {
    scopes: [
      OPERATOR_SCOPE_CHILD_SUPPORT,
      OPERATOR_SCOPE_CHILD_SAFETY,
      OPERATOR_SCOPE_CHILD_BILLING,
    ],
    reasonCodes: [...SUPPORT_REASONS, ...BILLING_REASONS],
    nativeChildCollection: false,
    resolveRef: sharedRef("shifts"),
    project: sharedProject([
      "careVertical", "status", "clientId", "caregiverId", "appointmentId",
      "childcareBookingId", "createdAt", "updatedAt",
    ]),
  },
  payment: {
    scopes: [OPERATOR_SCOPE_CHILD_BILLING],
    reasonCodes: BILLING_REASONS,
    nativeChildCollection: false,
    resolveRef: sharedRef("shiftHours"),
    project: sharedProject([
      "careVertical", "status", "clientId", "caregiverId", "appointmentId",
      "childcareBookingId", "amountCents", "paymentGeneration",
      "paymentAttemptCount", "createdAt", "updatedAt",
    ]),
  },
  refund: {
    scopes: [OPERATOR_SCOPE_CHILD_BILLING],
    reasonCodes: BILLING_REASONS,
    nativeChildCollection: false,
    resolveRef: sharedRef("refundRequests"),
    project: sharedProject([
      "careVertical", "status", "clientId", "appointmentId",
      "childcareBookingId", "amountCents", "requestedAt", "updatedAt",
    ]),
  },
  dispute: {
    scopes: [OPERATOR_SCOPE_CHILD_BILLING, OPERATOR_SCOPE_CHILD_SAFETY],
    reasonCodes: [...BILLING_REASONS, "incident_investigation"],
    nativeChildCollection: false,
    resolveRef: sharedRef("disputes"),
    project: sharedProject([
      "careVertical", "status", "clientId", "caregiverId", "appointmentId",
      "createdAt", "updatedAt", "slaDeadline",
    ]),
  },
  payout: {
    scopes: [OPERATOR_SCOPE_CHILD_BILLING],
    reasonCodes: BILLING_REASONS,
    nativeChildCollection: false,
    resolveRef: sharedRef("payouts"),
    project: sharedProject([
      "careVertical", "status", "caregiverId", "appointmentId",
      "amountCents", "createdAt", "updatedAt",
    ]),
  },
  conversation: {
    scopes: [OPERATOR_SCOPE_CHILD_SAFETY],
    reasonCodes: SAFETY_REASONS,
    nativeChildCollection: false,
    resolveRef: sharedRef("chatRooms"),
    project: sharedProject([
      "careVertical", "contextType", "contextId", "state",
      "disclosurePhase", "accessVersion", "createdAt", "updatedAt",
    ]),
  },
  incident: {
    scopes: [OPERATOR_SCOPE_CHILD_SAFETY],
    reasonCodes: SAFETY_REASONS,
    nativeChildCollection: true,
    resolveRef: sharedRef("childcare_incidents"),
    project: sharedProject([
      "careVertical", "category", "status", "ownerUid", "createdAt",
      "updatedAt", "evidenceCount", "suspectedPartyCount",
    ]),
  },
  file: {
    scopes: [OPERATOR_SCOPE_CHILD_SAFETY],
    reasonCodes: SAFETY_REASONS,
    nativeChildCollection: true,
    resolveRef: (db, objectRef) => {
      const [childId, fileId, extra] = objectRef.split(":");
      if (!childId || !fileId || extra) throw new Error("invalid_object_ref");
      return db
        .collection("child_profiles")
        .doc(childId)
        .collection("private")
        .doc(`file_${fileId}`);
    },
    project: sharedProject([
      "state", "purpose", "mimeType", "bytes", "generation", "scanState",
      "createdAt", "updatedAt", "deletedAt",
    ]),
  },
  review: {
    scopes: [OPERATOR_SCOPE_CHILD_SAFETY],
    reasonCodes: [
      "moderation_queue_review", "approve_safe", "reject_child_pii",
      "reject_abuse", "reject_irrelevant", "unpublish_policy",
      "delete_retention",
    ],
    nativeChildCollection: true,
    resolveRef: sharedRef("childcare_review_submissions"),
    project: sharedProject([
      "careVertical", "moderationState", "reviewerRole", "rating",
      "stateVersion", "createdAt", "updatedAt",
    ]),
  },
  safety_projection: {
    scopes: [OPERATOR_SCOPE_CHILD_SAFETY],
    reasonCodes: SAFETY_REASONS,
    nativeChildCollection: true,
    resolveRef: sharedRef("childcare_booking_safety"),
    project: sharedProject([
      "careVertical", "bookingId", "currentVersion", "accessVersion",
      "state", "createdAt", "updatedAt",
    ]),
  },
  screening: {
    scopes: [OPERATOR_SCOPE_CHILD_SCREENING],
    reasonCodes: ["screening_review"],
    nativeChildCollection: true,
    resolveRef: (db, caregiverUid) =>
      db.collection("caregivers").doc(caregiverUid).collection("screenings").doc("child"),
    project: sharedProject([
      "careVertical", "state", "provider", "expiresAt", "evidenceStatus",
      "createdAt", "updatedAt",
    ]),
  },
};

export function isChildcareOperatorResourceType(
  value: string,
): value is ChildcareOperatorResourceType {
  return Object.prototype.hasOwnProperty.call(CHILDCARE_OPERATOR_RESOURCE_POLICY, value);
}

export async function readChildcareOperatorObject(params: {
  db?: admin.firestore.Firestore;
  resourceType: ChildcareOperatorResourceType;
  objectRef: string;
}): Promise<Record<string, unknown> | null> {
  const db = params.db ?? admin.firestore();
  const policy = CHILDCARE_OPERATOR_RESOURCE_POLICY[params.resourceType];
  let ref: admin.firestore.DocumentReference;
  try {
    ref = policy.resolveRef(db, params.objectRef);
  } catch {
    return null;
  }
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  if (!policy.nativeChildCollection && data.careVertical !== "child") return null;
  if (
    policy.nativeChildCollection &&
    "careVertical" in data &&
    data.careVertical !== "child"
  ) {
    return null;
  }
  return policy.project(data, params.objectRef);
}
