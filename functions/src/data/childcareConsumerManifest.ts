// Childcare consumer manifest (childcare marketplace plan 2026-07-22-002, U0).
//
// The System-Wide Consumer Rule: every reader/writer/trigger/scheduler/browser
// surface/agent tool that touches a shared collection (users, senior_profiles,
// caregivers, publicCaregiverProfiles, jobs, applications, interviews, booking
// requests, appointments, shifts, hours, reviews, chat rooms, threads,
// notifications, payments/ledgers, audits, memory, incidents) must name ONE
// disposition before childcare enablement. Zero UNCLASSIFIED consumers.
//
// This module is the machine-readable side of
// docs/architecture/childcare-consumer-manifest.md. Enforcement:
//   • data/childcareConsumerManifest.test.ts — entries reference real files,
//     no duplicate consumerName, valid disposition/owner unit.
//   • scripts/audit-childcare-consumers.mjs (npm run audit:childcare-consumers)
//     — scans the source tree for shared-collection literals and fails when a
//     consuming file is not registered here.
//
// Granularity is one entry per source FILE (the same granularity the audit
// scanner resolves), with the collections that file touches. A file's
// disposition applies to every shared-collection touch in it; where a single
// file will end up split across dispositions (e.g. mcp/server.ts tools), the
// owning unit refines the classification inside that unit — the file-level
// entry records the strictest interim contract.
//
// Dispositions (see the plan's System-Wide Consumer Rule):
//   1. "shared-vertical-aware"            — serves both verticals through a
//      typed adapter; must branch on careVertical (or typed recipient) before
//      touching vertical-specific fields.
//   2. "senior-only-explicit-skip"        — senior-vertical only; must
//      explicitly skip child-vertical records (with a characterization test in
//      its owning unit), never process them by accident.
//   3. "child-specific"                   — childcare-only consumer with
//      server authorization and privacy tests (first entries created by U1:
//      jurisdiction policy + childcare flags; recipient-data consumers arrive
//      with U3+).
//   4. "legacy-compat-remove-after-migration" — legacy compatibility
//      reader/writer removed after its replacement migrates.
//   5. "disabled-before-childcare"        — must be disabled before childcare
//      enablement (never allowed to see child-vertical data).
//
// The careVertical field contract (cutoff rule, fail-closed semantics) lives
// in data/contract.ts (CareVertical / CARE_VERTICAL_MIGRATION_CUTOFF).

export type CareVerticalDisposition =
  | "shared-vertical-aware"
  | "senior-only-explicit-skip"
  | "child-specific"
  | "legacy-compat-remove-after-migration"
  | "disabled-before-childcare";

/** Implementation unit (plan 2026-07-22-002) that owns the consumer's childcare work. */
export type ChildcareOwnerUnit =
  | "U1" | "U2" | "U3" | "U4" | "U5" | "U6" | "U7"
  | "U8" | "U9" | "U10" | "U11" | "U12" | "U13" | "U14";

export interface ChildcareConsumerEntry {
  /** Unique consumer name (repo-relative source path without extension). */
  consumerName: string;
  /** Repo-relative source file (forward slashes). */
  sourceFile: string;
  /**
   * Shared collections this file touches. Empty only for registered seams
   * that consume shared data indirectly (via services/api.ts, shared helpers,
   * or agent-session state) — the notes say how.
   */
  collections: string[];
  disposition: CareVerticalDisposition;
  ownerUnit: ChildcareOwnerUnit;
  notes?: string;
}

/**
 * The shared collections the audit scanner watches for. Kept as string
 * literals in ONE array — scripts/audit-childcare-consumers.mjs parses this
 * array out of this file so script and manifest can never drift.
 */
export const SHARED_VERTICAL_COLLECTIONS: readonly string[] = [
  "users",
  "senior_profiles",
  "caregivers",
  "publicCaregiverProfiles",
  "job_posts",
  "job_postings",
  "job_applications",
  "interviews",
  "video_interviews",
  "interview_requests",
  "booking_requests",
  "appointments",
  "shifts",
  "shiftHours",
  "reviews",
  "chatRooms",
  "threads",
  "notifications",
  "payments",
  "payouts",
  "invoices",
  "hire_requests",
  "agent_audit_log",
  "agent_action_ledger",
  "learned_facts",
  "memory_operations",
  "memory_reconciliation",
  "memory_embeddings",
  "agent_conversations",
  "admin_alerts",
  "reports",
  "disputes",
  "caregiver_reputation",
  "match_history",
  "family_groups",
  "family_group_members",
  // Childcare governance collections (U1). Not senior/child recipient data,
  // but watched so any NEW consumer of policy or flags must register here
  // first — an unregistered reader of childcare_flags is exactly the kind of
  // unclassified rollout seam the audit exists to catch. (NOTE: the audit
  // script extracts every double-quoted string in this array block, so keep
  // comments here free of double quotes.)
  "jurisdiction_care_policies",
  "childcare_flags",
  // Household + guardian-authority collections (U2). Recipient-scoped
  // authorization data — every consumer must be registered before touching
  // them; the authority outbox and invite tokens are server-only. (Same
  // reminder as above: no double-quoted words in comments inside this array.)
  "households",
  "household_memberships",
  "guardian_authorities",
  "childcare_invite_tokens",
  "guardianAuthorityOutbox",
  // Child profile + privacy lifecycle collections (U3). The most sensitive
  // recipient data on the platform — every consumer registers here first.
  // The private safety zone and restricted file records are subcollection
  // docs under the profile path; the lifecycle collection is the durable
  // export/delete/redact state machine. (Same reminder as above: no
  // double-quoted words in comments inside this array.)
  "child_profiles",
  "data_lifecycle_requests",
  // Family signup, consent receipts + identity gate collections (U4). Consent
  // receipts and identity session/callback records are server-only; any NEW
  // consumer must register here first. (Same reminder as above: no
  // double-quoted words in comments inside this array.)
  "consent_receipts",
  "childcare_identity_sessions",
  "childcare_identity_callbacks",
  // Provider vertical profile + screening subcollections (U5). Both live under
  // caregivers/{uid}; screenings hold screening evidence references and are
  // fully server-only, vertical profiles are owner-read/server-write. Any NEW
  // consumer must register here first. (Same reminder as above: no
  // double-quoted words in comments inside this array.)
  "vertical_profiles",
  "screenings",
  // Booking safety projections (U7). Versioned minimum projections for the
  // assigned caregiver — the most booking-sensitive child data outside the
  // private zone; every consumer registers here first. (Same reminder as
  // above: no double-quoted words in comments inside this array.)
  "childcare_booking_safety",
  // Childcare pricing configuration (U8, R40). Founder-approved money policy
  // resolved through the jurisdiction pricing refs — any NEW reader must
  // register here first; the only sanctioned reader is
  // childcare/paymentPolicy.resolveChildcarePricingSnapshot. (Same reminder
  // as above: no double-quoted words in comments inside this array.)
  "childcare_pricing_configs",
  // SMS burst-throttle markers (U9). Operational only (timestamps keyed by
  // room/recipient - no message content), shared with the senior onMessageSent
  // throttle; watched so notification-sending consumers stay registered.
  // (Same reminder as above: no double-quoted words in comments inside this
  // array.)
  "smsThrottles",
  // Restricted incident cases + operator scope grants (U12). Both FULLY
  // server-only in rules (even admins get no browser read); every consumer
  // registers here first. Incident cases hold evidence REFERENCES only -
  // never copies of child data; operator grants are founder-provisioned via
  // the Admin SDK. (Same reminder as above: no double-quoted words in
  // comments inside this array.)
  "childcare_incidents",
  "childcare_operators",
  // Canary + rollout-hold state (U13). Governance-only: privacy-safe COUNTS and
  // the automatic rollout-HOLD signal the U14 deploy gate reads. SYNTHETIC
  // identifiers only - never child data. The sole writer is
  // childcare/childcareCanaryWatch; watched so any NEW reader/writer registers
  // here first. (Same reminder as above: no double-quoted words in comments
  // inside this array.)
  "childcare_canary_state",
  // Collections already named by registered entries above but previously
  // missing from this watch array. Server-only in every case: the durable
  // agent objective/pending-action ledgers and the senior refund state
  // machine (shared with childcare money paths), plus the childcare
  // file-delivery references, file-scan operations, private review
  // submissions, and App Check probe challenges. Watched so any NEW literal
  // consumer of them must register here first. (Same reminder as above: no
  // double-quoted words in comments inside this array.)
  "agent_objectives",
  "pending_actions",
  "refundRequests",
  "childcare_file_delivery_refs",
  "childcare_file_scan_operations",
  "childcare_review_submissions",
  "childcare_appcheck_probe_challenges",
] as const;

