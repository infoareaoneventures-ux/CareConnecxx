// Cara ↔ Web Firestore data contract.
//
// The launch invariant: **Cara must write where the web reads.** This module is
// the single canonical registry of the collections both sides share, their doc
// ID schemes, and which side writes/reads them. tests/contractCollections.test.ts
// statically verifies the codebase stays aligned with this registry — if you
// add or move a shared collection, update this file (and the test will tell
// you when you forget).
//
// NOTE on fragmentation: client care data is intentionally mirrored across
// senior_profiles, carePlans, and job_postings — all three have live web
// readers. Do NOT consolidate/delete any of them without migrating every
// reader; for launch we mirror to all live web-read stores.

export type DocIdScheme =
  | "uid"            // Firebase Auth uid (canonical for user-owned docs)
  | "phone"          // E.164 phone number (agent sessions)
  | "composite"      // deterministic multi-field key
  | "auto"           // Firestore auto-ID
  | "appointmentId"  // keyed by the related appointment's doc ID
  | "subcollection"; // nested under a parent doc

export interface ContractCollection {
  /** Firestore collection path (template segments in {braces}) */
  path: string;
  docId: DocIdScheme;
  /** Who writes it in the Cara/functions backend */
  caraWrites: boolean;
  /** Who reads it on the web (services/api.ts, components, hooks) */
  webReads: boolean;
  notes?: string;
}

export const CONTRACT_COLLECTIONS: Record<string, ContractCollection> = {
  users: {
    path: "users",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Cara writes membership/identity status for clients and the caregiver parity doc at finalization.",
  },
  caregivers: {
    path: "caregivers",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "uid-keyed since the identity unification; legacy random-ID docs are migrated at finalization. Checkr webhook looks up by backgroundCheckData.checkrCandidateId (query, ID-agnostic).",
  },
  clientIntakes: {
    path: "clientIntakes",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Cara onboarding writes clientIntakes/{uid}; matching triggers listen onCreate/onUpdate.",
  },
  senior_profiles: {
    path: "senior_profiles",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Web signup creates it; Cara onboarding mirrors senior name/age/needs/diagnoses.",
  },
  care_plans: {
    path: "senior_profiles/{clientUid}/care_plans/default",
    docId: "subcollection",
    caraWrites: true,
    webReads: true,
    notes: "Versioned care plan subcollection used by care-plan tools.",
  },
  carePlans: {
    path: "carePlans",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "CarePlan.tsx reads/writes carePlans/{uid}; Cara writes the initial doc at client payment.",
  },
  job_postings: {
    path: "job_postings",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Per-client job posting mirror (job_postings/{clientUid}); kept in sync with job_posts.",
  },
  job_posts: {
    path: "job_posts",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "The job board. Written via buildAndSaveJobPost (shared by Cara + web flows).",
  },
  appointments: {
    path: "appointments",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Created pending_caregiver_confirmation; confirmed only after the caregiver accepts the shift offer.",
  },
  booking_requests: {
    path: "booking_requests",
    docId: "auto",
    caraWrites: false,
    webReads: true,
    notes: "Web-originated booking requests; Cara's equivalent is agent_tasks(type=booking_confirmation) + shift_offers.",
  },
  shift_offers: {
    path: "shift_offers",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Caregiver YES/NO offer state machine (agents/shiftOffer.ts).",
  },
  family_groups: {
    path: "family_groups",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Linq group chat metadata for family care groups. Server-created through familyGroupManager.",
  },
  family_group_members: {
    path: "family_group_members",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes: "Deterministic primaryPhone_memberPhone membership index used by inbound routing and /join.",
  },
  shiftHours: {
    path: "shiftHours",
    docId: "appointmentId",
    caraWrites: true,
    webReads: true,
    notes: "Clock-in/out + payroll. Cara writes via clock_in_shift / submit_shift_hours tools.",
  },
  threads: {
    path: "threads/{threadId}/messages",
    docId: "subcollection",
    caraWrites: true,
    webReads: true,
    notes: "Web chat. Cara conversations are mirrored in (linq/threadMirror.ts, thread ID cara_{uid}).",
  },
  support_tickets: {
    path: "support_tickets",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Cara's create_support_ticket tool writes here; admin TicketManager reads.",
  },
  admin_alerts: {
    path: "admin_alerts",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Safety/emergency escalations, signup + booking alerts. Admin surfaces read these.",
  },
  care_journal: {
    path: "care_journal",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Caregiver visit journal; family/client surfaces read entries.",
  },
  proactive_drafts: {
    path: "proactive_drafts",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Cara-drafted proactive messages awaiting admin review.",
  },
  referrals: {
    path: "referrals",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Client/caregiver referral lifecycle. Cara writes SMS referrals; web ReferralProgram reads user referral status.",
  },
  agent_audit_log: {
    path: "agent_audit_log",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Every consequential agent action (observability/auditLog.ts); AuditTrail admin surface reads.",
  },
  agent_action_ledger: {
    path: "agent_action_ledger",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Durable status ledger for consequential Cara actions; admin audit surfaces read it.",
  },
  pending_actions: {
    path: "pending_actions",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Runtime confirmation queue for high-risk Cara actions; AdminCaraControlRoom reads stuck and awaiting approvals.",
  },
};

/** Collection names (top-level segment only) that Cara writes. */
export function caraWrittenCollections(): string[] {
  return Object.values(CONTRACT_COLLECTIONS)
    .filter((c) => c.caraWrites)
    .map((c) => c.path.split("/")[0]);
}

/** Collection names (top-level segment only) that the web reads. */
export function webReadCollections(): string[] {
  return Object.values(CONTRACT_COLLECTIONS)
    .filter((c) => c.webReads)
    .map((c) => c.path.split("/")[0]);
}
