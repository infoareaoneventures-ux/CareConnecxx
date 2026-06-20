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
    notes: "1:1 client↔caregiver messaging (services/chatService.ts). Cara touches via the pushNotifications onCreate trigger. Participant-scoped reads; admin can read all.",
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
    notes: "Caregiver interview scheduling + fit feedback. Web (api.ts, caregiver dashboards) and Cara (interviewAgent.ts) both write.",
  },
  interviews: {
    path: "interviews",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Scheduled interview record with meeting link/ICS (functions/src/agents/interviewAgent.ts). Client reads pending interviews (InterviewConfirmation.tsx); writes server-side only.",
  },
  job_applications: {
    path: "job_applications",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Caregiver applications to job posts. Caregiver creates; client accepts/rejects; caregiver can withdraw (status='withdrawn', U2). applicantCount maintained by jobApplicationTriggers.",
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
    notes: "Caregiver payout ledger. Per-caregiver subcollection (caregivers/{uid}/payouts, PayoutHistory.tsx) AND a top-level admin mirror read by FinanceDashboard. Written via instantPayout/standardPayout (Admin SDK). Payment entity: client-destructive delete blocked.",
  },
  reports: {
    path: "reports",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "User abuse/safety reports. Web users create their own (InboxView.tsx); Cara/mcp may file reports; admins review. Author-scoped create, admin read.",
  },
  reviews: {
    path: "reviews",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Client→caregiver post-visit reviews (services/api.ts, ReviewSystem.tsx; Cara via mcp/server.ts submit_review). Public read; author-scoped write.",
  },
  seniors: {
    path: "seniors",
    docId: "auto",
    caraWrites: false,
    webReads: false,
    notes: "Cara/QA-agent senior context records keyed by seniorId (functions qaAgent.ts, mcp/server.ts reads). NOT the web senior store — that is senior_profiles. Server-only; no web reader. Distinct from the UI plural label 'seniors'.",
  },
  shifts: {
    path: "shifts",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "GPS clock-in/out shift instances generated from recurring bookings (shiftGenerator.ts) and touched by Cara (mcp/server.ts). Caregiver/client/admin participant-scoped.",
  },
  video_interviews: {
    path: "video_interviews",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Twilio video interview scheduling (services/videoService.ts; Cara via mcp/server.ts). Client/caregiver participant-scoped.",
  },
  web_onboarding_sessions: {
    path: "web_onboarding_sessions",
    docId: "phone",
    caraWrites: true,
    webReads: true,
    notes: "Bridge between web phone verification and SMS inbound (functions/src/linq/webhooks.ts). Web reads its own doc (hooks/useOnboardingSession.ts); writes server-side only (createWebOnboardingSession callable).",
  },
  notifications: {
    path: "notifications",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Top-level user notifications (bookings, replies, alerts). Web reads own (userId field); Cara/admin write (admin/adminSupportActions.ts, services/api.ts). Distinct from the users/{uid}/notifications subcollection.",
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