export const CHILDCARE_CONSUMER_MANIFEST: ChildcareConsumerEntry[] = [

  // ── components ──
  {
    consumerName: "components/CarePlan",
    sourceFile: "components/CarePlan.tsx",
    collections: ["job_postings", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U11",
    notes: "Senior care-plan surface (care_plans/carePlans + legacy job_postings mirror).",
  },
  {
    consumerName: "components/CaregiverDashboard",
    sourceFile: "components/CaregiverDashboard.tsx",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/CaregiverProfile",
    sourceFile: "components/CaregiverProfile.tsx",
    collections: ["interview_requests", "job_applications", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/ClientCaregiverProfile",
    sourceFile: "components/ClientCaregiverProfile.tsx",
    collections: ["booking_requests", "publicCaregiverProfiles", "reviews", "shifts", "users", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/ClientProfile",
    sourceFile: "components/ClientProfile.tsx",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
    notes: "Appendix-named profile surface; touches shared collections via services/api.ts.",
  },
  {
    consumerName: "components/ClientProfileDashboard",
    sourceFile: "components/ClientProfileDashboard.tsx",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
    notes: "Appendix-named profile surface; touches shared collections via services/api.ts.",
  },
  {
    consumerName: "components/FindCaregivers",
    sourceFile: "components/FindCaregivers.tsx",
    collections: ["booking_requests", "job_postings", "job_posts", "publicCaregiverProfiles", "users", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "components/InboxView",
    sourceFile: "components/InboxView.tsx",
    collections: ["booking_requests", "publicCaregiverProfiles", "reports", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9: unchanged this unit (childcare UI is U11). Safe today by construction: childcare rooms a participant sees carry only adult names + the generic lastMessage label; any send attempt into a childcare room is rules-denied (server callables own sends). U11 wires the childcare room list/read seams.",
  },
  {
    consumerName: "components/ReviewSystem",
    sourceFile: "components/ReviewSystem.tsx",
    collections: ["appointments", "caregivers", "reviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8: browser review WRITES are structurally senior-only now — firestore.rules denies any careVertical=='child' review create/update from clients, so this surface cannot produce a childcare review even unmodified. Childcare reviews go through v1-submitChildcareReview; the childcare review UI is U11.",
  },
  {
    consumerName: "components/Schedule",
    sourceFile: "components/Schedule.tsx",
    collections: ["booking_requests", "job_posts", "publicCaregiverProfiles", "shifts", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "components/WeeklySummary",
    sourceFile: "components/WeeklySummary.tsx",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U11",
    notes: "Senior weekly care summary.",
  },
  {
    consumerName: "components/admin/AdminClientManager",
    sourceFile: "components/admin/AdminClientManager.tsx",
    collections: ["job_posts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "components/admin/AdminMessages",
    sourceFile: "components/admin/AdminMessages.tsx",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "components/admin/AssignmentManager",
    sourceFile: "components/admin/AssignmentManager.tsx",
    collections: ["caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "components/admin/AuditDashboard",
    sourceFile: "components/admin/AuditDashboard.tsx",
    collections: ["agent_audit_log"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "components/admin/AuditTrail",
    sourceFile: "components/admin/AuditTrail.tsx",
    collections: ["agent_action_ledger", "agent_audit_log"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "components/admin/InvoicingTab",
    sourceFile: "components/admin/InvoicingTab.tsx",
    collections: ["caregivers", "invoices", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "components/admin/ChildcareIncidentQueue",
    sourceFile: "components/admin/ChildcareIncidentQueue.tsx",
    collections: [],
    disposition: "child-specific",
    ownerUnit: "U12",
    notes:
      "U12 DONE: operator incident queue UI. NO direct Firestore access — the sanitized queue comes from v1-listChildcareIncidents (pinned row keys, no child details) and detail from v1-getChildcareIncidentDetail behind a mandatory reason-for-access prompt (R56). Browser reads of childcare_incidents are rules-denied even to admins.",
  },
  {
    consumerName: "components/caregiver/CaregiverBookingsPage",
    sourceFile: "components/caregiver/CaregiverBookingsPage.tsx",
    collections: ["booking_requests", "caregivers", "shifts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "components/caregiver/CaregiverCalendarPage",
    sourceFile: "components/caregiver/CaregiverCalendarPage.tsx",
    collections: ["booking_requests", "caregivers", "job_posts", "senior_profiles", "shifts", "users", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "components/caregiver/CaregiverCareRequestsCard",
    sourceFile: "components/caregiver/CaregiverCareRequestsCard.tsx",
    collections: ["interview_requests", "job_applications", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/caregiver/CaregiverFamiliesPage",
    sourceFile: "components/caregiver/CaregiverFamiliesPage.tsx",
    collections: ["booking_requests", "shifts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/caregiver/CaregiverHomeDashboard",
    sourceFile: "components/caregiver/CaregiverHomeDashboard.tsx",
    collections: ["booking_requests", "job_applications", "shifts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/caregiver/CaregiverPayments",
    sourceFile: "components/caregiver/CaregiverPayments.tsx",
    collections: ["caregivers", "shifts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "components/caregiver/CaregiverPaymentsPage",
    sourceFile: "components/caregiver/CaregiverPaymentsPage.tsx",
    collections: ["shifts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "components/caregiver/JobBoard",
    sourceFile: "components/caregiver/JobBoard.tsx",
    collections: ["interview_requests", "job_posts", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "components/caregiver/PayoutHistory",
    sourceFile: "components/caregiver/PayoutHistory.tsx",
    collections: ["caregivers", "payouts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "components/client/AccountSettings",
    sourceFile: "components/client/AccountSettings.tsx",
    collections: ["senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/client/BrowseCaregivers",
    sourceFile: "components/client/BrowseCaregivers.tsx",
    collections: ["publicCaregiverProfiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/client/ClientDashboard",
    sourceFile: "components/client/ClientDashboard.tsx",
    collections: ["appointments", "booking_requests", "job_posts", "publicCaregiverProfiles", "shifts", "users", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/client/ClientNavigation",
    sourceFile: "components/client/ClientNavigation.tsx",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/client/ClientVisitsPage",
    sourceFile: "components/client/ClientVisitsPage.tsx",
    collections: ["booking_requests", "publicCaregiverProfiles", "shifts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "components/client/DashboardSidebar",
    sourceFile: "components/client/DashboardSidebar.tsx",
    collections: ["job_posts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/client/EditJobPostModal",
    sourceFile: "components/client/EditJobPostModal.tsx",
    collections: ["job_posts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "components/client/IdentityCallback",
    sourceFile: "components/client/IdentityCallback.tsx",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U4",
  },
  {
    consumerName: "components/client/LeaveReviewModal",
    sourceFile: "components/client/LeaveReviewModal.tsx",
    collections: ["caregivers", "publicCaregiverProfiles", "reviews", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8: browser review WRITES are structurally senior-only now — firestore.rules denies any careVertical=='child' review create/update from clients. Childcare reviews go through v1-submitChildcareReview; the childcare review UI is U11.",
  },
  {
    consumerName: "components/client/MyCareTeam",
    sourceFile: "components/client/MyCareTeam.tsx",
    collections: ["booking_requests", "publicCaregiverProfiles", "shifts", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "components/client/Payments",
    sourceFile: "components/client/Payments.tsx",
    collections: ["shifts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "components/client/PostsPage",
    sourceFile: "components/client/PostsPage.tsx",
    collections: ["booking_requests", "job_applications", "job_postings", "job_posts", "publicCaregiverProfiles", "shifts", "users", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "components/client/WhatsNext",
    sourceFile: "components/client/WhatsNext.tsx",
    collections: ["job_postings", "job_posts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
    notes: "Reads legacy job_postings mirror; mirror stays senior-only (U6 blocks childcare writes).",
  },
  {
    consumerName: "components/client/booking/BookingFlow",
    sourceFile: "components/client/booking/BookingFlow.tsx",
    collections: ["publicCaregiverProfiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "components/client/postJob/PostJobFlow",
    sourceFile: "components/client/postJob/PostJobFlow.tsx",
    collections: ["job_postings"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "components/client/postJob/Step2WhoWhere",
    sourceFile: "components/client/postJob/Step2WhoWhere.tsx",
    collections: ["job_postings", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "components/landing/FeaturedCaregiversSection",
    sourceFile: "components/landing/FeaturedCaregiversSection.tsx",
    collections: ["publicCaregiverProfiles"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },

  // ── functions/src/admin ──
  {
    consumerName: "functions/src/admin/adminCaregiverActions",
    sourceFile: "functions/src/admin/adminCaregiverActions.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "functions/src/admin/adminLedgerActions",
    sourceFile: "functions/src/admin/adminLedgerActions.ts",
    collections: ["admin_alerts", "agent_action_ledger"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "functions/src/admin/adminRecoveryActions",
    sourceFile: "functions/src/admin/adminRecoveryActions.ts",
    collections: ["admin_alerts", "agent_action_ledger"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "functions/src/admin/adminSupportActions",
    sourceFile: "functions/src/admin/adminSupportActions.ts",
    collections: ["admin_alerts", "notifications", "shiftHours", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "functions/src/admin/adminUserActions",
    sourceFile: "functions/src/admin/adminUserActions.ts",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "functions/src/admin/requireAdmin",
    sourceFile: "functions/src/admin/requireAdmin.ts",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
    notes: "Broad admin gate; U12 adds scoped operator roles — broad admin must NOT grant child-safety reads.",
  },
  {
    consumerName: "functions/src/admin/requireOperatorScope",
    sourceFile: "functions/src/admin/requireOperatorScope.ts",
    collections: ["childcare_operators", "agent_audit_log"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
    notes:
      "U13 hardened least-privilege operator gate. Every child-safety, child-billing, child-support, child-screening, and general scope requires an explicit active grant; broad isAdmin has no fallback. Sensitive access requires recent auth, an allowlisted structured reason code, opaque action/object tokens, and a fail-closed versioned six-year security audit row.",
  },

  // ── functions/src/adminAlerts.ts ──
  {
    consumerName: "functions/src/adminAlerts",
    sourceFile: "functions/src/adminAlerts.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },

  // ── functions/src/agents ──
  {
    consumerName: "functions/src/agents/actions/getCaregiverPreviewAction",
    sourceFile: "functions/src/agents/actions/getCaregiverPreviewAction.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "functions/src/agents/availabilityHandler",
    sourceFile: "functions/src/agents/availabilityHandler.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "functions/src/agents/bereavement",
    sourceFile: "functions/src/agents/bereavement.ts",
    collections: ["users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Senior-domain bereavement flow.",
  },
  {
    consumerName: "functions/src/agents/bookingExecutor",
    sourceFile: "functions/src/agents/bookingExecutor.ts",
    collections: ["admin_alerts", "appointments", "caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: hasConflict exported as the shared cross-vertical conflict gate (childcare appointments live in the same collection with the same blocking statuses, so senior bookings cannot land on confirmed childcare visits); executeBookings gains a defensive careVertical=='child' guard (task marked failed + admin alert - the SMS pipeline is senior-only until U10). Senior behavior byte-identical."
  },
  {
    consumerName: "functions/src/agents/buildJobPost",
    sourceFile: "functions/src/agents/buildJobPost.ts",
    collections: ["job_postings", "job_posts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "Legacy SENIOR job pipeline (Evia + web). U6 DONE: assertLegacyJobMirrorAllowed structural guard rejects childcare-vertical input before the job_postings singleton mirror write (R32); childcare jobs are created exclusively by childcare/jobCallables.",
  },
  {
    consumerName: "functions/src/agents/caraAgent",
    sourceFile: "functions/src/agents/caraAgent.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/carePlanInterview",
    sourceFile: "functions/src/agents/carePlanInterview.ts",
    collections: ["caregivers", "job_applications", "job_posts"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Post-payment senior care-plan interview; childcare has no care-plan interview flow.",
  },
  {
    consumerName: "functions/src/agents/careRecipients",
    sourceFile: "functions/src/agents/careRecipients.ts",
    collections: ["senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U2",
    notes: "Review-named seam: resolveRecipientKey/describeWhoIsWho/recipientMedical — U2 extends with the typed recipient union (no parallel resolution seam).",
  },
  {
    consumerName: "functions/src/agents/caregiverBriefing",
    sourceFile: "functions/src/agents/caregiverBriefing.ts",
    collections: ["caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Pre-shift briefing built from senior context; childcare briefing is new U8/U9 work if ever enabled.",
  },
  {
    consumerName: "functions/src/agents/caregiverCancelShiftHandler",
    sourceFile: "functions/src/agents/caregiverCancelShiftHandler.ts",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: childcare appointments filtered out of the SMS cancel list (web-redirect message when only childcare exists) + belt guard before the cancel write — a childcare visit can never be SMS-canceled. Childcare cancels flow through v1-cancelChildcareBooking; Evia childcare flows are U10. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/agents/caregiverProfileHandler",
    sourceFile: "functions/src/agents/caregiverProfileHandler.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
  },
  {
    consumerName: "functions/src/agents/caregiverReferral",
    sourceFile: "functions/src/agents/caregiverReferral.ts",
    collections: ["admin_alerts", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/caregiverSwapHandler",
    sourceFile: "functions/src/agents/caregiverSwapHandler.ts",
    collections: ["appointments", "caregivers", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: childcare appointments never enter the SMS swap flow (filtered at identify_shift; web-redirect message when only childcare exists). Childcare substitution is v1-substituteChildcareCaregiver (revoke-first, eligibility-gated); Evia childcare flows are U10. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/agents/clientShiftConfirmHandler",
    sourceFile: "functions/src/agents/clientShiftConfirmHandler.ts",
    collections: ["admin_alerts", "appointments", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "functions/src/agents/clientSwapRequestHandler",
    sourceFile: "functions/src/agents/clientSwapRequestHandler.ts",
    collections: ["appointments", "caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: childcare appointments never enter the family SMS swap flow (filtered at identify_appointment; web-redirect message when only childcare exists). Childcare substitution is v1-substituteChildcareCaregiver; Evia childcare flows are U10. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/agents/commitmentTracker",
    sourceFile: "functions/src/agents/commitmentTracker.ts",
    collections: ["admin_alerts", "agent_conversations"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/confidenceScore",
    sourceFile: "functions/src/agents/confidenceScore.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/contextManagement",
    sourceFile: "functions/src/agents/contextManagement.ts",
    collections: ["agent_conversations"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "agent_conversations compression — memory subsystem; childcare turns are memory-denied until U10 eligibility work.",
  },
  {
    consumerName: "functions/src/agents/earningsHandler",
    sourceFile: "functions/src/agents/earningsHandler.ts",
    collections: ["appointments", "caregivers", "shiftHours"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "functions/src/agents/familyGroupManager",
    sourceFile: "functions/src/agents/familyGroupManager.ts",
    collections: ["family_group_members", "family_groups", "senior_profiles", "users"],
    disposition: "legacy-compat-remove-after-migration",
    ownerUnit: "U2",
    notes: "Legacy phone-keyed family groups. A recycled phone number satisfies the phone-in-list rule, so these readers stay senior-only until U2 replaces them with membership-record authority; no child-vertical data may flow through them.",
  },
  {
    consumerName: "functions/src/agents/feedbackAggregator",
    sourceFile: "functions/src/agents/feedbackAggregator.ts",
    collections: ["admin_alerts", "caregivers", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Senior visit-feedback aggregation; childcare reviews flow through U8 review pipeline.",
  },
  {
    consumerName: "functions/src/agents/gpsCheckin",
    sourceFile: "functions/src/agents/gpsCheckin.ts",
    collections: ["appointments", "senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: additive guarded branch - careVertical=='child' appointments delegate to childcare/bookingCallables.checkInChildcareBookingCore (assigned caregiver + current access version + booking state) and record a coordinates-free shift_checkins row (no senior_profiles read, no child location data stored or logged - R57). Senior GPS path byte-identical."
  },
  {
    consumerName: "functions/src/agents/instantPayoutHandler",
    sourceFile: "functions/src/agents/instantPayoutHandler.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "functions/src/agents/intelligenceCanaryWatch",
    sourceFile: "functions/src/agents/intelligenceCanaryWatch.ts",
    collections: ["admin_alerts", "agent_action_ledger"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },
  {
    consumerName: "functions/src/childcare/childcareCanaryWatch",
    sourceFile: "functions/src/childcare/childcareCanaryWatch.ts",
    collections: [
      "admin_alerts", "childcare_incidents", "data_lifecycle_requests",
      "learned_facts", "memory_embeddings", "memory_operations", "childcare_canary_state",
    ],
    disposition: "child-specific",
    ownerUnit: "U13",
    notes: "U13 privacy-safe canary. Reads COUNTS only (never documents/child fields); memory-store scans (careVertical==child) assert the R50 zero-breach invariant; writes deduped content-free admin_alerts + the rollout-HOLD signal in childcare_canary_state (synthetic identifiers only). DARK: the scheduled export no-ops unless CHILDCARE_ENABLED. Alert/state payloads pass childcare/privacyAssertions.assertMetricPayloadChildSafe.",
  },
  {
    consumerName: "functions/src/agents/interviewAgent",
    sourceFile: "functions/src/agents/interviewAgent.ts",
    collections: ["appointments", "caregivers", "interview_requests", "interviews", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "functions/src/agents/issueEscalator",
    sourceFile: "functions/src/agents/issueEscalator.ts",
    collections: ["admin_alerts", "agent_conversations", "senior_profiles"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U12",
    notes: "Senior issue escalation; childcare incidents use deterministic childcare_incidents routing (U12), never model judgment.",
  },
  {
    consumerName: "functions/src/agents/jobMatchRecommender",
    sourceFile: "functions/src/agents/jobMatchRecommender.ts",
    collections: ["caregivers", "job_posts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "functions/src/agents/latenessTracker",
    sourceFile: "functions/src/agents/latenessTracker.ts",
    collections: ["admin_alerts", "appointments", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "functions/src/agents/liveGateFacts",
    sourceFile: "functions/src/agents/liveGateFacts.ts",
    collections: ["caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
  },
  {
    consumerName: "functions/src/agents/matchingAgent",
    sourceFile: "functions/src/agents/matchingAgent.ts",
    collections: ["admin_alerts", "caregivers", "interview_requests"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guarded branch DONE: a typed childcare intake FAILS CLOSED at the top of runMatchingForClient (admin_alert + 'failed', no sends) — this senior SMS pool has no childcare eligibility gate (R34). Childcare candidate retrieval is childcare/matchingEligibility; the childcare SMS conversation surface is U10/U11. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/agents/modifyScheduleFlow",
    sourceFile: "functions/src/agents/modifyScheduleFlow.ts",
    collections: ["appointments", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: defensive childcare skip in the cancellation loop (SMS schedule modification is senior-only; childcare-stamped appointments are never mutated). Senior path byte-identical."
  },
  {
    consumerName: "functions/src/agents/onboardingConversation",
    sourceFile: "functions/src/agents/onboardingConversation.ts",
    collections: ["admin_alerts", "caregivers", "job_posts", "senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U4",
    notes: "U4/U5 add typed role/vertical intent; U4 and U5 both edit this file — sequential only.",
  },
  {
    consumerName: "functions/src/agents/operationalContext",
    sourceFile: "functions/src/agents/operationalContext.ts",
    collections: ["admin_alerts", "agent_action_ledger", "appointments", "caregivers", "family_groups", "invoices", "payouts", "shiftHours"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/pauseAccount",
    sourceFile: "functions/src/agents/pauseAccount.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/permissionsConversation",
    sourceFile: "functions/src/agents/permissionsConversation.ts",
    collections: ["admin_alerts"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U2",
    notes: "Senior family-permission steps; childcare authority is U2 guardian-authority model, not this flow.",
  },
  {
    consumerName: "functions/src/agents/qaAgent",
    sourceFile: "functions/src/agents/qaAgent.ts",
    collections: ["admin_alerts", "agent_conversations", "appointments", "caregivers", "shiftHours", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/refundHandler",
    sourceFile: "functions/src/agents/refundHandler.ts",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: childcare appointments never enter the SMS refund flow (filtered at identify_visit; web-redirect message when only childcare exists). Childcare refunds are policy-driven via v1-requestChildcareRefund into the shared refundRequests machine; the childcare Evia refund conversation is U10. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/agents/replacementAgent",
    sourceFile: "functions/src/agents/replacementAgent.ts",
    collections: ["admin_alerts", "caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: runEmergencyReplacement fails closed on a childcare appointment (admin_alert childcare_replacement_needed, no senior scorer/SMS pipeline). Childcare substitution is v1-substituteChildcareCaregiver; human coordinates emergency childcare coverage until U10. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/agents/replacementScorer",
    sourceFile: "functions/src/agents/replacementScorer.ts",
    collections: ["appointments", "caregivers", "senior_profiles"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "Reads senior_profiles for scoring context; typed recipient union required.",
  },
  {
    consumerName: "functions/src/agents/shiftOffer",
    sourceFile: "functions/src/agents/shiftOffer.ts",
    collections: ["appointments"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: defensive childcare skips in handleShiftOfferReply and expireShiftOffers (childcare bookings never create shift_offers in this unit; a childcare-stamped offer is never resolved through senior side effects). Senior path byte-identical."
  },
  {
    consumerName: "functions/src/agents/shiftTimeChange",
    sourceFile: "functions/src/agents/shiftTimeChange.ts",
    collections: ["admin_alerts", "appointments", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: careVertical=='child' guard fails closed (status 'failed', reason childcare_web_only) - childcare schedule changes are v1-requestChildcareBookingChange with full revalidation. Senior path byte-identical."
  },
  {
    consumerName: "functions/src/agents/situationSnapshot",
    sourceFile: "functions/src/agents/situationSnapshot.ts",
    collections: ["appointments", "interview_requests", "job_applications", "job_posts", "shiftHours"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/taskApprovalHandler",
    sourceFile: "functions/src/agents/taskApprovalHandler.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/agents/timesheetHandler",
    sourceFile: "functions/src/agents/timesheetHandler.ts",
    collections: ["caregivers", "shiftHours"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: childcare shiftHours rows never enter the SMS timesheet-approval flow (filtered at start; web-redirect message when only childcare rows are pending), and approveShiftHoursForClient (the iMessage APPROVE writer) skips childcare rows. Childcare hours approve in-app/web or auto-approve after the delivered in-app notice; the childcare Evia timesheet conversation is U10. Senior path byte-identical.",
  },

  // ── functions/src/ai ──
  {
    consumerName: "functions/src/ai/caregiverReputation",
    sourceFile: "functions/src/ai/caregiverReputation.ts",
    collections: ["caregiver_reputation"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "Review-named seam — U6 DONE: reputation is per-vertical (R45). Senior keeps the original unprefixed fields byte-identically (default vertical='senior' on every reader/writer); childcare outcomes land in child-prefixed fields. Childcare MATCHING consumes no hire/pass reputation boost (scoreChildcareCandidate has no reputation input). U8 DONE: the childcare outcome writers are live — confirmChildcareBookingIfReady records the child-vertical hire outcome exactly once per confirm, and childcare/reputationProjection merges the child-prefixed aggregate fields onto the same doc; the childcare scorer's only reputation input is the per-vertical childcareRating from the U8 projection.",
  },
  {
    consumerName: "functions/src/ai/feedback",
    sourceFile: "functions/src/ai/feedback.ts",
    collections: ["match_history", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "Review-named seam: match_history feedback writes; needs vertical stamp so learning never crosses verticals.",
  },
  {
    consumerName: "functions/src/ai/matchJob",
    sourceFile: "functions/src/ai/matchJob.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guarded branch DONE: computeMatchesForIntake delegates typed-childcare intakes to childcare/matchingEligibility.computeChildcareMatchesForIntake (hard filter → approved-feature scoring, no embeddings/reputation). Senior intakes byte-identical.",
  },
  {
    consumerName: "functions/src/ai/outcomeAnalytics",
    sourceFile: "functions/src/ai/outcomeAnalytics.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "Review-named seam: outcome analytics over caregivers/matches; per-vertical aggregation required.",
  },

  // ── functions/src/aiMatching.ts ──
  {
    consumerName: "functions/src/aiMatching",
    sourceFile: "functions/src/aiMatching.ts",
    collections: ["caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guarded branch DONE: runAiMatching routes typed-childcare assignments/intakes through the childcare hard-eligibility seam and rule scorer (Claude receives nothing; no senior verified pool). Senior assignments byte-identical.",
  },

  // ── functions/src/appointmentCompletion.ts ──
  {
    consumerName: "functions/src/appointmentCompletion",
    sourceFile: "functions/src/appointmentCompletion.ts",
    collections: ["appointments"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: guarded childcare branch — childcare visits are NEVER wall-clock auto-completed (completion feeds capture; only a real check-out completes one). Overdue childcare visits route to childcare/shiftPayments.handleOverdueChildcareVisit (awaiting_checkout / missed_visit_review policy states, no charge). Senior completion path byte-identical.",
  },

  // ── functions/src/billing ──
  {
    consumerName: "functions/src/billing/approvalNoticeDispatcher",
    sourceFile: "functions/src/billing/approvalNoticeDispatcher.ts",
    collections: ["shiftHours", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8: STRUCTURALLY senior-only at runtime — childcare validated-hours rows never create a billingApprovalOutbox record (their approval notice is a generic in-app notification written by childcare/shiftPayments; approvalNoticeState is set to delivered on the same field the auto-approve gate reads). No code change; the skip is by construction.",
  },
  {
    consumerName: "functions/src/billing/createValidatedShiftHours",
    sourceFile: "functions/src/billing/createValidatedShiftHours.ts",
    collections: ["appointments", "shiftHours"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: fails closed (not_billable) on a childcare appointment for EVERY senior timesheet source (web/mcp/care_note/agent/recurring) — childcare hours are server-derived at check-out by childcare/shiftPayments.createChildcareValidatedShiftHoursForToday. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/billing/paymentOperation",
    sourceFile: "functions/src/billing/paymentOperation.ts",
    collections: ["shiftHours"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE (no code change needed): the billingOperations lease/attempt ledger is vertical-agnostic by construction — childcare rows reuse it unchanged for the AE15 one-effect-per-retry guarantee (shift-payment:{occurrenceId}:generation:{g} keys).",
  },
  {
    consumerName: "functions/src/billing/taxDocuments",
    sourceFile: "functions/src/billing/taxDocuments.ts",
    collections: ["payouts", "shiftHours"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },

  // ── functions/src/caregiverCallout.ts ──
  {
    consumerName: "functions/src/caregiverCallout",
    sourceFile: "functions/src/caregiverCallout.ts",
    collections: ["appointments", "caregivers", "notifications", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: all three active callables (selectBackupCaregiver, requestCalloutRefund, getBackupCaregiverOptions) fail closed on a childcare appointment with a web-redirect precondition — childcare substitution/refunds flow through the childcare callables. onCaregiverCallout remains an inert shim. Senior path byte-identical.",
  },

  // ── functions/src/caregiverPrivate.ts ──
  {
    consumerName: "functions/src/caregiverPrivate",
    sourceFile: "functions/src/caregiverPrivate.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
  },

  // ── functions/src/caregiverProfileMeta.ts ──
  {
    consumerName: "functions/src/caregiverProfileMeta",
    sourceFile: "functions/src/caregiverProfileMeta.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
  },

  // ── functions/src/caregiverPublicProjection.ts ──
  {
    consumerName: "functions/src/caregiverPublicProjection",
    sourceFile: "functions/src/caregiverPublicProjection.ts",
    collections: ["caregivers", "publicCaregiverProfiles"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
  },

  // ── functions/src/checkr.ts ──
  {
    consumerName: "functions/src/checkr",
    sourceFile: "functions/src/checkr.ts",
    collections: ["admin_alerts", "caregivers", "notifications", "users", "screenings"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
    notes: "Shared base Checkr package across verticals (founder decision). U5 DONE: after the unchanged senior handling, the webhook fans out to caregivers/{uid}/screenings/child via providerEligibility.mirrorCheckrEventToChildcareScreening — provider-ID-matched, doc-level idempotent, fully guarded (a childcare failure never affects the senior outcome), and evidence-only (never approval, R27).",
  },

  // ── functions/src/childcare (U1 — the first child-specific consumers) ──
  {
    consumerName: "functions/src/childcare/jurisdictionPolicy",
    sourceFile: "functions/src/childcare/jurisdictionPolicy.ts",
    collections: ["jurisdiction_care_policies"],
    disposition: "child-specific",
    ownerUnit: "U1",
    notes: "Versioned jurisdiction policy loader/validator (R23-R31/R40/R58). Read-only, fail-closed readiness gate; deferred categories hard-blocked. Client mutation denial is U2 Rules work.",
  },

  // ── functions/src/childcare (U2 — household / guardian authority) ──
  {
    consumerName: "functions/src/childcare/householdRepository",
    sourceFile: "functions/src/childcare/householdRepository.ts",
    collections: ["households", "household_memberships", "guardian_authorities"],
    disposition: "child-specific",
    ownerUnit: "U2",
    notes: "Canonical household + membership CRUD (R3/R7). Membership grants NOTHING (AE4); provisional phone-only members hold zero grantable scopes. Derived summaries are versioned caches, never authorizing.",
  },
  {
    consumerName: "functions/src/childcare/guardianAuthority",
    sourceFile: "functions/src/childcare/guardianAuthority.ts",
    collections: [
      "guardian_authorities",
      "guardianAuthorityOutbox",
      "households",
      "household_memberships",
      "childcare_invite_tokens",
      "admin_alerts",
      "agent_audit_log",
      "users",
      "child_profiles",
    ],
    disposition: "child-specific",
    ownerUnit: "U2",
    notes: "THE authority source (R6/KTD3): checkAuthority permission primitive, grant/scope/revoke with access versions, R18 co-guardian dispute-hold + durable notice/invalidation outbox (approvalNoticeDispatcher pattern). Reads users only to resolve the affected adult notice phone. U3: the derived-access-invalidation effect also refreshes the child_profiles viewer cache (lazy repository import).",
  },
  {
    consumerName: "functions/src/childcare/authorityCallables",
    sourceFile: "functions/src/childcare/authorityCallables.ts",
    collections: [
      "households",
      "household_memberships",
      "guardian_authorities",
      "childcare_invite_tokens",
      "childcare_flags",
      "child_profiles",
    ],
    disposition: "child-specific",
    ownerUnit: "U2",
    notes: "v1 household/authority callables (createHousehold, invite/accept, grant/update/revoke, getMyHouseholdState) with App Check (KTD22), auth_time recent-auth (R18), fail-closed rate limits, idempotency keys, and enumeration-safe errors (R21). Gated on the Firestore-resident childcare flags (R61). U3: refreshes the child_profiles authorizedViewerUids derived cache (lazy repository import) after authority changes.",
  },

  // ── functions/src/childcare + data + privacy + scheduled (U3 — child
  // profiles, restricted files, privacy lifecycle) ──
  {
    consumerName: "functions/src/data/childProfileRepository",
    sourceFile: "functions/src/data/childProfileRepository.ts",
    collections: ["child_profiles", "guardian_authorities", "households", "household_memberships", "admin_alerts"],
    disposition: "child-specific",
    ownerUnit: "U3",
    notes: "Canonical child data zones (R9-R16): operational summary (band only — exact DOB lives ONLY in the private safety versions), immutable safety versions + current pointer, version-stamped authorizedViewerUids derived cache (R6 — display read only), age-band recalc + EXPLICIT aged_out transition (R16, admin_alerts row), legal holds, lifecycle tombstone/redaction support. Structural no-child-contact guard (assertNoChildIdentityContactFields). Bootstraps the first authority via guardianAuthority.bootstrapPrimaryGuardianAuthority.",
  },
  {
    consumerName: "functions/src/childcare/consentReceipts",
    sourceFile: "functions/src/childcare/consentReceipts.ts",
    collections: ["consent_receipts", "agent_audit_log"],
    disposition: "child-specific",
    ownerUnit: "U4",
    notes: "Versioned consent receipts (R23): deterministic-ID create-once writes; unpopulated policy versions record the pending-policy-version state (activation still blocked by the U1 readiness evaluator); STOP revokes communicationConsent via revokedAt stamps. Adult uid + policy identifiers only — never child PII (R57).",
  },
  {
    consumerName: "functions/src/childcare/signupIngress",
    sourceFile: "functions/src/childcare/signupIngress.ts",
    collections: ["agent_audit_log"],
    disposition: "child-specific",
    ownerUnit: "U4",
    notes: "Family childcare signup ingress: the narrow seam linq/webhooks.ts calls on a typed childcare bridge doc / childcare-stamped session. Stamps agent_sessions careVertical/verticalIntent, creates the ONE deterministic family enrollment objective (agent_objectives, AE15), records consent receipts, sends static routing/link messages only (no LLM, no child PII), and NEVER initializes memory (R48/R50).",
  },
  {
    consumerName: "functions/src/childcare/identityCallables",
    sourceFile: "functions/src/childcare/identityCallables.ts",
    collections: ["childcare_identity_sessions", "childcare_identity_callbacks", "agent_audit_log"],
    disposition: "child-specific",
    ownerUnit: "U4",
    notes: "Stripe Identity gate (R17/R22): one verification session per childcare objective (idempotent reuse; only canceled is replaced), one-time expiring callback states bound to the authenticated adult, webhook status mirror. Stripe metadata carries firebaseUID + childcareObjectiveId ONLY — no phone, no child PII (R57).",
  },
  // ── functions/src/childcare (U5 — provider vertical profile, screening,
  // eligibility) ──
  {
    consumerName: "functions/src/childcare/screeningPolicy",
    sourceFile: "functions/src/childcare/screeningPolicy.ts",
    collections: ["caregivers", "screenings"],
    disposition: "child-specific",
    ownerUnit: "U5",
    notes:
      "Per-vertical screening evidence (amended R26/R27/KTD10): pure evaluation (components/jurisdiction/report age/expiry/adverse action), credential lifecycle, shared-base-package sentinel via jurisdictionPolicy, and the provider-ID-matched, doc-level-idempotent Checkr event application. Writes ONLY caregivers/{uid}/screenings/child — never a senior field. Checkr states are evidence, never approval.",
  },
  {
    consumerName: "functions/src/childcare/providerEligibility",
    sourceFile: "functions/src/childcare/providerEligibility.ts",
    collections: ["caregivers", "vertical_profiles", "screenings", "admin_alerts", "users", "childcare_flags", "jurisdiction_care_policies"],
    disposition: "child-specific",
    ownerUnit: "U5",
    notes:
      "THE childcare visibility gate (R28): evaluateChildcareProviderEligibility structured-issue evaluator + eligibility version stamp, the R29 recheck seam for U6-U8 (payout-sensitive contexts add payout readiness), the derived childcareProvider parent-doc summary (the ONLY parent field childcare writes — R24; senior-only docs stay byte-identical, AE9), the checkr.ts webhook mirror seam, and the flag-gated screening expiry sweep (R31 — removes childcare visibility, never senior eligibility). Renewal notices via users/{uid}/notifications + admin_alerts.",
  },
  {
    consumerName: "functions/src/childcare/providerVerticalCallables",
    sourceFile: "functions/src/childcare/providerVerticalCallables.ts",
    collections: ["caregivers", "vertical_profiles", "screenings", "childcare_flags", "consent_receipts", "jurisdiction_care_policies"],
    disposition: "child-specific",
    ownerUnit: "U5",
    notes:
      "v1 provider callables (upsertChildcareVerticalProfile, getMyChildcareProviderState, acceptChildcarePolicy, startChildcareScreening [Checkr candidate reuse + shared-base-evidence adoption, AE21], approveChildcareProvider/suspendChildcareProvider) with the full U2/U3 middleware stack. U12 REPLACED the U5 operator-scope stub: approve/suspend now require the childSafetyOperator scope via admin/requireOperatorScope (R55/AE18 — broad isAdmin alone is DENIED); recent-auth stays enforced at the call sites. Deferred service categories hard-blocked at input validation.",
  },
  // ── functions/src/agents (front door STAGE 2 — the conversational childcare
  // caregiver funnel; docs/architecture/childcare-front-door-design.md) ──
  {
    consumerName: "functions/src/agents/childcareCaregiverEnrollment",
    sourceFile: "functions/src/agents/childcareCaregiverEnrollment.ts",
    collections: ["caregivers", "vertical_profiles", "screenings", "childcare_flags", "consent_receipts", "jurisdiction_care_policies"],
    disposition: "child-specific",
    ownerUnit: "U5",
    notes:
      "Front door Stage 2: the SMS funnel's enrollment wiring. Reaches the U5 SERVER SIDE (providerEligibility / screeningPolicy / jurisdictionPolicy / consentReceipts) rather than the v1 callable HTTP surface, because an SMS turn has no App Check token and no CallableContext — forging one would defeat the guards those callables exist to enforce. Same document, same path, same schema the callable writes, so the U11 web page, the U6-U8 recheck seam, and the operator queue all see ONE enrollment regardless of surface. Invariants preserved verbatim from U5: MANUAL approval is never granted here (approval/suspension are read-only preserved fields, R27/R28); deferred categories hard-blocked via assertEnableableChildcareCategory; consent-FIRST screening on the SHARED base Checkr package with candidate reuse and shared-base-report adoption (AE21); writes/reads gated on the Firestore-resident flags (R61, fail closed); the ONLY parent-doc field written is the namespaced childcareProvider summary, inside recomputeChildcareProviderVisibility (R24). ensureChildcareCaregiverBaseDoc creates a childcare-first caregiver's base account with identity/contact/logistics ONLY — never hourlyRate, services, skills, specialties, jobType, or any verification/approval field.",
  },
  {
    consumerName: "functions/src/agents/childcareCaregiverFunnelTurn",
    sourceFile: "functions/src/agents/childcareCaregiverFunnelTurn.ts",
    // `agent_sessions` is deliberately absent: it is not a watched shared
    // collection (it is per-phone conversation state, not recipient data), and
    // the funnel's ONLY write there is its own `childcareCaregiverFunnel` field.
    collections: ["caregivers", "vertical_profiles"],
    disposition: "child-specific",
    ownerUnit: "U5",
    notes:
      "Front door Stage 2: ONE inbound text on a caregiver childcare session, replacing Stage 1's childcare_caregiver_hold stub. Reads caregivers/{uid} and caregivers/{uid}/vertical_profiles/child ONLY to compute what is still missing (providerEligibility.computeMissingChildcareFields is the single source of truth, AE21) — it never writes either; enrollment writes go through childcareCaregiverEnrollment. The only doc it writes is agent_sessions/{phone}.childcareCaregiverFunnel, its own state namespace, which is what lets a dual-vertical ADDITION run beside an untouched senior session (R-FD6). Stage 1 ordering preserved: incident classification and the flags gate stay upstream in childcare/signupIngress.ts. No memory writes ever (R50/AE23); the closed childcare field set drops any field injected text tries to add (AE19); no senior tool surface is reachable.",
  },
  {
    consumerName: "functions/src/childcare/jobCallables",
    sourceFile: "functions/src/childcare/jobCallables.ts",
    collections: ["job_posts", "job_applications", "video_interviews", "caregivers", "vertical_profiles", "users", "notifications", "childcare_identity_sessions", "childcare_flags", "jurisdiction_care_policies"],
    disposition: "child-specific",
    ownerUnit: "U6",
    notes:
      "v1 childcare job/application/interview callables (createChildcareJobPost, updateChildcareJobPost, closeChildcareJobPost, listMyChildcareJobs, applyToChildcareJob, listEligibleChildcareJobs, requestChildcareInterview) with the full U2/U3 middleware stack. Contracts: auto-ID job_posts only, NEVER the legacy job_postings mirror (R32); stored docs ARE the safe public projection — age bands/approximate area/schedule/rate/requirements only, child linkage in the server-only private/children subdoc (R33/AE12); hard eligibility (R29 contexts discovery/application/contact/interview) precedes discovery results, application writes, the eligibility-gated in-app notification fan-out, and interview creation (R34/KTD11); interviews adult-to-adult, vertical-stamped, generic-content (R35); deferred categories + infant age band hard-blocked at creation.",
  },
  // ── functions/src/childcare (U7 — booking, appointments, availability,
  // and safety projection) ──
  {
    consumerName: "functions/src/childcare/bookingPolicy",
    sourceFile: "functions/src/childcare/bookingPolicy.ts",
    collections: [],
    disposition: "child-specific",
    ownerUnit: "U7",
    notes:
      "PURE childcare booking state machine (R36-R40): status graph (requested/accepted/confirmed/in_progress/completed/declined/canceled), actor-gated transitions, idempotent transitionKey replay, stale stateVersion fail-closed, payment-authorization gate on confirm (AE14 — no code path to 'confirmed' without paymentAuthorization.state=='authorized'), truthful status copy, overnight detection (deferred category), overlap/recurrence primitives. No Firestore access — bookingCallables owns the async gates.",
  },
  {
    consumerName: "functions/src/childcare/bookingCallables",
    sourceFile: "functions/src/childcare/bookingCallables.ts",
    collections: ["booking_requests", "appointments", "shifts", "job_posts", "job_applications", "caregivers", "users", "notifications", "child_profiles", "childcare_booking_safety", "childcare_identity_sessions", "childcare_flags", "admin_alerts"],
    disposition: "child-specific",
    ownerUnit: "U7",
    notes:
      "v1 childcare booking callables (requestChildcareBooking, accept/decline, cancel, requestChildcareBookingChange + respond, substituteChildcareCaregiver, checkIn/checkOutChildcareShift, getChildcareBookingSafety, accept/rejectChildcareApplication — the U6 deferral) with the full U2/U3 middleware stack. Contracts: R36 confirmation order with actionEvidence fresh-read postconditions; R29 rechecks at booking_request/acceptance/substitution/check_in/safety_read; cross-vertical conflict gate both directions (shared appointments Q38 + childcare bookings Q34); revoke-before-replace on cancel/substitute (AE6 — the committed intermediate revoked state is observable); appointments/shifts materialized server-only with canonicalApptFields+childcareApptFields (typed references + display label only, R46; no billingAuthority — money is U8); recordChildcareBookingPaymentAuthorization is the documented U8 payment seam (state + correlation IDs only); generic child-safe notifications (R43). Also the guarded-branch target for shiftGenerator (handleChildcareBookingRequestWrite, ensureChildcareRollingShifts, sweepChildcareRollingShifts) and gpsCheckin (checkInChildcareBookingCore).",
  },
  {
    consumerName: "functions/src/childcare/shiftGenerationOperations",
    sourceFile: "functions/src/childcare/shiftGenerationOperations.ts",
    collections: ["booking_requests", "admin_alerts"],
    disposition: "child-specific",
    ownerUnit: "U7",
    notes:
      "Durable childcare shift-generation operation ledger behind the U7 booking state machine: enqueue (standalone or in the confirming transaction) writes a deterministic csg_ operation keyed on bookingId + schedule version into childcare_shift_generation_operations (collection not in the watch list), and the leased worker re-reads booking_requests and SKIPS anything that is not careVertical=='child' in confirmed/in_progress at a schedule version that is still current — a superseded or senior booking can never generate shifts. Shift materialization itself is delegated to childcare/bookingCallables.generateChildcareShiftsForBooking (which owns the appointments/shifts writes); this module only owns the retry/lease state, the bounded backoff, and the admin_alerts childcare_shift_generation_retry_exhausted escalation. reconcileAndProcessChildcareShiftGeneration is the every-15-minutes scheduler (processChildcareShiftGeneration) and records a childcare_reconciliation_runs summary (collection not in the watch list).",
  },
  {
    consumerName: "functions/src/childcare/familyReadCallables",
    sourceFile: "functions/src/childcare/familyReadCallables.ts",
    collections: [
      "booking_requests",
      "job_posts",
      "job_applications",
      "households",
      "household_memberships",
      "guardian_authorities",
      "users",
      "childcare_flags",
    ],
    disposition: "child-specific",
    ownerUnit: "U11",
    notes:
      "v1 family-facing READ seams the U11 UI wired (listMyChildcareBookings, getChildcareBooking, listChildcareJobApplications, listHouseholdMembers) with the full U2/U3/U7 read middleware stack (App Check, Firestore-resident flags read gate, fail-closed rate limits, enumeration-safe errors). Thin authorization-correct reads: guardian authority is THE primitive (checkAuthority/getAuthority against the authority record, NEVER a derived cache — R6); equality-only queries + in-memory vertical filter/sort (no new composite index); family-safe booking projection (display label only — never DOB or exact address, both of which live behind the assigned-caregiver-only getChildcareBookingSafety/getChildcareBookingCoordination reads); the U6 public application projection (projectChildcareApplicationPublic) plus the U6 eligibility hard-filter dropping ineligible PENDING candidates (R34/KTD11); and the manager-only (primary adult or live management scope) household-member enumeration getMyHouseholdState deliberately omits — a non-manager active member gets their own record only (stricter R7/R18 reading), a non-member gets the generic permission error. Member rows carry adult display names (adult data, not child data); the childSafe outbound assertion is intentionally not applied to them.",
  },
  {
    consumerName: "functions/src/childcare/safetyProjection",
    sourceFile: "functions/src/childcare/safetyProjection.ts",
    collections: ["childcare_booking_safety", "booking_requests", "child_profiles"],
    disposition: "child-specific",
    ownerUnit: "U7",
    notes:
      "Versioned booking safety projections (KTD13/R38): immutable minimum versions built from the private safety zone via an explicit field allowlist (display label, age band, pickup notes, emergency contacts, care notes — NEVER DOB/custody/address), participant accessVersion bumped atomically with every new version (revoke-before-replace by construction, AE6), gated caregiver read (assigned + active pointer + current booking state + provider eligibility context safety_read + exact access-version match + live source-safety-version staleness check), authority-change fan-out target for the guardianAuthority outbox (reprojectActiveBookingSafetyForChild — R19/AE20), and the REAL AssignedProviderEligibilitySource that replaced the U3 dark stub in childFileAccess (assigned + current version = file grants). Queries Q36/Q37.",
  },
  {
    consumerName: "functions/src/childcare/conversationPolicy",
    sourceFile: "functions/src/childcare/conversationPolicy.ts",
    collections: ["chatRooms"],
    disposition: "child-specific",
    ownerUnit: "U9",
    notes:
      "Context-keyed childcare conversation model (KTD14/R41-R42): deterministic cchat_ room keys (vertical + interview|booking context + participant set — same pair senior+child gets separate rooms, AE5; replacement caregiver gets a NEW key by construction), server-owned lifecycle (create-once, participant removal, booking revoke, household authority fan-out, disclosure-phase advance — every change bumps accessVersion), pinned message-doc key set (structural no-safety-injection: imports NEITHER safetyProjection NOR childProfileRepository — static-scanned), generic-only room metadata (lastMessage never carries text), and the AE24 excludedUids fan-out hook. Query Q43.",
  },
  {
    consumerName: "functions/src/childcare/conversationCallables",
    sourceFile: "functions/src/childcare/conversationCallables.ts",
    collections: ["chatRooms", "booking_requests", "video_interviews", "job_posts", "caregivers", "users", "childcare_flags", "childcare_booking_safety", "child_profiles", "guardian_authorities"],
    disposition: "child-specific",
    ownerUnit: "U9",
    notes:
      "v1 childcare conversation callables (openChildcareConversation, sendChildcareMessage, listMyChildcareConversations, getChildcareConversationMessages, markChildcareConversationRead, getChildcareBookingCoordination) with the full U2/U3 middleware stack. Contracts: context-validated create-once opens (interview/booking participants only; family = live per-child `message` scope, provider = R29 `contact` recheck); sends re-check live participation + scope + access version against a fresh transactional read (server timestamps only); message fan-out = generic registry template in-app row (idempotent) + R20 consent-gated generic SMS nudge, excludedUids-filtered (AE24); wrong room IDs enumeration-safe. getChildcareBookingCoordination is the U7-deferred exact-address read: assigned caregiver + current access version + confirmed/in_progress + safety_read eligibility recheck (family side: checkAuthority `view` per child) via the versioned coordination projection — revoked/substituted/stale/wrong-state denied identically to the safety read; reads audit-logged (IDs only, never the address).",
  },
  {
    consumerName: "functions/src/childcare/notificationPolicy",
    sourceFile: "functions/src/childcare/notificationPolicy.ts",
    collections: ["consent_receipts", "smsThrottles", "users"],
    disposition: "child-specific",
    ownerUnit: "U9",
    notes:
      "THE childcare notification surface (R43/KTD16/AE17/AE24): the childSafe:true template registry (STATIC strings — no interpolation slots; prohibited-interpolation source scan in notificationPolicy.test.ts), the idempotent deterministic-id delivery path (writeUserNotification — one event, one row), the R20 consent gate (childcare SMS requires a live non-revoked communicationConsent receipt; revoked adults get in-app only; fail closed when no receipt exists), the SMS burst throttle, and the excludedUids exclusion consult on every fan-out.",
  },
  {
    consumerName: "functions/src/childcare/paymentPolicy",
    sourceFile: "functions/src/childcare/paymentPolicy.ts",
    collections: ["childcare_pricing_configs", "jurisdiction_care_policies"],
    disposition: "child-specific",
    ownerUnit: "U8",
    notes:
      "Childcare money policy (R40/R57): resolveChildcarePricingSnapshot resolves the jurisdiction pricing refs against childcare_pricing_configs and FAILS CLOSED on any unset ref/missing doc/malformed value (childcare amounts never derive from senior fee constants); childcarePlatformFeeCents/childcareFeeCentsForShift compute the childcare platform fee from the FROZEN booking snapshot only; cancellation/refund window+percent evaluation is policy-resolved (never hardcoded); the pinned child-PII-free Stripe metadata key sets (setup/charge/refund) + assertChildSafeStripeMetadata live here.",
  },
  {
    consumerName: "functions/src/childcare/shiftPayments",
    sourceFile: "functions/src/childcare/shiftPayments.ts",
    collections: ["booking_requests", "appointments", "shifts", "shiftHours", "users", "admin_alerts", "childcare_flags"],
    disposition: "child-specific",
    ownerUnit: "U8",
    notes:
      "U8 money orchestration: v1-setupChildcareBookingPayment (payer with LIVE payment scope for every child; guardian-without-payment-scope gets the explicit pending-payer state; SetupIntent + saved off-session method — the senior saved-method rail; R40 pricing gate refuses on unset refs; wires the documented recordChildcareBookingPaymentAuthorization seam) + createChildcareValidatedShiftHoursForToday (server-derived hours at check-out, revalidates assigned provider + booking state, create-once vertical-stamped shiftHours rows with the frozen fee snapshot + R39 booking/shift ledger correlation) + handleOverdueChildcareVisit (late/no-show policy states, never wall-clock completion, no charge) + v1-requestChildcareRefund (policy-evaluated, feeds the EXISTING refundRequests state machine — collection not in the watch list; also reads customers for the payer Stripe id) + holdChildcareShiftPayout (dispute/chargeback payout hold) + evaluateAndRecordChildcareCancellation (policy outcome record, auth canceled via the seam, no auto-charge). Occurrence charges/transfers then run on the PROVEN senior processShiftPayment/settleShiftTransfer machinery.",
  },
  {
    consumerName: "functions/src/childcare/payoutHoldWorker",
    sourceFile: "functions/src/childcare/payoutHoldWorker.ts",
    collections: ["shiftHours", "users", "notifications", "admin_alerts"],
    disposition: "child-specific",
    ownerUnit: "U8",
    notes:
      "Durable childcare payout-hold operation ledger for the U8 money paths: enqueueChildcarePayoutHold (called from the Stripe dispute webhook in stripe.ts and triggers/disputeResolution.ts) writes a deterministic cph_ operation keyed on dispute source + appointment into childcare_payout_hold_operations (collection not in the watch list), and the leased worker holds the payout on the correlated shiftHours row ONLY when that row is careVertical=='child' — a senior or missing row terminates as missing_correlation with a critical admin_alert rather than mutating anything. A dispute landing after stripeTransferId already exists terminates as already_paid_requires_recovery (critical admin_alert, no silent write); repeated runs converge (already_held). Party notices are idempotent deterministic-id rows under users/{uid}/notifications with a STATIC child-safe body carrying only a booking reference. Bounded retries escalate via admin_alerts childcare_payout_hold_retry_exhausted. sweepPendingPayoutHolds is the every-5-minutes scheduler (processChildcarePayoutHolds).",
  },
  {
    consumerName: "functions/src/childcare/reviewCallables",
    sourceFile: "functions/src/childcare/reviewCallables.ts",
    collections: ["reviews", "booking_requests", "childcare_flags"],
    disposition: "child-specific",
    ownerUnit: "U8",
    notes:
      "v1-submitChildcareReview (R44): server-ONLY creation (browser childcare review writes rules-denied), booking participants only, after verified completion, once per reviewer+booking via deterministic crev_ IDs (duplicate submits converge — AE15), vertical + recipient-safe context stamped (pinned CHILDCARE_REVIEW_DOC_KEYS — opaque IDs + adult content, structurally NO child fields), moderationState field (published/flagged/removed; aggregates exclude removed).",
  },
  {
    consumerName: "functions/src/childcare/reputationProjection",
    sourceFile: "functions/src/childcare/reputationProjection.ts",
    collections: ["reviews", "booking_requests", "caregiver_reputation", "caregivers"],
    disposition: "child-specific",
    ownerUnit: "U8",
    notes:
      "Per-vertical CHILD reputation aggregates (R45/KTD15): rating/reliability/cancellation/response/completion/repeat-booking computed EXCLUSIVELY from careVertical=='child' reviews (Q42) and bookings (Q34); writes ONLY child-prefixed caregiver_reputation fields + the caregivers.childcareReputationSummary sibling field (deliberately NOT nested in the U5 childcareProvider summary, which visibility recomputes rewrite wholesale). Senior reviews can never enter these aggregates and childcare aggregates never touch caregivers.rating/reviewCount — both directions pinned in tests. Public exposure: publicCaregiverProfile.toPublicProfile emits childcareReputation labels only while childcare-visible.",
  },
  {
    consumerName: "functions/src/childcare/matchingEligibility",
    sourceFile: "functions/src/childcare/matchingEligibility.ts",
    collections: ["caregivers", "vertical_profiles"],
    disposition: "child-specific",
    ownerUnit: "U6",
    notes:
      "THE U6 matching gate (R34/KTD11): filterEligibleChildcareCandidates rechecks provider eligibility per candidate (fail closed per candidate) then applies age-band/category/transport/distance/availability fit BEFORE any scoring; rankEligibleChildcareCandidates scores with ai/scoring.scoreChildcareCandidate (approved features only — structurally no cross-vertical reputation, R45); computeChildcareMatchesForIntake is the guarded-branch target for matchJob/aiMatching typed-childcare intakes. Also owns the R33 public field sets (CHILDCARE_JOB_PUBLIC_FIELDS / CHILDCARE_APPLICATION_PUBLIC_FIELDS), the child-safe outbound payload assertion, and the open-status sentinel (open_childcare — senior status=='open' consumers structurally skip childcare).",
  },
  {
    consumerName: "functions/src/memory/memoryEligibility",
    sourceFile: "functions/src/memory/memoryEligibility.ts",
    collections: ["caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "U10 DONE: the full typed MemoryEligibilityDecision seam (R50/KTD17) — per-subsystem map + immutable exclusion stamp — consulted by every memory subsystem. The decision surface stays pure; the ONE impure helper resolves a caregiver phone from caregivers/users to stamp childcareContextActive (AE22) — ids/phones only, no recipient content. Denies childcare/pending/unclassified/caregiver-childcare-context; senior-classified stays eligible (parity pinned in its test).",
  },
  {
    consumerName: "components/client/childcare/ChildProfileFlow",
    sourceFile: "components/client/childcare/ChildProfileFlow.tsx",
    collections: [],
    disposition: "child-specific",
    ownerUnit: "U4",
    notes: "Authenticated secure child-profile form — callable-only (v1-createChildProfile etc.); no direct Firestore access, no local persistence of private fields; identity callback nonce (not child data) parked in sessionStorage across the Stripe redirect (R22).",
  },
  {
    consumerName: "functions/src/childcare/childProfileCallables",
    sourceFile: "functions/src/childcare/childProfileCallables.ts",
    collections: ["child_profiles", "data_lifecycle_requests", "guardian_authorities", "childcare_flags"],
    disposition: "child-specific",
    ownerUnit: "U3",
    notes: "v1 child-profile + lifecycle callables (create/update/appendSafety/get/listMyChildren/export/delete/status) with the full U2 middleware stack: App Check, Firestore-resident flags, fail-closed rate limits, auth_time recent-auth on high-risk ops, idempotency keys, live checkAuthority object authorization (viewer cache never consulted), enumeration-safe errors. Returns operational summaries only — never the private zone.",
  },
  {
    consumerName: "functions/src/agents/objectiveLedger",
    sourceFile: "functions/src/agents/objectiveLedger.ts",
    collections: ["agent_objectives", "guardian_authorities"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "Vertical-bound objective ledger. Child objectives carry immutable operation and authority bindings; resume and mutation recheck the exact current guardian authority before execution.",
  },
  {
    consumerName: "functions/src/agents/pendingActions",
    sourceFile: "functions/src/agents/pendingActions.ts",
    collections: ["pending_actions", "booking_requests", "childcare_flags", "guardian_authorities"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "Shared pending-action store with mandatory child operation binding. Confirmation rechecks vertical, principal, booking, feature flags, and guardian authority in the execution transaction so approvals cannot cross or outlive their source lifecycle.",
  },
  {
    consumerName: "functions/src/childcare/reviewModerationCallables",
    sourceFile: "functions/src/childcare/reviewModerationCallables.ts",
    collections: ["childcare_review_submissions", "reviews", "agent_audit_log", "childcare_operators"],
    disposition: "child-specific",
    ownerUnit: "U2",
    notes: "Scoped, recently authenticated private review queue and CAS moderation state machine. It publishes only an allowlisted child-safe projection and records every transition in the restricted security audit.",
  },
  {
    consumerName: "functions/src/childcare/childFileAccess",
    sourceFile: "functions/src/childcare/childFileAccess.ts",
    collections: ["child_profiles", "childcare_flags", "guardian_authorities", "childcare_file_delivery_refs", "data_lifecycle_requests"],
    disposition: "child-specific",
    ownerUnit: "U11",
    notes: "Restricted child-file boundary: single-use generation-zero upload intents bind MIME, size, SHA-256, object metadata, principal, child, purpose, authority versions, and expiry. Actual Storage metadata, bytes, generation, and checksum are verified before quarantine. Reads use non-secret delivery refs and an authenticated streaming endpoint that rechecks live guardian authority or current provider assignment, file clean state, and exact generation on every request. Lifecycle exports use the same boundary; no signed read URL is issued.",
  },
  {
    consumerName: "functions/src/childcare/childFileScan",
    sourceFile: "functions/src/childcare/childFileScan.ts",
    collections: ["child_profiles", "guardian_authorities", "childcare_file_scan_operations"],
    disposition: "child-specific",
    ownerUnit: "U11",
    notes: "Trusted Storage-finalize dispatcher rechecks the uploader's current management authority, verifies the actual object, creates one generation-bound scan operation, and publishes a bounded immutable request. Duplicate and stale finalize events converge without making a file readable.",
  },
  {
    consumerName: "functions/src/childcare/childFileScanResult",
    sourceFile: "functions/src/childcare/childFileScanResult.ts",
    collections: ["childcare_file_scan_operations", "child_profiles", "admin_alerts"],
    disposition: "child-specific",
    ownerUnit: "U11",
    notes: "Trusted scan-result consumer validates HMAC, operation/file/generation/checksum/attempt binding, approved scanner image digest, and signature freshness before changing file state. A matching clean result is the only readable transition; timeout retries stop after three attempts, and seven-day generation-safe quarantine cleanup honors legal hold.",
  },
  {
    consumerName: "functions/src/childcare/appCheckProbe",
    sourceFile: "functions/src/childcare/appCheckProbe.ts",
    collections: ["childcare_appcheck_probe_challenges", "childcare_operators"],
    disposition: "child-specific",
    ownerUnit: "U12",
    notes: "Operator-only, recently authenticated, read-only production probe for exact-project, approved-origin, limited-use App Check replay enforcement.",
  },
  {
    consumerName: "functions/src/childcare/operatorAccess",
    sourceFile: "functions/src/childcare/operatorAccess.ts",
    collections: ["booking_requests", "appointments", "shifts", "shiftHours", "refundRequests", "disputes", "payouts", "chatRooms", "childcare_incidents", "child_profiles", "childcare_review_submissions", "childcare_booking_safety", "caregivers"],
    disposition: "child-specific",
    ownerUnit: "U13",
    notes: "Machine-readable exact-object operator access policy. Each child-bearing resource has explicit scopes, structured reason codes, child-vertical verification, and a minimum output projection; no list or arbitrary query surface exists.",
  },
  {
    consumerName: "functions/src/childcare/operatorCallables",
    sourceFile: "functions/src/childcare/operatorCallables.ts",
    collections: [],
    disposition: "child-specific",
    ownerUnit: "U13",
    notes: "Limited-use App Check callable for exact-object operator reads. Requires an explicit live scope, recent auth, structured reason, fail-closed audit, and minimum projection.",
  },
  {
    consumerName: "functions/src/privacy/dataLifecycle",
    sourceFile: "functions/src/privacy/dataLifecycle.ts",
    collections: ["data_lifecycle_requests", "child_profiles", "guardian_authorities", "learned_facts", "admin_alerts", "childcare_file_delivery_refs"],
    disposition: "child-specific",
    ownerUnit: "U3",
    notes: "Export/delete/redact durable state machine (R13-R15/KTD21): authority + legal-hold gates, per-target task fan-out (viewer revocation, tombstone + private purge, Storage deletes, ai-reference scan over learned_facts as an invariant VERIFIER — child memory is denied by construction, KTD17 — with real cleanup hooks landing in U10, Stripe Identity redaction tracked as awaiting_provider state only, orphan-file scan, export bundle), bounded retries, terminal proof. beginAdultAccountDeletion is the R15 server-owned entry point — NOT yet wired into Auth-deletion paths (U12/U14 reclassify admin/adminUserActions.ts + any auth onDelete trigger onto it).",
  },
  {
    consumerName: "functions/src/scheduled/childcareLifecycleWorker",
    sourceFile: "functions/src/scheduled/childcareLifecycleWorker.ts",
    collections: ["data_lifecycle_requests", "child_profiles"],
    disposition: "child-specific",
    ownerUnit: "U3",
    notes: "Scheduled drain (every 15 min, UNGATED by childcare flags — deletion/export are data rights that survive emergency-off): lifecycle request progress, age-band recalc + explicit age-out sweep, retention TTL sweep that SHIPS OFF (every duration is POLICY-TBD in docs/policies/childcare-data-retention.md; the isRetentionEnforcementConfigured guard refuses enforcement until counsel supplies concrete durations).",
  },

  // ── functions/src/config ──
  {
    consumerName: "functions/src/config/featureFlags",
    sourceFile: "functions/src/config/featureFlags.ts",
    collections: ["childcare_flags"],
    disposition: "child-specific",
    ownerUnit: "U1",
    notes: "Firestore-resident childcare flag reader (R61): childcare_flags/global + per-state overlay, 60s TTL cache + bust hook, absent ⇒ OFF, emergencyOff force-false without redeploy. The senior env-var flags in the same file touch no shared collection.",
  },

  // ── functions/src/createVideoInterviewRequest.ts ──
  {
    consumerName: "functions/src/createVideoInterviewRequest",
    sourceFile: "functions/src/createVideoInterviewRequest.ts",
    collections: ["publicCaregiverProfiles", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guarded branch DONE: careVertical=='child' requests route through childcare/jobCallables.createChildcareInterviewGated (identity + per-child authority + provider eligibility recheck context 'interview' + flags). Senior requests byte-identical.",
  },

  // ── functions/src/data ──
  {
    consumerName: "functions/src/data/seniorProfileRepository",
    sourceFile: "functions/src/data/seniorProfileRepository.ts",
    collections: ["senior_profiles"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U3",
    notes: "Canonical senior store (+ legacy seniors fallback). Child profiles live in child_profiles (U3); this repository must never resolve a child recipient.",
  },

  // ── functions/src/email.ts ──
  {
    consumerName: "functions/src/email",
    sourceFile: "functions/src/email.ts",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 audited: NO childcare email sender exists - the only trigger (sendWelcomeEmail) keys on userType with adult-generic copy, and admin sendEmail/sendBulkEmail are operator-initiated. Any future childcare transactional email must take subject/body from the childSafe registry (childcare/notificationPolicy) - subjects carry no child name/address/custody/health detail (R43). Characterized in notificationPolicy.test.ts.",
  },

  // ── functions/src/index.ts ──
  {
    consumerName: "functions/src/index",
    sourceFile: "functions/src/index.ts",
    collections: ["admin_alerts", "caregivers", "reviews", "shifts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U14",
    notes: "Function wiring/exports only; per-consumer classification happens at the consumer module.",
  },

  // ── functions/src/invoicing.ts ──
  {
    consumerName: "functions/src/invoicing",
    sourceFile: "functions/src/invoicing.ts",
    collections: ["caregivers", "invoices", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },

  // ── functions/src/linq ──
  {
    consumerName: "functions/src/linq/client",
    sourceFile: "functions/src/linq/client.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/linq/inShiftPraise",
    sourceFile: "functions/src/linq/inShiftPraise.ts",
    collections: ["caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U9",
    notes: "U9 characterized: praise relays fire ONLY off lastInShiftUpdate session stamps, which are written exclusively by the senior in-shift update flow (IN_SHIFT_UPDATES_ENABLED); childcare has no in-shift updates, so no childcare data can enter this path. No code change needed - skip is by construction.",
  },
  {
    consumerName: "functions/src/linq/inboundHelpers",
    sourceFile: "functions/src/linq/inboundHelpers.ts",
    collections: ["appointments"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: handleRecurringConfirm skips childcare-vertical sessions (clears the flags, sends a web-redirect message, writes NO appointments/recurring_schedules) - SMS-driven appointment creation stays senior-only until U10. Senior path byte-identical."
  },
  {
    consumerName: "functions/src/linq/outboundQueue",
    sourceFile: "functions/src/linq/outboundQueue.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/linq/routeCaregiver",
    sourceFile: "functions/src/linq/routeCaregiver.ts",
    collections: ["admin_alerts", "appointments", "caregivers", "interview_requests", "senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/linq/routeClient",
    sourceFile: "functions/src/linq/routeClient.ts",
    collections: ["admin_alerts", "appointments", "senior_profiles"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "Reads senior_profiles in client routing; childcare sessions must branch before senior context loads.",
  },
  {
    consumerName: "functions/src/linq/routeIntent",
    sourceFile: "functions/src/linq/routeIntent.ts",
    collections: ["admin_alerts", "agent_conversations", "appointments", "caregivers", "family_group_members", "interview_requests"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: SMS appointment mutations skip childcare docs - both pendingCancelConfirm cancel sites redirect to the web (flag cleared, no write) when the appointment is careVertical=='child', and the recurring-cancel batch skips childcare-stamped docs. Childcare booking mutations are web/callable-only until U10 adds classified Evia tools. Senior paths byte-identical."
  },
  {
    consumerName: "functions/src/linq/threadMirror",
    sourceFile: "functions/src/linq/threadMirror.ts",
    collections: ["agent_conversations", "threads"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: mirrorToWebThread takes a careVertical classification param and SKIPS 'child' turns entirely (fail closed) - childcare context never enters the senior cara_{uid} thread structures (R41/R50); routing visibility for childcare chat is v1-listMyChildcareConversations. Unclassified turns remain the senior-compatible default (U10 owns turn classification and passes the stamp). Senior mirroring byte-identical (threadMirror.test.ts before/after).",
  },
  {
    consumerName: "functions/src/linq/webChat",
    sourceFile: "functions/src/linq/webChat.ts",
    collections: ["threads", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U4",
  },
  {
    consumerName: "functions/src/linq/webhooks",
    sourceFile: "functions/src/linq/webhooks.ts",
    collections: ["admin_alerts", "agent_conversations", "appointments", "caregivers", "family_group_members", "family_groups", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U4",
    notes: "Ingress classification. U4 DONE: all six memory call sites (first contact, secondary family member, pending-consent opt-in, web bridge, lazy Zep self-heal, onboarding transcript logging) are gated on memory/memoryEligibility.decideMemoryEligibility; childcare bridge docs and childcare-stamped sessions route to childcare/signupIngress.ts (typed-vertical-guarded branches, fail closed); STOP revokes the childcare communication-consent receipt.",
  },

  // ── functions/src/matching.ts ──
  {
    consumerName: "functions/src/matching",
    sourceFile: "functions/src/matching.ts",
    collections: ["appointments", "caregivers", "hire_requests", "notifications", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },

  // ── functions/src/mcp ──
  {
    consumerName: "functions/src/mcp/server",
    sourceFile: "functions/src/mcp/server.ts",
    collections: ["admin_alerts", "appointments", "caregivers", "family_group_members", "hire_requests", "interview_requests", "interviews", "invoices", "job_applications", "job_postings", "job_posts", "match_history", "payments", "reports", "reviews", "senior_profiles", "shiftHours", "shifts", "threads", "users", "video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "Every MCP tool touching shared collections must carry an explicit vertical disposition before childcare enablement (U10).",
  },

  // ── functions/src/memory ──
  {
    consumerName: "functions/src/memory/conversationMemory",
    sourceFile: "functions/src/memory/conversationMemory.ts",
    collections: ["agent_conversations"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Memory subsystem: childcare/unclassified turns are memory-denied before initialization (implementation-time default).",
  },
  {
    consumerName: "functions/src/memory/learnedFacts",
    sourceFile: "functions/src/memory/learnedFacts.ts",
    collections: ["learned_facts"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Memory subsystem: no child facts may be learned/stored.",
  },
  {
    consumerName: "functions/src/memory/memoryFiles",
    sourceFile: "functions/src/memory/memoryFiles.ts",
    collections: ["agent_conversations", "memory_embeddings"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Memory subsystem: consolidation must never ingest childcare turns.",
  },
  {
    consumerName: "functions/src/memory/memoryOperations",
    sourceFile: "functions/src/memory/memoryOperations.ts",
    collections: ["admin_alerts"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Memory operation ledger; childcare memory operations do not exist until U10 defines eligibility.",
  },

  // ── functions/src/migrations ──
  {
    consumerName: "functions/src/migrations/backfillAppointmentScheduleFields",
    sourceFile: "functions/src/migrations/backfillAppointmentScheduleFields.ts",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  // ── U14 childcare migration rehearsals + staged-deploy machinery ──
  {
    consumerName: "functions/src/migrations/migrateHouseholds",
    sourceFile: "functions/src/migrations/migrateHouseholds.ts",
    collections: ["family_groups", "household_memberships", "households", "senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U14",
    notes:
      "U14 REHEARSAL: maps legacy family sources (senior_profiles.familyMembers + family_groups) into households + household_memberships compatibility projections. Dry-run default; apply refused off the non-production project (nonProductionGuard). Phone-only adults → PROVISIONAL memberships (zero scopes, U2 rule); NO child-vertical data flows through the legacy phone-keyed readers and NO guardian authority is created. Unresolved/ambiguous seniors + orphan family_groups quarantined; reconciliation written to childcare_canary_state/migration_report.",
  },
  {
    consumerName: "functions/src/migrations/backfillProviderVerticalProfiles",
    sourceFile: "functions/src/migrations/backfillProviderVerticalProfiles.ts",
    collections: ["caregivers", "vertical_profiles"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U14",
    notes:
      "U14 REHEARSAL: ensures each existing caregiver has a clean reusable base profile + a namespaced `senior` vertical marker, WITHOUT creating any childcare (`child`) vertical profile or approval (opt-in per U5, AE21). A caregiver whose base doc carries childcare-namespaced fields (dirty split, R24) is quarantined. childProfilesCreated is an invariant that stays 0. Dry-run default; apply refused off the non-production project.",
  },
  {
    consumerName: "functions/src/migrations/migrationReconciliation",
    sourceFile: "functions/src/migrations/migrationReconciliation.ts",
    collections: ["childcare_canary_state"],
    disposition: "child-specific",
    ownerUnit: "U14",
    notes:
      "U14: writes the migration reconciliation report (COUNTS only — assertNoChildPii) to childcare_canary_state/migration_report; U13's canary reads the `unresolved` field into the zero-tolerance migration_count_mismatch rollout-hold signal.",
  },
  {
    consumerName: "functions/src/triggers/careVerticalBackfillTrigger",
    sourceFile: "functions/src/triggers/careVerticalBackfillTrigger.ts",
    collections: ["appointments", "booking_requests", "chatRooms", "reviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U14",
    notes:
      "U14 amended-R2 bake-window seam: onCreate triggers on the four browser-writable shared collections stamp careVertical:'senior' on docs missing a vertical during the Rules bake window. DARK by default (CARE_VERTICAL_INTERIM_BACKFILL_ENABLED=true); never overwrites an existing vertical, never infers 'child'. Retired once Rules enforce the field.",
  },
  {
    consumerName: "functions/src/childcare/deployGate",
    sourceFile: "functions/src/childcare/deployGate.ts",
    collections: ["childcare_canary_state"],
    disposition: "child-specific",
    ownerUnit: "U14",
    notes:
      "U14 deployment gate: reads the rollout-HOLD + migration report (childcare_canary_state), jurisdiction readiness, cutoff flag, and audit/preflight signals; REFUSES to proceed on failed audit, rollout hold, incomplete jurisdiction readiness, unresolved/unreconciled migration, unset cutoff, or unconfirmed preflight. Read-only; nothing deploys.",
  },
  {
    consumerName: "functions/src/childcare/productionProofRecorder",
    sourceFile: "functions/src/childcare/productionProofRecorder.ts",
    collections: ["childcare_canary_state"],
    disposition: "child-specific",
    ownerUnit: "U14",
    notes:
      "U14 R62 proof recorder: validates + persists the deployment-proof evidence bundle (one Git SHA + matching Functions/Hosting/Rules/indexes/scheduler/flags/migration/smokes/monitoring/rollback) to childcare_canary_state/deployment_proof. Child-safe by construction (assertNoChildPii).",
  },
  {
    consumerName: "functions/src/migrations/backfillCaregiverPayoutPrivate",
    sourceFile: "functions/src/migrations/backfillCaregiverPayoutPrivate.ts",
    collections: ["caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/backfillCaregiverPrivateBackground",
    sourceFile: "functions/src/migrations/backfillCaregiverPrivateBackground.ts",
    collections: ["caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/backfillCaregiverServiceAvailability",
    sourceFile: "functions/src/migrations/backfillCaregiverServiceAvailability.ts",
    collections: ["caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/backfillEviaProfileFields",
    sourceFile: "functions/src/migrations/backfillEviaProfileFields.ts",
    collections: ["caregivers", "senior_profiles", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/carePlanInterviewBackfill",
    sourceFile: "functions/src/migrations/carePlanInterviewBackfill.ts",
    collections: ["job_posts", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/consolidateWebCarePlans",
    sourceFile: "functions/src/migrations/consolidateWebCarePlans.ts",
    collections: ["senior_profiles"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/linkPhoneProviders",
    sourceFile: "functions/src/migrations/linkPhoneProviders.ts",
    collections: ["users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/migrateCarePlansToCanonical",
    sourceFile: "functions/src/migrations/migrateCarePlansToCanonical.ts",
    collections: ["senior_profiles"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/migrateSeniorsToHousehold",
    sourceFile: "functions/src/migrations/migrateSeniorsToHousehold.ts",
    collections: ["senior_profiles", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },
  {
    consumerName: "functions/src/migrations/rekeyLegacyCaregiverDocs",
    sourceFile: "functions/src/migrations/rekeyLegacyCaregiverDocs.ts",
    collections: ["caregivers", "payouts", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U14",
  },

  // ── functions/src/notifications.ts ──
  {
    consumerName: "functions/src/notifications",
    sourceFile: "functions/src/notifications.ts",
    collections: ["admin_alerts", "appointments", "chatRooms", "notifications", "threads", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: onAppointmentCreated returns before ensureChatRoom for careVertical=='child' docs (the pairwise-room factory - the exact pattern R41 replaces - never fires for childcare; childcare rooms are server context rooms via conversationPolicy); onAppointmentCancelled skips childcare docs (registry rows own those notices); sendShiftReminders skips childcare appointments (childcare proactive SMS deferred behind U1/U10 templates). Senior paths byte-identical.",
  },
  {
    consumerName: "functions/src/notifications/userNotification",
    sourceFile: "functions/src/notifications/userNotification.ts",
    collections: ["notifications", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: unchanged additively - it is now THE delivery path for every childcare in-app row (childcare/notificationPolicy.deliverChildcareNotification routes registry templates through its deterministic operation ids, so duplicate childcare sends converge - AE15). Childcare payloads are registry-generic (no child PII in title/body/data - static-scanned).",
  },

  // ── functions/src/observability ──
  {
    consumerName: "functions/src/observability/actionLedger",
    sourceFile: "functions/src/observability/actionLedger.ts",
    collections: ["agent_action_ledger"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },
  {
    consumerName: "functions/src/observability/auditLog",
    sourceFile: "functions/src/observability/auditLog.ts",
    collections: ["agent_audit_log"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },
  {
    consumerName: "functions/src/observability/caraOpsAlerts",
    sourceFile: "functions/src/observability/caraOpsAlerts.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },
  {
    consumerName: "functions/src/observability/providerFailureAlert",
    sourceFile: "functions/src/observability/providerFailureAlert.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },

  // ── functions/src/operations ──
  {
    consumerName: "functions/src/operations/externalSideEffect",
    sourceFile: "functions/src/operations/externalSideEffect.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },

  // ── functions/src/paymentMethods.ts ──
  {
    consumerName: "functions/src/paymentMethods",
    sourceFile: "functions/src/paymentMethods.ts",
    collections: ["appointments", "job_posts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: updateBookingPaymentMethod refuses offline methods (cash/Venmo/Zelle) on childcare appointments — childcare settles by the payer's saved card only (Billing Portal default method via setupChildcareBookingPayment). Senior method switching byte-identical.",
  },

  // ── functions/src/payoutCommon.ts ──
  {
    consumerName: "functions/src/payoutCommon",
    sourceFile: "functions/src/payoutCommon.ts",
    collections: ["caregivers", "notifications", "payouts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },

  // ── functions/src/publicCaregiverProfile.ts ──
  {
    consumerName: "functions/src/publicCaregiverProfile",
    sourceFile: "functions/src/publicCaregiverProfile.ts",
    collections: ["caregivers", "publicCaregiverProfiles"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
    notes: "U5 DONE: projection adds derived per-vertical visibility + ALLOWLISTED evidence labels ONLY when the server-owned childcareProvider summary exists (R30); senior-only caregiver projections stay byte-identical (AE9 parity test).",
  },

  // ── functions/src/pushNotifications.ts ──
  {
    consumerName: "functions/src/pushNotifications",
    sourceFile: "functions/src/pushNotifications.ts",
    collections: ["chatRooms", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: chatRooms message pushes take a guarded childcare branch - careVertical=='child' rooms send the STATIC registry template (title 'New Message', generic body; NO message text, NO sender name, opaque room id only - AE17) after consulting the booking's excludedUids set (AE24; fail closed to no push). Senior push payload byte-identical (shared token-delivery helper extracted, behavior-preserving).",
  },

  // ── functions/src/rateLimit.ts ──
  {
    consumerName: "functions/src/rateLimit",
    sourceFile: "functions/src/rateLimit.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },

  // ── functions/src/referralLookup.ts ──
  {
    consumerName: "functions/src/referralLookup",
    sourceFile: "functions/src/referralLookup.ts",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },

  // ── Childcare U10 (Evia context, tools, memory denial) ──
  {
    consumerName: "functions/src/agents/childcareSituation",
    sourceFile: "functions/src/agents/childcareSituation.ts",
    collections: ["booking_requests", "guardian_authorities", "child_profiles"],
    disposition: "child-specific",
    ownerUnit: "U10",
    notes: "Server-owned childcare context envelope (R49): resolves children/bookings/objectives exclusively from authoritative reads via the U2/U3 repositories; ephemeral per turn, never persisted; single-equality booking_requests query with in-memory vertical filter (Q34-note pattern).",
  },
  {
    consumerName: "functions/src/mcp/childcareTools",
    sourceFile: "functions/src/mcp/childcareTools.ts",
    collections: ["booking_requests", "guardian_authorities", "child_profiles"],
    disposition: "child-specific",
    ownerUnit: "U10",
    notes: "Family-side childcare MCP tool pack (R51/R52): fail-closed vertical guard, action-time checkAuthority + runtime-flags recheck inside every handler, mutations delegate to the shared bookingCallables cores, fresh-read post-state evidence on results.",
  },
  {
    consumerName: "functions/src/childcare/incidentSignal",
    sourceFile: "functions/src/childcare/incidentSignal.ts",
    collections: ["admin_alerts"],
    disposition: "child-specific",
    ownerUnit: "U10",
    notes: "Deterministic pre-LLM serious-incident classifier + handoff seam (R53): holds the agent session with the childcareIncidentMarker and pages ops via caraOpsAlerts (category only, never message text - R57). U12 incidentPolicy consumes the marker.",
  },
  {
    consumerName: "functions/src/childcare/incidentPolicy",
    sourceFile: "functions/src/childcare/incidentPolicy.ts",
    collections: ["childcare_incidents", "booking_requests"],
    disposition: "child-specific",
    ownerUnit: "U12",
    notes:
      "U12 DONE: restricted incident case policy (R53/AE24). ONE case per U10 marker via deterministic cinc_ ids (duplicate markers/reports converge); deterministic categories (classifier + operator allowlist); status workflow map (open→investigating→resolved/escalated + appeal/correction) with append-only in-doc history + audit on every transition; evidence as REFERENCES only (opaque ids, never copies — R57); suspected-party exclusion unions booking_requests.excludedUids (U9 fan-out skip); payout hold via U8 holdChildcareShiftPayout (lazy import); litigation hold via U3 setChildLegalHold (blocks delete/redact while active). Pinned sanitized queue-row key set. Never consults childcare flags (safety ops never dark).",
  },
  {
    consumerName: "functions/src/childcare/incidentCallables",
    sourceFile: "functions/src/childcare/incidentCallables.ts",
    collections: ["reviews"],
    disposition: "child-specific",
    ownerUnit: "U12",
    notes:
      "U12 DONE: v1 operator callables (createChildcareIncident [operator or system-from-marker], listChildcareIncidents [pinned sanitized queue — no child details], getChildcareIncidentDetail [childSafetyOperator + reason + recent auth], updateChildcareIncidentStatus, assignChildcareIncident, applyChildcareIncidentAction [evidence/exclusion/payout hold/litigation hold — reason required], resolveChildcareAuthorityDispute [surfaces U2 resolveAuthorityDispute], markProviderRedactionComplete [surfaces U3 markProviderTaskComplete — generalOperator], flagChildcareReview/removeChildcareReview [generalOperator; only the pinned moderationState/isPublic fields move; reason audited]). requireOperatorScope replaces requireAdmin (R55/AE18); App Check + rate limits + enumeration-safe errors; DELIBERATELY ungated by childcare flags (must work during emergency-off). Incident case reads/writes go through incidentPolicy.",
  },

  // ── functions/src/scheduled ──
  {
    consumerName: "functions/src/scheduled/adminAlertAging",
    sourceFile: "functions/src/scheduled/adminAlertAging.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
    notes: "U10 classified: vertical-neutral ops sweep over admin_alerts aging metadata; never reads recipient data. Childcare incident alerts (type childcare_incident) age like any other alert; U12 owns the incident queue.",
  },
  {
    consumerName: "functions/src/scheduled/backgroundCheckExpiry",
    sourceFile: "functions/src/scheduled/backgroundCheckExpiry.ts",
    collections: ["admin_alerts", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
    notes: "U5 DONE: senior sweep unchanged; an ADDITIVE flag-gated childcare branch (providerEligibility.runChildcareScreeningExpirySweep) expires stale childcare evidence and removes childcare visibility without touching any senior field (R31/AE9).",
  },
  {
    consumerName: "functions/src/scheduled/caregiverInactivityCheck",
    sourceFile: "functions/src/scheduled/caregiverInactivityCheck.ts",
    collections: ["admin_alerts", "appointments", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
    notes: "U10 classified: vertical-neutral caregiver ACTIVITY accounting - childcare appointments legitimately count as caregiver activity; no recipient content or senior copy is read or sent.",
  },
  {
    consumerName: "functions/src/scheduled/clientDayBeforeReminder",
    sourceFile: "functions/src/scheduled/clientDayBeforeReminder.ts",
    collections: ["appointments", "caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: careVertical=='child' appointments are skipped in the send loop - this sender interpolates senior names into Evia SMS copy, and childcare proactive messaging stays deferred behind approved child-safe templates (U1/U10, R43/R54). Senior behavior byte-identical.",
  },
  {
    consumerName: "functions/src/scheduled/clientThirtyMinReminder",
    sourceFile: "functions/src/scheduled/clientThirtyMinReminder.ts",
    collections: ["appointments", "caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: careVertical=='child' appointments are skipped in the send loop - this sender interpolates senior names into Evia SMS copy, and childcare proactive messaging stays deferred behind approved child-safe templates (U1/U10, R43/R54). Senior behavior byte-identical.",
  },
  {
    consumerName: "functions/src/scheduled/dailyContactCardShare",
    sourceFile: "functions/src/scheduled/dailyContactCardShare.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions are filtered out of the contact-card share (senior proactive nicety; childcare proactive deferred).",
  },
  {
    consumerName: "functions/src/scheduled/dayBeforeShiftReminder",
    sourceFile: "functions/src/scheduled/dayBeforeShiftReminder.ts",
    collections: ["appointments", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: careVertical=='child' appointments are skipped in the send loop - this sender interpolates senior names into Evia SMS copy, and childcare proactive messaging stays deferred behind approved child-safe templates (U1/U10, R43/R54). Senior behavior byte-identical.",
  },
  {
    consumerName: "functions/src/scheduled/dndQueueProcessor",
    sourceFile: "functions/src/scheduled/dndQueueProcessor.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 characterized: vertical-neutral transport drain of ALREADY-COMPOSED deferred sends. No childcare writer enqueues DND rows (childcare SMS goes through notificationPolicy -> sendSMSToUser directly), so no childcare content can flow here until U10 classifies Evia sends. No code change needed.",
  },
  {
    consumerName: "functions/src/scheduled/engineGate",
    sourceFile: "functions/src/scheduled/engineGate.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "U10 classified: vertical-neutral intelligence-engine budget/kill gate; no recipient data. Childcare proactive sources do not exist (deferred), so nothing childcare flows through it.",
  },
  {
    consumerName: "functions/src/scheduled/experimentScorecard",
    sourceFile: "functions/src/scheduled/experimentScorecard.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
    notes: "U10 classified: vertical-neutral experiment telemetry aggregation; no recipient data.",
  },
  {
    consumerName: "functions/src/scheduled/familySatisfactionCheckin",
    sourceFile: "functions/src/scheduled/familySatisfactionCheckin.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped in the send loop (senior satisfaction copy; childcare proactive deferred).",
  },
  {
    consumerName: "functions/src/scheduled/familySilenceCheckin",
    sourceFile: "functions/src/scheduled/familySilenceCheckin.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped in the send loop (senior silence copy; childcare proactive deferred).",
  },
  {
    consumerName: "functions/src/scheduled/feedbackExpiry",
    sourceFile: "functions/src/scheduled/feedbackExpiry.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: defensive careVertical=='child' row skip in the expiry sweep (no childcare writer creates these rows).",
  },
  {
    consumerName: "functions/src/scheduled/firstVisitActivation",
    sourceFile: "functions/src/scheduled/firstVisitActivation.ts",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped before any appointment read (senior first-visit copy; childcare proactive deferred).",
  },
  {
    consumerName: "functions/src/scheduled/healthTrends",
    sourceFile: "functions/src/scheduled/healthTrends.ts",
    collections: ["appointments", "senior_profiles"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped before any senior_profiles/journal read (senior health analysis never touches child records, AE16).",
  },
  {
    consumerName: "functions/src/scheduled/inShiftUpdate",
    sourceFile: "functions/src/scheduled/inShiftUpdate.ts",
    collections: ["admin_alerts", "appointments", "caregivers", "senior_profiles"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' appointments skipped in the in-shift loop (senior care-plan/journal interpolation never sees child records).",
  },
  {
    consumerName: "functions/src/scheduled/inShiftUpdatePolicy",
    sourceFile: "functions/src/scheduled/inShiftUpdatePolicy.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 classified: vertical-neutral pure policy module (no queries); its consumer inShiftUpdate.ts carries the explicit careVertical=='child' appointment skip.",
  },
  {
    consumerName: "functions/src/scheduled/inferActiveHours",
    sourceFile: "functions/src/scheduled/inferActiveHours.ts",
    collections: ["agent_conversations"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Reads agent_conversations (memory-adjacent); childcare turns excluded until U10 eligibility.",
  },
  {
    consumerName: "functions/src/scheduled/interviewResponseReminder",
    sourceFile: "functions/src/scheduled/interviewResponseReminder.ts",
    collections: ["caregivers", "interview_requests"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U6",
    notes: "U6 classification: SENIOR-ONLY. Explicit careVertical=='child' skip in the request loop (the reminder interpolates seniorName/relationship into SMS copy). Childcare interviews live in vertical-stamped video_interviews with generic content; their reminder path is interviewLinkTrigger.",
  },
  {
    consumerName: "functions/src/scheduled/jobMatchNotifications",
    sourceFile: "functions/src/scheduled/jobMatchNotifications.ts",
    collections: ["caregivers", "job_posts"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U6",
    notes: "U6 classification: SENIOR-ONLY. The recommender reads status=='open' job_posts (childcare jobs are 'open_childcare' — structurally excluded) and the run additionally filters any childcare-stamped recommendation before SMS copy is built. Childcare job notifications are the eligibility-gated in-app rows written at job creation (jobCallables).",
  },
  {
    consumerName: "functions/src/scheduled/locationRequestNudge",
    sourceFile: "functions/src/scheduled/locationRequestNudge.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped in the nudge loop.",
  },
  {
    consumerName: "functions/src/scheduled/memoryOperationWorker",
    sourceFile: "functions/src/scheduled/memoryOperationWorker.ts",
    collections: ["agent_conversations"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "Memory subsystem worker.",
  },
  {
    consumerName: "functions/src/scheduled/morningBriefing",
    sourceFile: "functions/src/scheduled/morningBriefing.ts",
    collections: ["appointments", "caregivers", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' appointments skipped in all three loops (caregiver briefing, weekly hours rollup, family briefing).",
  },
  {
    consumerName: "functions/src/scheduled/nextDayFamilyFeedback",
    sourceFile: "functions/src/scheduled/nextDayFamilyFeedback.ts",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' appointments skipped (senior feedback copy; childcare proactive deferred).",
  },
  {
    consumerName: "functions/src/scheduled/nightlyMemory",
    sourceFile: "functions/src/scheduled/nightlyMemory.ts",
    collections: ["agent_conversations", "appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: decideMemoryEligibility precedes consolidation per session (childcare/pending/caregiver-childcare-context denied + logged); memoryExcluded-stamped rows are deletable-but-never-summarizable in compression; childcare appointments excluded from booking-pattern memory (R50/AE16).",
  },
  {
    consumerName: "functions/src/scheduled/noVisitCheck",
    sourceFile: "functions/src/scheduled/noVisitCheck.ts",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' schedules skipped (senior no-visit nudge).",
  },
  {
    consumerName: "functions/src/scheduled/objectiveExpirySweeper",
    sourceFile: "functions/src/scheduled/objectiveExpirySweeper.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "U10 classified: vertical-neutral objective state transitions - expiring a stale childcare objective is correct and desired; the sweeper reads no recipient content.",
  },
  {
    consumerName: "functions/src/scheduled/onboardingReengagement",
    sourceFile: "functions/src/scheduled/onboardingReengagement.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U5",
    notes: "Senior re-engagement nudges. U5 DONE: explicitly skips typed childcare-vertical sessions (isChildcareVerticalSession guard) so childcare adults never receive senior-flavored copy or LLM nudges (R54).",
  },
  {
    consumerName: "functions/src/scheduled/opsAnomalyWatch",
    sourceFile: "functions/src/scheduled/opsAnomalyWatch.ts",
    collections: ["admin_alerts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
    notes: "U10 classified: vertical-neutral aggregate telemetry watcher; no recipient data.",
  },
  {
    consumerName: "functions/src/scheduled/outboundQueueDrain",
    sourceFile: "functions/src/scheduled/outboundQueueDrain.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "U10 classified: vertical-neutral transport drain of already-composed sends (same posture as dndQueueProcessor). No childcare writer enqueues rows here; childcare SMS is composed by the childcare responder/agent branch which owns its own privacy posture.",
  },
  {
    consumerName: "functions/src/scheduled/paywallWinback",
    sourceFile: "functions/src/scheduled/paywallWinback.ts",
    collections: ["users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U11",
    notes: "Senior client subscription winback; childcare family entitlement is separate U1 pricing.",
  },
  {
    consumerName: "functions/src/scheduled/pendingTimesheetNudge",
    sourceFile: "functions/src/scheduled/pendingTimesheetNudge.ts",
    collections: ["caregivers", "shiftHours"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U8",
    notes: "U8 DONE: childcare shiftHours rows are explicitly skipped in the nudge grouping loop — the SMS timesheet nudge is a senior Evia flow (childcare families get the generic in-app hours notice at creation; childcare Evia nudges are U10). Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/scheduled/preShiftFamilyCheckin",
    sourceFile: "functions/src/scheduled/preShiftFamilyCheckin.ts",
    collections: ["appointments", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' appointments skipped (senior pre-shift copy; childcare proactive deferred).",
  },
  {
    consumerName: "functions/src/scheduled/proactiveBudget",
    sourceFile: "functions/src/scheduled/proactiveBudget.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "U10 classified: vertical-neutral per-family budget accounting; no recipient content. Childcare proactive sources are deferred, so no childcare spend flows through it.",
  },
  {
    consumerName: "functions/src/scheduled/proactiveDecisionEngine",
    sourceFile: "functions/src/scheduled/proactiveDecisionEngine.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "U10 classified: decision engine for SENIOR proactive sources only - every childcare-capable source it gates carries its own explicit child skip, and childcare proactive templates are deferred (pilot staging decision).",
  },
  {
    consumerName: "functions/src/scheduled/proactiveDraftSender",
    sourceFile: "functions/src/scheduled/proactiveDraftSender.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
    notes: "U10 DONE: defensive careVertical=='child' draft skip with a loud log - no writer creates childcare drafts (childcare proactive templates DEFERRED per the pilot staging decision).",
  },
  {
    consumerName: "functions/src/scheduled/proactiveReflection",
    sourceFile: "functions/src/scheduled/proactiveReflection.ts",
    collections: ["appointments", "invoices", "payments", "senior_profiles", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: decideMemoryEligibility precedes every family (childcare/pending denied + logged); senior sessions unchanged (R50/R54/AE16).",
  },
  {
    consumerName: "functions/src/scheduled/recurringScheduler",
    sourceFile: "functions/src/scheduled/recurringScheduler.ts",
    collections: ["admin_alerts", "appointments"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: defensive skip - a childcare-stamped recurring_schedules doc is never extended into senior-shaped appointments (childcare recurrence lives on the booking doc; shifts generated by childcare/bookingCallables). Senior path byte-identical."
  },
  {
    consumerName: "functions/src/scheduled/shiftGenerator",
    sourceFile: "functions/src/scheduled/shiftGenerator.ts",
    collections: ["booking_requests", "caregivers", "job_posts", "notifications", "shifts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: guarded childcare branches - onBookingAccepted routes careVertical=='child' booking writes to childcare/bookingCallables.handleChildcareBookingRequestWrite BEFORE any senior logic (the senior shiftBase copies address/careNeeds/emergencyContact and must never see a childcare doc), and generateRollingShifts skips childcare docs + runs the flag-gated sweepChildcareRollingShifts for confirmed recurring childcare bookings. Senior generation byte-identical."
  },
  {
    consumerName: "functions/src/scheduled/shiftOfferExpiry",
    sourceFile: "functions/src/scheduled/shiftOfferExpiry.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7: no change needed - the childcare skip lives in agents/shiftOffer.expireShiftOffers, which this schedule wraps."
  },
  {
    consumerName: "functions/src/scheduled/shiftTaskNudges",
    sourceFile: "functions/src/scheduled/shiftTaskNudges.ts",
    collections: ["appointments", "caregivers", "senior_profiles"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' appointments skipped (senior task nudges only).",
  },
  {
    consumerName: "functions/src/scheduled/staleApplicantNudge",
    sourceFile: "functions/src/scheduled/staleApplicantNudge.ts",
    collections: ["job_applications", "job_posts"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U6",
    notes: "U6 classification: SENIOR-ONLY. Explicit careVertical=='child' skip in the job loop; childcare jobs are additionally status 'open_childcare' so the status=='open' gate structurally excludes them. Childcare proactive nudges are deferred to the classified U10 sources.",
  },
  {
    consumerName: "functions/src/scheduled/staleSessionNudge",
    sourceFile: "functions/src/scheduled/staleSessionNudge.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped in all three nudge loops (childcare session steps are owned by the childcare ingress, never the senior state machine).",
  },
  {
    consumerName: "functions/src/scheduled/taxReminder",
    sourceFile: "functions/src/scheduled/taxReminder.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U10 classified: caregiver tax-document reminder; vertical-neutral adult provider messaging with no recipient content.",
  },
  {
    consumerName: "functions/src/scheduled/thirtyMinShiftReminder",
    sourceFile: "functions/src/scheduled/thirtyMinShiftReminder.ts",
    collections: ["appointments", "caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: careVertical=='child' appointments are skipped in the send loop - this sender interpolates senior names into Evia SMS copy, and childcare proactive messaging stays deferred behind approved child-safe templates (U1/U10, R43/R54). Senior behavior byte-identical.",
  },
  {
    consumerName: "functions/src/scheduled/transportBadge",
    sourceFile: "functions/src/scheduled/transportBadge.ts",
    collections: ["caregivers", "notifications", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
    notes: "U10 classified: caregiver badge recompute; vertical-neutral provider metadata with no recipient content.",
  },
  {
    consumerName: "functions/src/scheduled/upcomingVisitReminder",
    sourceFile: "functions/src/scheduled/upcomingVisitReminder.ts",
    collections: ["appointments", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: careVertical=='child' appointments are skipped in the send loop (same rationale as the other reminder sweeps - senior-name SMS copy; childcare proactive messaging deferred, R43/R54). Senior behavior byte-identical.",
  },
  {
    consumerName: "functions/src/scheduled/weeklyDigest",
    sourceFile: "functions/src/scheduled/weeklyDigest.ts",
    collections: ["appointments", "caregivers", "senior_profiles", "shiftHours", "users"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped in the client digest and childcare shiftHours rows excluded from the caregiver earnings summary (AE16).",
  },
  {
    consumerName: "functions/src/scheduled/wellbeingCheckin",
    sourceFile: "functions/src/scheduled/wellbeingCheckin.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped in the check-in loop.",
  },
  {
    consumerName: "functions/src/scheduled/wowMomentsJob",
    sourceFile: "functions/src/scheduled/wowMomentsJob.ts",
    collections: ["appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U10",
    notes: "U10 DONE: careVertical=='child' sessions skipped in the wow-moment loop (senior copy; childcare proactive deferred).",
  },

  // ── functions/src/shiftHours.ts ──
  {
    consumerName: "functions/src/shiftHours",
    sourceFile: "functions/src/shiftHours.ts",
    collections: ["appointments", "caregivers", "notifications", "shiftHours", "shifts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: guarded childcare branches on the PROVEN money rail — submitShiftHours fails closed on childcare appointments (hours are server-derived at check-out); processShiftPayment charges the recorded payer (billingUserId) with the FROZEN childcare policy fee (childcareFeeCentsForShift throws without a snapshot — never senior constants) and stamps the R39 booking/shift correlation metadata; payoutHold rows park in requires_admin_review (dispute/chargeback holds); approveShiftHoursForClient + confirmCashReceived fail closed on childcare rows; autoApproveShiftHours/retry/reconcile sweeps are vertical-agnostic by construction (same fields). Senior charge/transfer path byte-identical (settlement suite characterization). U12: adminResolveShiftHours carries an ADDITIVE generalOperator scope gate (requireAdmin stays the outer gate; broad isAdmin satisfies generalOperator by the pilot decision, so existing admin UI is unchanged) — billing reconciliation reads correlation IDs + amounts only, never custody/child data (AE18; childcare rows structurally carry no child fields, R46).",
  },

  // ── functions/src/sms.ts ──
  {
    consumerName: "functions/src/sms",
    sourceFile: "functions/src/sms.ts",
    collections: ["admin_alerts", "caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: unchanged - sendSMSToUser keeps its phone-level opt-out/circuit gates for all verticals; childcare sends ADDITIONALLY pass through childcare/notificationPolicy (R20 consent-receipt gate + static generic template + throttle) before reaching it, and SMS_TEMPLATES remain senior-only (no childcare caller interpolates them). Ordinary SMS carries routing/status/adult coordination only for childcare.",
  },

  // ── functions/src/stripe.ts ──
  {
    consumerName: "functions/src/stripe",
    sourceFile: "functions/src/stripe.ts",
    collections: ["admin_alerts", "caregivers", "notifications", "payments", "shiftHours", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: payment_intent.succeeded/failed handlers are vertical-agnostic by construction (they key on the shared appointmentId metadata the childcare charge also carries). Additive charge.dispute.created handler holds the payout rail for CHILDCARE-stamped rows only (senior charges keep the pre-U8 unhandled-log behavior). Founder-run: subscribe the platform webhook endpoint to charge.dispute.created.",
  },

  // ── functions/src/stripeConnect.ts ──
  {
    consumerName: "functions/src/stripeConnect",
    sourceFile: "functions/src/stripeConnect.ts",
    collections: ["caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },

  // ── functions/src/stripeConnectWebhook.ts ──
  {
    consumerName: "functions/src/stripeConnectWebhook",
    sourceFile: "functions/src/stripeConnectWebhook.ts",
    collections: ["appointments", "caregivers", "notifications", "payouts", "shiftHours", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: the payout.paid shift-stamping sweep is vertical-agnostic (childcare rows are correctly covered by the same caregiver-level payout); ADDITIVE childcare ledger correlation — when a sweep covers childcare rows the payouts ledger doc records their shiftHours + booking IDs (opaque IDs only, R39). Senior-only payouts are byte-identical (no correlation fields written).",
  },

  // ── functions/src/triggers ──
  {
    consumerName: "functions/src/triggers/activityOwner",
    sourceFile: "functions/src/triggers/activityOwner.ts",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U13",
  },
  {
    consumerName: "functions/src/triggers/adminAlertNotifier",
    sourceFile: "functions/src/triggers/adminAlertNotifier.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "functions/src/triggers/aiMatchTriggers",
    sourceFile: "functions/src/triggers/aiMatchTriggers.ts",
    collections: ["match_history", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guards DONE: typed-childcare intakes skip the senior onCreate/onUpdate matching fan-out (childcare demand flows through v1-createChildcareJobPost); childcare application/interview outcomes never write senior match_outcomes learning rows (R45 — per-vertical reputation is U8). Senior paths byte-identical.",
  },
  {
    consumerName: "functions/src/triggers/appointmentUpdated",
    sourceFile: "functions/src/triggers/appointmentUpdated.ts",
    collections: ["caregivers", "chatRooms", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: top-of-trigger careVertical=='child' skip (before/after) - childcare transitions notify through the child-safe callable path; the senior SMS flows (emergency replacement, caregiver copy) never fire for childcare docs. Senior path byte-identical."
  },
  {
    consumerName: "functions/src/triggers/carePlanHistory",
    sourceFile: "functions/src/triggers/carePlanHistory.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U11",
    notes: "Senior care-plan versioning; childcare has no care_plans doc.",
  },
  {
    consumerName: "functions/src/triggers/caregiverJobMatch",
    sourceFile: "functions/src/triggers/caregiverJobMatch.ts",
    collections: ["caregivers", "job_posts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "functions/src/triggers/checkinAlert",
    sourceFile: "functions/src/triggers/checkinAlert.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "functions/src/triggers/confidenceScoreTrigger",
    sourceFile: "functions/src/triggers/confidenceScoreTrigger.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/triggers/disputeResolution",
    sourceFile: "functions/src/triggers/disputeResolution.ts",
    collections: ["admin_alerts", "caregivers", "disputes", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: guarded childcare branch — a careVertical=='child' dispute HOLDS the occurrence payout rail (holdChildcareShiftPayout; already-paid-out escalates to admins, never a silent clawback) and both parties get generic child-safe IN-APP notices; escalation likewise in-app. Senior SMS dispute path byte-identical.",
  },
  {
    consumerName: "functions/src/triggers/familyEmergency",
    sourceFile: "functions/src/triggers/familyEmergency.ts",
    collections: ["admin_alerts", "appointments"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U12",
    notes: "Senior family-emergency escalation; childcare incidents use childcare_incidents deterministic routing (U12).",
  },
  {
    consumerName: "functions/src/triggers/interviewLinkTrigger",
    sourceFile: "functions/src/triggers/interviewLinkTrigger.ts",
    collections: ["caregivers", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guarded branch DONE: childcare interviews (careVertical=='child') get FULLY GENERIC calendar titles ('Evia Care Interview'), link-delivery SMS, request SMS, and reminders — no names, no child data (R35/R43). Senior strings byte-identical.",
  },
  {
    consumerName: "functions/src/triggers/jobApplicationTriggers",
    sourceFile: "functions/src/triggers/jobApplicationTriggers.ts",
    collections: ["caregivers", "job_posts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guarded branch DONE: childcare applications get a generic child-safe in-app notification (assertChildSafeOutboundPayload-checked) with an eligibility recheck (context 'contact') before notifying — never the senior LLM SMS path. The applicantCount counter trigger is vertical-neutral. Senior path byte-identical.",
  },
  {
    consumerName: "functions/src/triggers/jobNotifications",
    sourceFile: "functions/src/triggers/jobNotifications.ts",
    collections: ["admin_alerts", "caregivers", "job_applications", "job_posts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "U6 guards DONE: createJobPost and notifyAreaCaregivers refuse childcare-vertical input (fail closed — this fan-out has no eligibility gate, R34); closeJobPost structurally skips childcare (status filter) plus an explicit vertical check. Childcare notifications are the eligibility-gated in-app rows in jobCallables. Senior paths byte-identical.",
  },
  {
    consumerName: "functions/src/triggers/noShowPolicy",
    sourceFile: "functions/src/triggers/noShowPolicy.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "functions/src/triggers/notificationTriggers",
    sourceFile: "functions/src/triggers/notificationTriggers.ts",
    collections: ["booking_requests", "notifications", "shifts", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "U7 DONE: careVertical=='child' skips on onBookingRequestWrite, onBookingAmendmentWrite, and onShiftStatusChanged (childcare notifications are the generic child-safe rows written by bookingCallables at each transition; childcare booking completion is owned by the state machine, never the shift sweep). Senior paths byte-identical."
  },
  {
    consumerName: "functions/src/triggers/proactiveTriggerClaim",
    sourceFile: "functions/src/triggers/proactiveTriggerClaim.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/triggers/projectActivityFeed",
    sourceFile: "functions/src/triggers/projectActivityFeed.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "functions/src/triggers/projectSwapSummary",
    sourceFile: "functions/src/triggers/projectSwapSummary.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "functions/src/triggers/refundProcessor",
    sourceFile: "functions/src/triggers/refundProcessor.ts",
    collections: ["admin_alerts", "appointments", "shiftHours", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
    notes: "U8 DONE: childcare refunds ride the EXISTING state machine unchanged (claim transaction, Stripe refund + transfer reversal, stable idempotency keys — one refund per request under retries). Guarded branches: childcare refunds carry the R39 booking correlation in Stripe metadata, and the completion notice is a generic in-app notification instead of the senior SMS (childcare Evia flows are U10). Senior path byte-identical (characterized in triggers/refundProcessor.test.ts).",
  },
  {
    consumerName: "functions/src/triggers/reviewProjection",
    sourceFile: "functions/src/triggers/reviewProjection.ts",
    collections: ["reviews", "users"],
    disposition: "child-specific",
    ownerUnit: "U8",
    notes: "onChildcareReviewWritten (R45): routes careVertical=='child' review writes into childcare/reputationProjection (per-vertical aggregates) + a generic child-safe review notice. Senior reviews are a structural no-op here; the senior aggregate stays in index.ts onReviewWritten, which now explicitly skips childcare rows — the two triggers partition the reviews collection by vertical.",
  },
  {
    consumerName: "functions/src/triggers/triggerEngine",
    sourceFile: "functions/src/triggers/triggerEngine.ts",
    collections: ["admin_alerts", "agent_conversations", "appointments", "caregivers", "interview_requests", "senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },
  {
    consumerName: "functions/src/triggers/userCreated",
    sourceFile: "functions/src/triggers/userCreated.ts",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U4",
  },
  {
    consumerName: "functions/src/triggers/userTriggerManager",
    sourceFile: "functions/src/triggers/userTriggerManager.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U10",
  },

  // ── functions/src/utils ──
  {
    consumerName: "functions/src/utils/appointmentDoc",
    sourceFile: "functions/src/utils/appointmentDoc.ts",
    collections: ["appointments"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
    notes: "Review-named seam - U7 DONE: additive childcareApptFields() (careVertical:'child' + typed recipientRef childIds/householdId + age-band-safe recipientLabel + childcareBookingId), isChildcareVerticalDoc predicate, and assertChildSafeAppointmentDoc (structurally rejects seniorName/address/care detail on childcare docs - R46). canonicalApptFields and all 7 existing senior writers byte-identical."
  },
  {
    consumerName: "functions/src/utils/marketRateRange",
    sourceFile: "functions/src/utils/marketRateRange.ts",
    collections: ["caregivers"],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U1",
    notes: "Live senior (SCC) rate range; childcare pricing comes exclusively from U1 jurisdiction policy — never this range.",
  },

  // ── hooks ──
  {
    consumerName: "hooks/useAccessGates",
    sourceFile: "hooks/useAccessGates.tsx",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
  },
  {
    consumerName: "hooks/useAdminReports",
    sourceFile: "hooks/useAdminReports.ts",
    collections: ["reports", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U12",
  },
  {
    consumerName: "hooks/useCaregiverBookings",
    sourceFile: "hooks/useCaregiverBookings.ts",
    collections: ["booking_requests", "shifts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "hooks/useCaregiverCallout",
    sourceFile: "hooks/useCaregiverCallout.ts",
    collections: ["appointments", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U8",
  },
  {
    consumerName: "hooks/useJobApplications",
    sourceFile: "hooks/useJobApplications.ts",
    collections: ["caregivers", "job_applications", "job_posts"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "hooks/useNearbyCaregiversWithScores",
    sourceFile: "hooks/useNearbyCaregiversWithScores.ts",
    collections: ["job_postings", "job_posts", "publicCaregiverProfiles", "senior_profiles", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "hooks/useNotifications",
    sourceFile: "hooks/useNotifications.ts",
    collections: ["notifications", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9: safe unchanged - reads the caller's OWN users/{uid}/notifications rows, and every childcare row is registry-generic by construction (no child PII to display). No code change needed.",
  },
  {
    consumerName: "hooks/useOnboardingProgress",
    sourceFile: "hooks/useOnboardingProgress.ts",
    collections: ["job_postings", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U4",
  },
  {
    consumerName: "hooks/useOnboardingSteps",
    sourceFile: "hooks/useOnboardingSteps.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U5",
  },
  {
    consumerName: "hooks/useUnreadMessageCount",
    sourceFile: "hooks/useUnreadMessageCount.ts",
    collections: ["chatRooms"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9: safe unchanged - sums unreadCount over the caller's OWN rooms (participant-scoped query); childcare rooms contribute a count only, and v1-markChildcareConversationRead is the server seam that clears it (browser updates on childcare rooms are rules-denied; U11 wires the call).",
  },

  // ── services ──
  {
    consumerName: "services/api",
    sourceFile: "services/api.ts",
    collections: ["admin_alerts", "agent_action_ledger", "appointments", "caregivers", "family_group_members", "hire_requests", "interview_requests", "invoices", "job_applications", "job_postings", "job_posts", "notifications", "publicCaregiverProfiles", "reports", "reviews", "senior_profiles", "shiftHours", "threads", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U11",
    notes: "The primary browser data seam — every dbService accessor over a shared collection must be vertical-classified before childcare enablement.",
  },
  {
    consumerName: "services/availabilityService",
    sourceFile: "services/availabilityService.ts",
    collections: ["appointments"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U7",
  },
  {
    consumerName: "services/chatService",
    sourceFile: "services/chatService.ts",
    collections: ["chatRooms"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9 DONE: senior pairwise functions byte-identical (characterized in conversationPolicy.test.ts); ADDITIVE read-only childcare seam appended (isChildcareChatRoom + subscribeToChildcareMessages alias) - the browser lists childcare rooms via v1-listMyChildcareConversations, opens/sends/marks-read via callables, and only ever READS messages by server-listed room ID (rules deny every childcare write). UI wiring is U11.",
  },
  {
    consumerName: "services/documentUpload",
    sourceFile: "services/documentUpload.ts",
    collections: ["caregivers"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U3",
  },
  {
    consumerName: "services/matchFeedback",
    sourceFile: "services/matchFeedback.ts",
    collections: ["match_history", "users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
  {
    consumerName: "services/notificationService",
    sourceFile: "services/notificationService.ts",
    collections: [],
    disposition: "senior-only-explicit-skip",
    ownerUnit: "U9",
    notes: "U9 audited: browser-side SENIOR notification composer (payloads are senior-shaped - seniorId/seniorName); touches no Firestore collections directly. Childcare notification CONTENT is exclusively server-owned (childcare/notificationPolicy registry) - no childcare caller may route through this module.",
  },
  {
    consumerName: "services/matchService",
    sourceFile: "services/matchService.ts",
    collections: [],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
    notes: "Browser scoring logic used by matchingEngine/search; consumes caregiver docs fetched via services/api.ts. Childcare candidate sets never reach the browser unscoped.",
  },
  {
    consumerName: "services/pushNotificationService",
    sourceFile: "services/pushNotificationService.ts",
    collections: ["users"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U9",
    notes: "U9: safe unchanged - browser-side FCM token registration on the caller's own user doc; carries no message content. Childcare push CONTENT is server-owned (pushNotifications.ts generic branch).",
  },
  {
    consumerName: "services/server/matchingEngine",
    sourceFile: "services/server/matchingEngine.ts",
    collections: ["caregivers"],
    disposition: "disabled-before-childcare",
    ownerUnit: "U6",
    notes: "Review-named seam: browser-resident \"simulated server\" matching. Must stay outside the security boundary; disabled for childcare — child matching is server-callable only.",
  },
  {
    consumerName: "services/videoService",
    sourceFile: "services/videoService.ts",
    collections: ["video_interviews"],
    disposition: "shared-vertical-aware",
    ownerUnit: "U6",
  },
];

/** Entries grouped by disposition (docs table + release-gate summaries). */
export function consumersByDisposition(): Record<CareVerticalDisposition, ChildcareConsumerEntry[]> {
  const out: Record<CareVerticalDisposition, ChildcareConsumerEntry[]> = {
    "shared-vertical-aware": [],
    "senior-only-explicit-skip": [],
    "child-specific": [],
    "legacy-compat-remove-after-migration": [],
    "disabled-before-childcare": [],
  };
  for (const e of CHILDCARE_CONSUMER_MANIFEST) out[e.disposition].push(e);
  return out;
}

/** Every registered consumer touching the given shared collection. */
export function consumersOfCollection(collection: string): ChildcareConsumerEntry[] {
  return CHILDCARE_CONSUMER_MANIFEST.filter((e) => e.collections.includes(collection));
}

/** Registered source files (normalized) — the audit scanner's allow-set. */
export function registeredSourceFiles(): Set<string> {
  return new Set(CHILDCARE_CONSUMER_MANIFEST.map((e) => e.sourceFile));
}
