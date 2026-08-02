// Evia ↔ Web Firestore data contract.
//
// The launch invariant: **Evia must write where the web reads.** This module is
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

// ── Care vertical (childcare marketplace U0) ────────────────────────────────
//
// Every record in a shared collection (see CARE_VERTICAL_COLLECTIONS below)
// carries an explicit `careVertical` field after the U14 backfill migration:
//
//   careVertical: "senior" | "child"
//
// Resolution rule (the "legacy cutoff" contract):
//   • Records created BEFORE CARE_VERTICAL_MIGRATION_CUTOFF with an absent
//     careVertical MAY be resolved to "senior" by readers (every record that
//     exists before the childcare launch is a senior-vertical record by
//     construction — the migration stamps them, but a reader racing the
//     backfill may still see the unstamped shape).
//   • Records created AT/AFTER the cutoff with a missing or invalid
//     careVertical FAIL CLOSED: readers must treat them as unresolvable and
//     surface an explicit error state. They are NEVER silently resolved to
//     "senior" — a malformed child record entering a senior path is the
//     critical risk this rule exists to prevent.
//   • "child" is never inferred from record content. Only an explicit
//     careVertical === "child" stamp (written by U3+ childcare writers)
//     makes a record a child-vertical record.
//
// Consumer classification lives in data/childcareConsumerManifest.ts and is
// enforced by scripts/audit-childcare-consumers.mjs (npm run
// audit:childcare-consumers).
export type CareVertical = "senior" | "child";

// Sentinel meaning "the migration cutoff has not been chosen yet".
const CARE_VERTICAL_CUTOFF_PLACEHOLDER = "9999-12-31T23:59:59.999Z";

/**
 * ISO timestamp of the care-vertical migration cutoff.
 *
 * PLACEHOLDER — set at migration run time (U14). The value is deliberately a
 * far-future sentinel until the founder runs the backfill; while it is the
 * placeholder, isCareVerticalCutoffSet() returns false and the backfill
 * migration refuses to apply (dry-run only), so the legacy-grace rule can
 * never be evaluated against an unset cutoff.
 */
export const CARE_VERTICAL_MIGRATION_CUTOFF = CARE_VERTICAL_CUTOFF_PLACEHOLDER;

/** True once CARE_VERTICAL_MIGRATION_CUTOFF has been set to a real timestamp. */
export function isCareVerticalCutoffSet(): boolean {
  return CARE_VERTICAL_MIGRATION_CUTOFF !== CARE_VERTICAL_CUTOFF_PLACEHOLDER;
}

/**
 * Shared collections whose records carry the `careVertical` field. These are
 * the collections the U14 backfill (migrations/backfillCareVertical.ts) stamps
 * with careVertical:"senior" for legacy records. senior_profiles is included
 * even though it is always "senior" by construction (child profiles live in
 * the separate child_profiles collection, U3) so that a uniform reader
 * assertion holds across every shared store. Memory/audit/ops collections are
 * governed by the consumer manifest (memory is denied for childcare turns)
 * rather than a per-record stamp.
 */
