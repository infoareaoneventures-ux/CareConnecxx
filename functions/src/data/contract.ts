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
    notes: "Canonical objective ledger (plan 2026-07-18-001 U3, dark in Wave 1). Server-only: clients denied by the rules catch-all; no chain-of-thought or transcript text is ever stored (R14). Query contract Q28.",
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
    notes: "Per-client job posting mirror (job_postings/{clientUid}); kept in sync with job_posts.",
  },
  job_posts: {
    path: "job_posts",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "The job board. Written via buildAndSaveJobPost (shared by Evia + web flows).",
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
    caraWrites: true,
    webReads: true,
    notes: "Booking-pipeline redesign (2026-08-30): Evia's request_booking/manage_booking now write real booking_requests docs directly (bookingExecutor.ts, shiftOffer.ts, mcp/server.ts), matching the website's own shape (PostsPage.tsx handleSendBooking) instead of the old parallel appointments-only pipeline.",
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
    notes: "Clock-in/out + payroll. Evia writes via clock_in_shift / submit_shift_hours tools.",
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
    notes: "1:1 client↔caregiver messaging (services/chatService.ts). Evia touches via the pushNotifications onCreate trigger. Participant-scoped reads; admin can read all.",
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
  hire_decisions: {
    path: "hire_decisions",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Client's hire/decline decision after an interview (PostsPage.tsx's 'Not Selected'/hire actions; Evia's submit_interview_feedback in mcp/server.ts writes the same record for its interview-outcome flow).",
  },
  booking_amendments: {
    path: "booking_amendments",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Requests to add/change a scheduled day on an accepted booking (the Calendar's '+Request Visit'; caregiver accept/decline in CaregiverBookingsPage.tsx). Evia's request_schedule_amendment/respond_to_schedule_amendment tools (booking-pipeline redesign, 2026-08-30) write the same doc shape.",
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
    notes: "Client→caregiver post-visit reviews (services/api.ts, ReviewSystem.tsx; Evia via mcp/server.ts submit_review). Public read; author-scoped write.",
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
    notes: "GPS clock-in/out shift instances generated from recurring bookings (shiftGenerator.ts) and touched by Evia (mcp/server.ts). Caregiver/client/admin participant-scoped.",
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
    notes: "Bridge between web phone verification and SMS inbound (functions/src/linq/webhooks.ts). Carries role + (optional) name typed on /start; the inbound webhook seeds name into agent_sessions.onboardingData (firstName for client, name for caregiver) and routes to the *_confirm_name step so Evia greets by name. Web reads its own doc (hooks/useOnboardingSession.ts); writes server-side only (createWebOnboardingSession callable).",
  },
  notifications: {
    path: "notifications",
    docId: "auto",
    caraWrites: true,
    webReads: true,
    notes: "Top-level user notifications (bookings, replies, alerts). Web reads own (userId field); Evia/admin write (admin/adminSupportActions.ts, services/api.ts). Distinct from the users/{uid}/notifications subcollection.",
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
    notes: "Evia SMS conversation history (messages subcollection), keyed by E.164 phone. Consolidated into memory files nightly. Append-only by design — message edit/delete is an intentional exclusion (AGENT_NATIVE_EXCLUSIONS.md). Server/agent-only. Memory-grounding U3 (R9): shared-turn rows use deterministic IDs turn_{sourceTurnKeyHash}_{role} and carry sourceTurnKeyHash/sourceChannel/memorySyncStatus; rows with unresolved memorySyncStatus are excluded from nightly compression until the memory-operation worker confirms Zep/fact sync. Memory-grounding U4b (KTD16/R23): rows containing a corrected/forgotten fact are stamped excludeFromMemoryConsolidationAt + excludeFromMemoryConsolidationReason by the correction/forget worker (known sourceMessageRefs, plus a bounded 7-day legacy scan for facts without provenance); marked rows never enter the nightly consolidation prompt or compression summaries (they may still be deleted by compression — their content just never reaches a summary).",
  },
  user_preferences: {
    path: "user_preferences",
    docId: "uid",
    caraWrites: true,
    webReads: false,
    notes: "Notification/DND/timezone preferences (memory/preferences.ts; mcp update_preferences). Server/agent-only; web preference surfaces read the users doc, not this.",
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
    notes: "User-requested reminders (triggers/userTriggerManager.ts). Both creation paths (the MCP create/update/delete_reminder tools, and the conversational schedulingHandler.ts flow) were removed 2026-09-05 — no site equivalent. No new reminders can be created; triggers/triggerEngine.ts still fires any pre-existing docs on schedule until they complete naturally. Server/agent-only.",
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