export const CARE_VERTICAL_COLLECTIONS: readonly string[] = [
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
] as const;

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
  /** Who writes it in the Evia/functions backend */
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
    notes: "Evia writes membership/identity status for clients and the caregiver parity doc at finalization.",
  },
  caregivers: {
    path: "caregivers",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "uid-keyed since the identity unification; legacy random-ID docs are migrated at finalization. Checkr webhook looks up by backgroundCheckData.checkrCandidateId (query, ID-agnostic).",
  },
  publicCaregiverProfiles: {
    path: "publicCaregiverProfiles",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Server-maintained public projection used by caregiver discovery and profile surfaces; source caregiver documents remain private.",
  },
  clientIntakes: {
    path: "clientIntakes",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Evia onboarding writes clientIntakes/{uid}; matching triggers listen onCreate/onUpdate.",
  },
  senior_profiles: {
    path: "senior_profiles",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Web signup creates it; Evia onboarding mirrors senior name/age/needs/diagnoses.",
  },
  agent_objectives: {
    path: "agent_objectives",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Canonical objective ledger (plan 2026-07-18-001 U3, dark in Wave 1). Server-only: clients denied by the rules catch-all; no chain-of-thought or transcript text is ever stored (R14). Query contract Q28. Childcare U4: optional additive careVertical stamp (absent = legacy senior); the family childcare-enrollment objective is the FIRST production writer — deterministic per-adult doc ID childcare-family-signup_{uid} via ensureObjective (create-once, AE15), written by childcare/signupIngress.ts.",
  },
  care_plans: {
    path: "care_plans",
    // Keyed by the client's Firebase Auth uid (care_plans/{clientId}) — the
    // canonical "uid" scheme; "clientUid" was never a DocIdScheme member.
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Canonical live care plan (2026-07-06 decision; web cut over 2026-07-12). Evia's get/update_care_plan tools and the web Care Plan tab share this doc; versions subcollection is server-only history. Legacy senior_profiles/{uid}/care_plans/default is read-fallback only.",
  },
  carePlans: {
    path: "carePlans",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "CarePlan.tsx reads/writes carePlans/{uid}; Evia writes the initial doc at client payment.",
  },
  job_postings: {
    path: "job_postings",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Per-client job posting mirror (job_postings/{clientUid}); kept in sync with job_posts. SENIOR-ONLY (childcare U6, R32): childcare-vertical jobs NEVER write this singleton — assertLegacyJobMirrorAllowed guards every server mirror writer (buildAndSaveJobPost, mcp edit_job_post) and firestore.rules rejects browser careVertical:'child' writes.",
  },
  job_posts: {
    path: "job_posts",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "The job board. Senior jobs written via buildAndSaveJobPost (shared by Evia + web flows). Childcare U6: childcare jobs are ADDITIVE server-only docs (v1-createChildcareJobPost) — careVertical:'child', status 'open_childcare' (never 'open', so every senior status=='open' consumer structurally skips them), typed childRequirements projection (age bands/categories/credentials/transport ONLY — R33/AE12), approximate area (server geocode, rounded coords), disclosurePhase stamp; child linkage (childIds/householdId) lives in job_posts/{id}/private/children (rules: fully server-only). Queries Q32/Q33. Browser childcare writes rules-denied.",
  },
  appointments: {
    path: "appointments",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes:
      "Created pending_caregiver_confirmation; confirmed only after the caregiver accepts the shift offer. " +
      "Childcare U7: childcare appointments are ADDITIVE server-only docs materialized at booking " +
      "confirmation (deterministic cappt_ IDs) — every writer spreads canonicalApptFields() + " +
      "childcareApptFields() (utils/appointmentDoc.ts): careVertical:'child', typed recipientRef " +
      "(childIds/householdId), age-band-safe recipientLabel ONLY — no seniorName/address/care details " +
      "(R46, assertChildSafeAppointmentDoc). Same blocking statuses as senior, so the shared conflict gate " +
      "(Q38) blocks cross-vertical double-booking in both directions. NO billingAuthority stamp (childcare " +
      "money is U8). Browser childcare writes rules-denied; onAppointmentUpdated skips childcare docs.",
  },
  booking_requests: {
    path: "booking_requests",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes:
      "Web-originated booking requests; Evia's equivalent is agent_tasks(type=booking_confirmation) + " +
      "shift_offers. Childcare U7: childcare bookings are ADDITIVE server-only docs (v1-requestChildcareBooking " +
      "et al) — careVertical:'child', deterministic cbook_ IDs (duplicate requests converge, AE15), status " +
      "vocabulary requested/accepted/confirmed/in_progress/completed/declined/canceled (entry state 'requested', " +
      "never senior 'pending'), typed recipient REFERENCES (childIds/householdId) + age-band-safe display " +
      "label only (R46), stateVersion optimistic concurrency, paymentAuthorization state + correlation ID " +
      "(Stripe flows are U8), eligibilitySnapshot + lastTransitionEvidence stamps. Queries Q34/Q35. Browser " +
      "childcare writes rules-denied; senior consumers guard on the vertical stamp (shiftGenerator, " +
      "notificationTriggers).",
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
    notes: "Clock-in/out + payroll. Evia writes via clock_in_shift / submit_shift_hours tools. Childcare U8 (R39/R40): childcare rows are ADDITIVE careVertical:'child' docs created ONLY by childcare/shiftPayments.createChildcareValidatedShiftHoursForToday at provider check-out (server-derived hours; billingAuthority 'childcare-server-v1'; billingUserId = the recorded payer; childcarePricing = frozen policy fee snapshot; childcareBookingId/childcareShiftId ledger correlation). They then ride the SAME proven charge/transfer machinery (processShiftPayment/settleShiftTransfer) with a childcare fee branch; every senior timesheet source fails closed on childcare appointments.",
  },
  threads: {
    path: "threads/{threadId}/messages",
    docId: "subcollection",
    caraWrites: true,
    webReads: true,
    notes: "Web chat. Evia conversations are mirrored in (linq/threadMirror.ts, thread ID cara_{uid}).",
  },
  support_tickets: {
    path: "support_tickets",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Evia's create_support_ticket tool writes here; admin TicketManager reads.",
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
    notes: "Evia-drafted proactive messages awaiting admin review.",
  },
  cara_turn_metrics: {
    path: "cara_turn_metrics",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Bounded no-message-text mirror for experiment and conversation-quality turns; AdminCaraControlRoom reads flagged rows.",
  },
  referrals: {
    path: "referrals",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Client/caregiver referral lifecycle. Evia writes SMS referrals; web ReferralProgram reads user referral status.",
  },
  agent_audit_log: {
    path: "agent_audit_log",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Every consequential agent action (observability/auditLog.ts); AuditTrail admin surface reads. Memory-grounding U4b: memory_fact_corrected / memory_fact_forgotten completion entries (worker + MCP memory tools) are the durable accountability trail for cross-store fact changes — written before the memory_operations record becomes expiry-eligible; data carries category/source metadata only, never fact text.",
  },
  agent_action_ledger: {
    path: "agent_action_ledger",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Durable status ledger for consequential Evia actions; admin audit surfaces read it.",
  },
  pending_actions: {
    path: "pending_actions",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Runtime confirmation queue for high-risk Evia actions; AdminCaraControlRoom reads stuck and awaiting approvals.",
  },
  agent_tasks: {
    path: "agent_tasks",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes:
      "Booking/replacement task records written server-side across matchingAgent, replacementAgent, bookingExecutor, shiftOffer, triggers, etc. Two web readers: (1) the public QuickConfirmPage reads the SINGLE token-scoped doc via where('confirmToken','=='), (2) admin AuditDashboard reads awaiting tasks. Web writes are NOT allowed — confirmation is committed server-side via the confirmAgentTask callable. Rules: token-scoped reads for the public page + admin reads; writes denied.",
  },
  agent_tasks_active: {
    path: "agent_tasks_active",
    docId: "phone",
    caraWrites: true,
    webReads: false,
    notes:
      "Server-only single-active-task index keyed by clientPhone (replacementAgent/triggerEngine/qaAgent). No web reader — used only by backend routing to know if a replacement search is in-flight. No rules block required (default-deny is correct).",
  },
  agent_approvals: {
    path: "agent_approvals",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes:
      "Human-approval audit record for the quick-confirm flow. Was previously written DIRECTLY by QuickConfirmPage; now written server-side by the confirmAgentTask callable (Admin SDK). No web reader. Rules: deny all client access.",
  },

  // ── Pre-registry collections backfilled in U10 ──────────────────────────────
  // These predate the contract registry but are genuinely shared (or audit
  // entities that must be lifecycle-governed). Registered here with accurate
  // access classes; firestore.rules carries the matching match block.
  chatRooms: {
    path: "chatRooms",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "1:1 client↔caregiver messaging (services/chatService.ts). Evia touches via the pushNotifications onCreate trigger. Participant-scoped reads; admin can read all. Childcare U9 (plan 2026-07-22-002, KTD14/R41-R42): childcare context rooms are ADDITIVE careVertical:'child' docs with deterministic cchat_ IDs, SERVER-owned (browser create/update/delete and message writes rules-denied; creation/sends via v1 conversation callables in childcare/conversationCallables.ts); rooms carry contextType/contextId/disclosurePhase/accessVersion/state, participants array = CURRENT access (revocation removes the uid), lastMessage is ALWAYS a generic label (message text never leaves the participants-only messages subcollection — childcare message reads have no admin branch, R55). Senior pairwise rooms byte-identical.",
  },
  customers: {
    path: "customers",
    docId: "uid",
    caraWrites: true,
    webReads: true,
    notes: "Stripe customer + subscriptions subcollection (customers/{uid}/subscriptions). Web reads its own via stripeService.ts; Stripe webhooks (functions/src/stripe.ts) write. Client writes denied (webhook-only).",
  },
  disputes: {
    path: "disputes",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Payment/appointment dispute records with SLA escalation (functions/src/triggers/disputeResolution.ts). Server-only today; no web reader. Audit-sensitive: client-destructive delete is blocked.",
  },
  hire_requests: {
    path: "hire_requests",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Formal hire request after interview (services/api.ts submitHireRequest; functions matching.ts + mcp/server.ts). Client/caregiver/admin read; coordinator approves.",
  },
  interview_requests: {
    path: "interview_requests",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Caregiver interview scheduling + fit feedback. Web (api.ts, caregiver dashboards) and Evia (interviewAgent.ts) both write.",
  },
  interviews: {
    path: "interviews",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Scheduled interview record with Google Meet link + ICS (callUrl/icsUrl/clientId/caregiverId; written by functions/src/agents/interviewAgent.ts, links via agents/interviewLinks.ts, enforced by triggers/interviewLinkTrigger.ts). Client reads pending interviews; writes server-side only.",
  },
  job_applications: {
    path: "job_applications",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Caregiver applications to job posts. Caregiver creates; client accepts/rejects; caregiver can withdraw (status='withdrawn', U2). applicantCount maintained by jobApplicationTriggers. Childcare U6: childcare applications are ADDITIVE server-only docs (v1-applyToChildcareJob — hard eligibility recheck context 'application' precedes the write, R29/R34) — careVertical:'child', disclosurePhase + eligibilityVersion stamps, deterministic capp_ doc ID (duplicate-application idempotency), safe job snapshot only (no phone, no child facts). Browser childcare writes rules-denied; U7: family accept/reject landed as v1-acceptChildcareApplication / v1-rejectChildcareApplication (identity + per-child schedule authority + provider recheck; accepted applications feed v1-requestChildcareBooking).",
  },
  invoices: {
    path: "invoices",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Billing invoices (functions/src/invoicing.ts; mcp/server.ts). Admin + owning client/caregiver read. Writes server-side only. Audit/payment entity: only admin may delete (audited via onInvoiceDeleted).",
  },
  payments: {
    path: "payments",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Stripe subscription payment ledger keyed by userId field (functions/src/stripe.ts webhooks; mcp/server.ts reads). No direct frontend reader today (rules permit owner read for a future surface). Payment entity: client-destructive delete is blocked.",
  },
  payouts: {
    path: "payouts",
    docId: "auto",
    caraWrites: false,
    webReads: true,
    notes: "Caregiver payout ledger. Per-caregiver subcollection (caregivers/{uid}/payouts, PayoutHistory.tsx) AND a top-level admin mirror read by FinanceDashboard. Written via payoutCommon.executeInstantPayout (all instant-payout paths) and stripeConnectWebhook (automatic daily payouts, payout.paid/failed) — Admin SDK only. Payment entity: client-destructive delete blocked.",
  },
  reports: {
    path: "reports",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "User abuse/safety reports. Web users create their own (InboxView.tsx); Evia/mcp may file reports; admins review. Author-scoped create, admin read.",
  },
  reviews: {
    path: "reviews",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Client→caregiver post-visit reviews (services/api.ts, ReviewSystem.tsx; Evia via mcp/server.ts submit_review). Public read; author-scoped write. Childcare U8 (R44/R45): childcare reviews are ADDITIVE careVertical:'child' docs with deterministic crev_ IDs, created ONLY by v1-submitChildcareReview (booking participants, verified completion, once per reviewer+booking, moderationState field, NO child fields — pinned key set); browser childcare writes rules-denied; senior aggregation (index.ts onReviewWritten) and the childcare projection (triggers/reviewProjection.ts) are mutually exclusive by the vertical stamp.",
  },
  seniors: {
    path: "seniors",
    docId: "auto",
    caraWrites: false,
    webReads: false,
    notes: "LEGACY senior context records keyed by seniorId — read fallback ONLY. New reads go through data/seniorProfileRepository.getSeniorProfileWithSource (canonical senior_profiles first; this collection consulted only when no canonical doc exists — U6/R17, memory-grounding plan 2026-07-17). No new writers. NOT the web senior store — that is senior_profiles. Server-only; no web reader. Distinct from the UI plural label 'seniors'.",
  },
  shifts: {
    path: "shifts",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes:
      "GPS clock-in/out shift instances generated from recurring bookings (shiftGenerator.ts) and touched " +
      "by Evia (mcp/server.ts). Caregiver/client/admin participant-scoped. Childcare U7: childcare shifts " +
      "are ADDITIVE server-only docs (deterministic cshift_ IDs; generated by the guarded childcare branch " +
      "of shiftGenerator + the flag-gated rolling sweep) — careVertical:'child', typed recipientRef + " +
      "recipientLabel only, NO address/careNeeds/emergencyContact (R46). Queries Q40/Q41. Browser childcare " +
      "writes rules-denied; onShiftStatusChanged skips childcare docs (check-in/out is callable-owned).",
  },
  video_interviews: {
    path: "video_interviews",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Google Meet interview scheduling (web modal; Evia via mcp/server.ts schedule_interview). Link fields callUrl/icsUrl/linkDelivery/linkWork/remindersScheduledAt/requestNotifiedAt set via agents/interviewLinks.ts, enforced by triggers/interviewLinkTrigger.ts. Client/caregiver participant-scoped.",
  },
  web_onboarding_sessions: {
    path: "web_onboarding_sessions",
    docId: "phone",
    caraWrites: true,
    webReads: true,
    notes: "Bridge between web phone verification and SMS inbound (functions/src/linq/webhooks.ts). Carries role + (optional) name typed on /start; the inbound webhook seeds name into agent_sessions.onboardingData (firstName for client, name for caregiver) and routes to the *_confirm_name step so Evia greets by name. Web reads its own doc (hooks/useOnboardingSession.ts); writes server-side only (createWebOnboardingSession callable). Childcare U4: ADDITIVE optional careVertical:'child' stamp (typed intent, R47) written only for a client-role childcare request while the Firestore-resident childcare flags are on; absent field = senior default. The stamp routes the first inbound to childcare/signupIngress.ts (which also writes childcareObjectiveId on connect); NEVER carries child names/ages/details (R57).",
  },
  notifications: {
    path: "notifications",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Top-level user notifications (bookings, replies, alerts). Web reads own (userId field); Evia/admin write (admin/adminSupportActions.ts, services/api.ts). Distinct from the users/{uid}/notifications subcollection.",
  },

  // ── Childcare policy + rollout flags (childcare marketplace plan
  // 2026-07-22-002, U1) ────────────────────────────────────────────────────────
  // Server-only childcare governance documents. Neither is read or written by
  // the web app; both are registered in data/childcareConsumerManifest.ts (the
  // first "child-specific" consumers) and watched by
  // scripts/audit-childcare-consumers.mjs.
  jurisdiction_care_policies: {
    path: "jurisdiction_care_policies",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Versioned per-state childcare policy record keyed by state code (jurisdiction_care_policies/CA). " +
      "Read via childcare/jurisdictionPolicy.ts (loadJurisdictionPolicy / evaluateJurisdictionReadiness); " +
      "written ONLY by the founder-run seeding migration (U14) — never by clients or the agent loop. " +
      "FAIL-CLOSED: an absent, expired, deferred-category, unset-pricing, or approval-reference-incomplete " +
      "policy blocks activation (R23-R31/R40/R58). Client mutation denial is U2 Rules work; until then the " +
      "rules catch-all default-denies (no web reader exists). Human mirror: docs/policies/childcare-jurisdictions.md.",
  },
  caregiver_reputation: {
    path: "caregiver_reputation",
    docId: "uid",
    caraWrites: true,
    webReads: false,
    notes:
      "Per-caregiver reputation doc (ai/caregiverReputation.ts): time-decayed senior hire/pass score in the " +
      "legacy UNPREFIXED fields (score/lastOutcomeAt/hireCount/passCount) + the childcare U8 child-prefixed " +
      "aggregates (childRatingAvg/childCompletedBookingCount/... written by childcare/reputationProjection.ts). " +
      "R45: the two field families never mix — senior matching reads only the unprefixed fields, childcare " +
      "scoring reads only the child summary. Server-only (no rules block ⇒ default deny; no web reader).",
  },
  childcare_pricing_configs: {
    path: "childcare_pricing_configs",
    docId: "composite",
    caraWrites: false,
    webReads: false,
    notes:
      "Founder-approved childcare pricing configuration (U8, R40): documents keyed by the opaque ref IDs the " +
      "jurisdiction_care_policies pricing refs point at (kind: caregiver_fee | cancellation_policy | " +
      "refund_policy | family_entitlement | screening_fee | sibling_policy). Read ONLY via " +
      "childcare/paymentPolicy.resolveChildcarePricingSnapshot, which FAILS CLOSED on any unset ref, missing " +
      "doc, or malformed value — childcare amounts are never derived from senior defaults. Written only by a " +
      "founder-run seeding migration (U14); server-only (no rules block ⇒ default deny; no web reader).",
  },
  childcare_flags: {
    path: "childcare_flags",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Firestore-resident runtime childcare flags (R61): 'global' doc + per-state overlay docs keyed by state " +
      "code (childcare_flags/CA). Read via config/featureFlags.getChildcareFlags with a 60s TTL in-memory " +
      "cache + bustChildcareFlagsCache(); absent doc/flag ⇒ OFF (childcare is OPT-IN, fail-closed — the " +
      "opposite default from the senior env-var kill switches); emergencyOff in either doc force-falses every " +
      "childcare flag WITHOUT a redeploy. Server/ops-written only; no web reader (U2 adds the Rules deny tests).",
  },

  // ── Household / guardian-authority collections (childcare marketplace plan
  // 2026-07-22-002, U2) ────────────────────────────────────────────────────────
  // All writes are server-only (authorityCallables.ts + repositories via Admin
  // SDK); firestore.rules denies every browser write. Browser reads are scoped
  // to the caller's OWN membership/authority rows (rules blocks exist), but no
  // web reader ships until U11 — webReads stays false until then.
  households: {
    path: "households",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Canonical adult household (R3): primary adult, status, accessVersion, versioned derived " +
      "recipient/vertical summary. Doc ID is SEEDED from the primary adult uid (hh_{uid}) as a creation " +
      "idempotency scheme only — Rules authorize via household_memberships get(), never via the ID shape. " +
      "Written by childcare/householdRepository.ts; browser writes denied.",
  },
  household_memberships: {
    path: "household_memberships",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Adult-to-household membership ({householdId}__{adultUid}; provisional phone-only rows use a phone " +
      "HASH suffix and adultUid:null). MEMBERSHIP GRANTS NOTHING (R7/AE4) — every permission is an explicit " +
      "guardian_authorities record. Provisional (SMS-joined, unauthenticated) members hold zero grantable " +
      "scopes; the legacy phone-keyed family_groups readers stay senior-only (recycled-number risk). " +
      "Server-written only; owner-scoped browser read via rules.",
  },
  guardian_authorities: {
    path: "guardian_authorities",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "THE authority source (R6/KTD3) — {childId}__{adultUid} records carrying recipient-scoped grants " +
      "(view/schedule/message/pickup/emergency/cancellation/payment/management), state machine " +
      "(active/dispute_hold/revoked/expired), accessVersion, and the R18 co-guardian dispute-hold record. " +
      "checkAuthority (childcare/guardianAuthority.ts) is the only permission primitive; embedded guardian " +
      "lists elsewhere are versioned derived caches that never authorize. Server-written only; owner-scoped " +
      "browser read via rules.",
  },
  childcare_invite_tokens: {
    path: "childcare_invite_tokens",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Household adult-invite tokens (U2): bound to household + intended contact + expiry + single-use " +
      "nonce HASH + proposed scopes. Acceptance requires the invited adult's own auth + verified contact " +
      "match + consent; replay/expiry/wrong-contact fail closed with one enumeration-safe error. FULLY " +
      "server-only — rules deny all client reads and writes (token secrecy).",
  },
  guardianAuthorityOutbox: {
    path: "guardianAuthorityOutbox",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Durable outbox for authority-change effects (KTD23, pattern: billingApprovalOutbox): co-guardian " +
      "revocation notices (R18) and derived-access invalidation fan-out, created transactionally with the " +
      "accessVersion bump and drained by dispatchGuardianAuthorityOutbox with claim/lease/retry/terminal " +
      "semantics. Query contract Q30. Server-only; rules deny all client access.",
  },

  // ── Child profiles + privacy lifecycle (childcare marketplace plan
  // 2026-07-22-002, U3) ────────────────────────────────────────────────────────
  // All writes are server-only (data/childProfileRepository.ts +
  // privacy/dataLifecycle.ts via Admin SDK); firestore.rules denies every
  // browser write. The ONLY browser read is the child_profiles operational
  // summary via the authorizedViewerUids rules check — no web reader ships
  // until U11, so webReads stays false until then.
  child_profiles: {
    path: "child_profiles",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "OPERATIONAL SUMMARY zone (R10/KTD7): display label, age BAND (never exact DOB), household, broad " +
      "care categories, state (active/aged_out/deleted — age-out is an EXPLICIT transition, R16), " +
      "version-stamped authorizedViewerUids derived cache (R6 — display read only, never authority; " +
      "guardian_authorities + checkAuthority remain the only permission source), accessVersion, legal hold, " +
      "retention policy version. STRUCTURALLY no child contact/identity fields — a child never has an " +
      "email, phone, or Firebase Auth uid (R9; assertNoChildIdentityContactFields). The RESTRICTED zone " +
      "lives under child_profiles/{childId}/private (safety pointer doc + immutable " +
      "private/safety/versions/{v} with exact DOB/emergency contacts/health/pickup/custody + file_{id} " +
      "records for childcare/childFileAccess.ts) — server-only, no browser path; files served exclusively " +
      "by short-lived Admin-SDK signed URLs (R12, never stored download tokens).",
  },
  data_lifecycle_requests: {
    path: "data_lifecycle_requests",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Durable export/delete/redact state machine (R13-R15/KTD21, privacy/dataLifecycle.ts): recent-auth + " +
      "authority gates at creation, legal-hold checks (creation AND execution), per-target task fan-out " +
      "(viewer revocation, Firestore tombstone + private purge, Storage deletes, ai-reference scan, Stripe " +
      "Identity redaction tracked as awaiting_provider state only, orphan-file scan, export bundle), " +
      "bounded retries with backoff, terminal proof (counts + completion timestamps). Drained by " +
      "scheduled/childcareLifecycleWorker.ts (query contract Q31). Deleting Firebase Auth alone is never " +
      "account deletion (R15) — beginAdultAccountDeletion is the server-owned entry point (not yet wired " +
      "into Auth-deletion paths; that reclassification is U12/U14 work). Server-only; user-visible status " +
      "via v1-getLifecycleRequestStatus.",
  },

  // ── Family signup, consent receipts + identity gate (childcare marketplace
  // plan 2026-07-22-002, U4) ──────────────────────────────────────────────────
  consent_receipts: {
    path: "consent_receipts",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Versioned consent receipts (R23, childcare/consentReceipts.ts): one immutable doc per (adult, " +
      "policyType, policyVersion) — deterministic ID, create-once idempotency. Policy versions come from " +
      "jurisdiction_care_policies consentVersions; an unpopulated version records state " +
      "'pending-policy-version' (dark-mode testable) while the U1 readiness evaluator's " +
      "consent_version_missing keeps activation blocked. Revocation stamps revokedAt (STOP revokes " +
      "communicationConsent) — receipts are never booleans, never deleted. Carries adult uid + policy " +
      "identifiers ONLY, never child PII (R57). Server-only; firestore.rules denies all browser access.",
  },
  childcare_identity_sessions: {
    path: "childcare_identity_sessions",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "One Stripe Identity verification session per childcare objective (R17/R22, " +
      "childcare/identityCallables.ts), keyed by objectiveId: adultUid, stripeSessionId, status mirror " +
      "(created/processing/requires_input/verified/canceled), supersededSessionIds (only a CANCELED " +
      "session is ever replaced). Status is mirrored from the Stripe webhook (stripe.ts additive hook) and " +
      "from live retrieves — never from URL params. Stripe metadata carries ONLY firebaseUID + " +
      "childcareObjectiveId (no phone, no child PII — R57). Server-only.",
  },
  childcare_identity_callbacks: {
    path: "childcare_identity_callbacks",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "One-time identity callback states (R22, childcare/identityCallables.ts), keyed by nonce: binds the " +
      "authenticated adult + objective + expected Stripe session + 30-min expiry + transactional one-time " +
      "consumption. Consumed exclusively via v1-consumeChildcareIdentityCallback (wrong-user probes get " +
      "the enumeration-safe generic denial; expiry/replay codes surface only to the matching adult). " +
      "Server-only.",
  },

  // ── Provider vertical profiles + screenings (childcare marketplace plan
  // 2026-07-22-002, U5 / KTD9-KTD10) ─────────────────────────────────────────
  vertical_profiles: {
    path: "caregivers/{uid}/vertical_profiles/{vertical}",
    docId: "subcollection",
    caraWrites: true,
    webReads: false,
    notes:
      "Namespaced per-vertical provider profile (KTD9/R24): childcare services, age bands, experience, " +
      "childcare rate, transport capability, limitations, credentials, jurisdiction, policy acceptance, " +
      "MANUAL approval state (R28 — operator decision, never Checkr state), and suspension. Written ONLY " +
      "by childcare/providerVerticalCallables.ts (+ providerEligibility recompute); childcare fields never " +
      "overwrite senior services/rates/approval/reputation on the parent doc. Rules: owner-read, " +
      "server-write-only; no web reader ships until U11 (webReads stays false until then).",
  },
  screenings: {
    path: "caregivers/{uid}/screenings/{vertical}",
    docId: "subcollection",
    caraWrites: true,
    webReads: false,
    notes:
      "Per-vertical screening EVIDENCE record (amended R26/R27/KTD10, childcare/screeningPolicy.ts): " +
      "shared base Checkr package (founder decision 2026-07-22) with independent per-vertical evaluation, " +
      "renewal (annual default), adverse-action state, and eligibility version. Stores minimal provider " +
      "references only (candidate/invitation/report ids) — never raw reports or candidate PII. Updated by " +
      "the checkr.ts webhook mirror ONLY for events matching its provider references (doc-level " +
      "idempotency for duplicates/out-of-order). Rules: FULLY server-only (evidence — reads denied too; " +
      "own status flows through v1-getMyChildcareProviderState).",
  },

  // ── Booking safety projections (childcare marketplace plan 2026-07-22-002,
  // U7 / KTD13, R38) ─────────────────────────────────────────────────────────
  childcare_booking_safety: {
    path: "childcare_booking_safety",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Versioned booking safety projections (KTD13/R38, childcare/safetyProjection.ts): pointer doc keyed " +
      "by bookingId (childIds, assignedCaregiverUid, currentVersion, participant accessVersion, state) + " +
      "immutable minimum projections at versions/{n} (explicit field allowlist — display label, age band, " +
      "pickup notes, emergency contacts, care notes; NEVER exact DOB/custody/address). Revoke-before-" +
      "replace by construction: every new version atomically bumps the accessVersion (AE6); reads require " +
      "an exact access-version match plus current booking state, assigned caregiver, and provider " +
      "eligibility (context safety_read) via v1-getChildcareBookingSafety. Queries Q36/Q37. Rules: FULLY " +
      "server-only (pointer AND versions — no browser path, no isAdmin branch).",
  },

  // ── Restricted incident cases + operator scope grants (childcare marketplace
  // plan 2026-07-22-002, U12 / R53, R55-R56, AE18, AE24) ─────────────────────
  childcare_incidents: {
    path: "childcare_incidents",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes:
      "Restricted childcare incident cases (childcare/incidentPolicy.ts): ONE case per U10 incident marker " +
      "(deterministic cinc_ ids — duplicate markers/reports converge, AE24) or direct operator report. " +
      "Deterministic categories (U10 classifier + operator allowlist), status workflow map (open → " +
      "investigating → resolved/escalated + appeal/correction) with append-only in-doc history, case owner, " +
      "evidence REFERENCES only (opaque ids — never copies of child data, R57), suspected-party exclusion " +
      "(unions booking_requests.excludedUids — U9 fan-out skip), U8 payout holds, U3 litigation holds. " +
      "Rules: FULLY server-only — browser reads denied even to admins (R55); the sanitized queue flows " +
      "through v1-listChildcareIncidents, detail through v1-getChildcareIncidentDetail (childSafetyOperator " +
      "+ recorded reason, R56). Ungated by childcare flags: incident handling works during emergency-off.",
  },
  childcare_operators: {
    path: "childcare_operators",
    docId: "uid",
    caraWrites: false,
    webReads: false,
    notes:
      "Least-privilege operator scope grants (admin/requireOperatorScope.ts, R55/KTD20): scopes[] strings " +
      "(pilot: childSafetyOperator, generalOperator — six-role split later adds constants, not call-site " +
      "changes) + active flag. childSafetyOperator is satisfied ONLY by an explicit active grant (broad " +
      "isAdmin never implies it — AE18); generalOperator by a grant OR broad isAdmin (pilot decision). " +
      "FOUNDER-PROVISIONED via the Admin SDK only — no callable writes this collection (scope self-grant " +
      "impossible), which is why caraWrites is false. Rules: FULLY server-only (roster enumeration denied).",
  },

  // ── Agent-memory + signal collections (agent-native audit 2026-07) ─────────
  // Server/agent-only access class: Evia writes them, the web never reads them
  // (webReads: false, so no firestore.rules block is required — default-deny is
  // correct). Registered so the contract test governs their lifecycle instead of
  // leaving them on the runtime-only allowlist.
  learned_facts: {
    path: "learned_facts",
    docId: "uid",
    caraWrites: true,
    webReads: false,
    notes: "Per-user learned-fact store (memory/learnedFacts.ts). Parent doc keyed by userId; facts live in the facts subcollection. Server/agent-only.",
  },
  facts: {
    path: "learned_facts/{userId}/facts",
    docId: "subcollection",
    caraWrites: true,
    webReads: false,
    notes: "Individual learned facts under learned_facts/{userId}. Written/read by memory/learnedFacts.ts only. Server/agent-only. Memory-grounding U3 (KTD7/R23): new facts use deterministic nf_{normHash} doc IDs; docs carry bounded mentionTurnKeys (retry-safe per-source-turn weight increments) and bounded sourceMessageRefs provenance paths. Memory-grounding U4 (KTD9/KTD16): staged changes add pendingCorrectionOperationId/pendingForgetOperationId (fact ineligible for ALL retrieval while set), forgottenFingerprint + fingerprintKeyVersion (server-only HMAC-SHA256 of the normalized retired plaintext, keyed by the MEMORY_FINGERPRINT_KEY secret — blocks passive re-extraction; forgottenAt set at forget completion when plaintext/embedding are stripped), changeGeneration (bumped by confirmed re-remember; versions deterministic operation IDs), and reRememberedAt.",
  },
  memory_operations: {
    path: "memory_operations",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes: "Server-only durable retry ledger for cross-store memory writes (memory/memoryOperations.ts; drained by scheduled/memoryOperationWorker.ts via the shared leased-operation engine in operations/externalSideEffect.ts). Deterministic doc IDs from the source-turn key hash (turn_sync_{hash}); kinds: turn_sync (U3), correction/forget ({kind}_{sha(userId:factDocId:changeGeneration)} — staged in U4a, propagated by the U4b worker: Storage reconcile, embedding purge, Zep edge invalidAt/delete + source-episode delete, source-row consolidation exclusion, tombstone finalize; completion writes a durable agent_audit_log memory_fact_corrected/forgotten entry BEFORE the record becomes expiry-eligible and then clears the memory_reconciliation flag entry), re_remember (already-completed audit record for a confirmed tombstone clear), and mcpfile_{kind}_{hash} (already-completed records for identity-validated MCP delete/edit memory-file changes; carry fileSlug — a file NAME, never fact text). Docs hold references/hashes/statuses/timestamps ONLY — never raw message text, fact text, phone scalars, or Zep user/thread/edge/episode IDs (reference paths may resolve to phone-keyed docs; never logged). Explicit deny block in firestore.rules. Completed ops expire after 30 days (expiresAt); failed/unresolved ops never auto-expire.",
  },
  memory_reconciliation: {
    path: "memory_reconciliation",
    docId: "uid",
    caraWrites: true,
    webReads: false,
    notes: "Server-only per-user correction/forget suppression flag (memory-grounding U4a, KTD9). One doc per userId holding pendingOperations: {operationId: {kind, createdAt}} — operation IDs/kinds ONLY, never fact text. Maintained TRANSACTIONALLY with staging in memory/learnedFacts.ts; read as a single cheap point read by every shared memory reader (getMemoryContext, searchMemory*, searchZepMemory, qaAgent prompt assembly) to enforce reconciliation suppression; the worker (U4b) clears entries on completion and the reader self-heals completed/expired entries. Explicit deny block in firestore.rules.",
  },
  memory_embeddings: {
    path: "memory_embeddings",
    docId: "uid",
    caraWrites: true,
    webReads: false,
    notes: "Semantic-search index for memory files (memory/memoryFiles.ts). Parent doc keyed by userId; vectors live in the blocks subcollection. Server/agent-only.",
  },
  blocks: {
    path: "memory_embeddings/{userId}/blocks",
    docId: "subcollection",
    caraWrites: true,
    webReads: false,
    notes: "Embedded memory-file blocks under memory_embeddings/{userId}. Reindexed on every memory-file write and purged on delete_memory_file. Server/agent-only.",
  },
  agent_conversations: {
    path: "agent_conversations",
    docId: "phone",
    caraWrites: true,
    webReads: false,
    notes: "Evia conversation history (messages subcollection), physically keyed by a versioned principal-plus-careVertical partition hash. Unstamped phone-keyed pre-cutover rows are senior-only compatibility input. Every new row and summary carries careVertical + conversationPartitionSchema; child rows additionally carry immutable memory-exclusion metadata and never enter Zep, learned facts, generic memory files, training, or eval capture. Append-only by design — message edit/delete is an intentional exclusion (AGENT_NATIVE_EXCLUSIONS.md). Server/agent-only. Memory-grounding U3 (R9): shared-turn rows use deterministic IDs turn_{sourceTurnKeyHash}_{role} and carry sourceTurnKeyHash/sourceChannel/memorySyncStatus; rows with unresolved memorySyncStatus are excluded from nightly compression until the memory-operation worker confirms Zep/fact sync. Memory-grounding U4b (KTD16/R23): rows containing a corrected/forgotten fact are stamped excludeFromMemoryConsolidationAt + excludeFromMemoryConsolidationReason by the correction/forget worker (known sourceMessageRefs, plus a bounded 7-day legacy scan for facts without provenance); marked rows never enter summaries.",
  },
  user_preferences: {
    path: "user_preferences",
    docId: "uid",
    caraWrites: true,
    webReads: false,
    notes: "Notification/DND/timezone preferences (memory/preferences.ts; mcp update_preferences). Server/agent-only; web preference surfaces read the users doc, not this.",
  },
  health_signals: {
    path: "health_signals",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Health concern flags from journal analysis and family reports (mcp log_health_flag / get_health_signals). PHI-bearing; server/agent-only.",
  },
  proactive_triggers: {
    path: "proactive_triggers",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Scheduled proactive check-ins/follow-ups (triggers/triggerEngine.ts). Server/agent-only agent scheduling state.",
  },
  pending_commitments: {
    path: "pending_commitments",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes: "Follow-up promises Evia made to a user ('I'll get back to you'), keyed {phone}_{kind}. Swept by triggerEngine via agents/commitmentTracker.ts — fulfilled or escalated to admin_alerts; never dropped. Server/agent-only.",
  },
  turn_watch: {
    path: "turn_watch",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes: "Dropped-turn watchdog markers keyed by chatId: stamped on every inbound (linq/webhooks.ts), deleted on any outbound send (linq/client.ts); survivors past dueAt become pending_commitments. Server/agent-only.",
  },
  system_status: {
    path: "system_status",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes: "Single 'current' doc: system-wide degraded-mode flag (observability/systemStatus.ts). Set on critical provider failures / budget exhaustion, cleared by the next successful turn. Server/agent-only.",
  },
  ops_counters: {
    path: "ops_counters",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes: "Daily ops counters (e.g. llm_fallback_{date}) for fallback-rate and spend observability. Server/agent-only.",
  },
  cara_ops_zep_outage_buckets: {
    path: "cara_ops_zep_outage_buckets",
    docId: "composite",
    caraWrites: true,
    webReads: false,
    notes: "Aggregate-only per-minute Zep-outage sample buckets (observability/caraOpsAlerts.ts) — deterministic zep-context:{minuteStartMs} doc IDs; sample/failure counts and expiresAt only, never thread IDs, Zep user IDs, query text, or phones (R21). Feeds the sustained-outage alert's rolling window. Server-only.",
  },
  user_triggers: {
    path: "user_triggers",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "User-requested reminders (triggers/userTriggerManager.ts; mcp create/update/delete_reminder). Server/agent-only.",
  },
  shift_swap_requests: {
    path: "shift_swap_requests",
    docId: "auto",
    caraWrites: true,
    webReads: false,
    notes: "Caregiver shift-swap state machine (mcp request/accept/cancel/list_shift_swaps). Server/agent-only; the web reads the resulting appointments doc, not the swap record.",
  },
};

/** Collection names (top-level segment only) that Evia writes. */
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
