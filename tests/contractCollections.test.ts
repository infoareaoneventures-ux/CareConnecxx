// Evia ↔ Web collection-contract guard.
//
// functions/src/data/contract.ts is the canonical registry of Firestore
// collections shared between Evia (Cloud Functions) and the web app. This test
// statically scans both codebases and fails when the registry drifts from
// reality:
//   1. every contract collection marked caraWrites must be referenced in
//      functions/src
//   2. every contract collection marked webReads must be referenced in the
//      frontend (services/, components/, hooks/)
//   3. firestore.rules must mention every web-read collection (a missing rules
//      block silently breaks the web reader with permission-denied)

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CONTRACT_COLLECTIONS } from '../functions/src/data/contract';

const ROOT = path.resolve(__dirname, '..');

function collectFiles(dir: string, exts: string[], acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectFiles(full, exts, acc);
        else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.includes('.test.')) acc.push(full);
    }
    return acc;
}

function concatSources(dirs: string[]): string {
    return dirs
        .flatMap((d) => collectFiles(path.join(ROOT, d), ['.ts', '.tsx']))
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');
}

// Match collection('name') / collection("name") plus bare string references
// (rules paths, document() trigger templates).
function referencesCollection(source: string, name: string): boolean {
    return new RegExp(`['"\`/]${name}['"\`/]`).test(source);
}

const backendSource  = concatSources(['functions/src']);
const frontendSource = concatSources(['services', 'components', 'hooks', 'context']);
const rulesSource    = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

// ── Runtime-only collections allowlist ──────────────────────────────────────
//
// These collections are written by Evia (functions/src) but are INTENTIONALLY
// not part of the Evia↔web data contract: the web app never reads them. They are
// agent runtime state, server-only ledgers/queues, idempotency/lock/dedup docs,
// rate-limit counters, subcollections, and internal observability streams.
//
// The scanner test below FAILS if Evia writes a top-level collection that is
// neither registered in CONTRACT_COLLECTIONS nor listed here — that is the
// signal to consciously decide: is this a new shared collection (add a contract
// entry + rules block) or genuinely runtime-only (add it here)?
const RUNTIME_ONLY_COLLECTIONS = new Set<string>([
    // Merged from cara-100: server/runtime-only audit, shadow, alert, and
    // activity-feed streams Evia writes (not part of the web read contract).
    'consent_audit_log', 'emergency_alerts', 'routing_shadow', 'user_activity_feed',
    // Agent session / runtime state
    // (agent_conversations moved to CONTRACT_COLLECTIONS — agent-native audit 2026-07)
    'agent_sessions', 'agent_turn_checkpoints',
    'agent_prefetch', 'agent_dnd_queue', 'agent_permissions', 'agent_reactions',
    'agent_read_receipts', 'agent_group_events', 'agent_imessage_retry',
    // Observability / log streams (admin dashboards read some via direct
    // collection() in AuditDashboard, but they are not part of the contract
    // registry; they have their own rules and are server-write-only)
    'agent_error_log', 'agent_event_log', 'agent_safety_log', 'agent_alerts_log',
    'agent_uncertainty_log', 'agent_tool_metrics',
    'caregiver_lateness_log', 'issue_log',
    // Idempotency / lock / dedup / rate-limit docs
    'agent_inbound_locks', 'agent_outbound_dedup', 'agent_rate', 'rate_limits',
    'linq_pair_rate', 'linq_phone_health', 'smsThrottles',
    'processed_stripe_events', 'processed_checkr_events',
    'payoutLocks',       // instant-payout replay-window locks (payoutCommon) — server-only
    // Stripe Connect accountId → caregiverId reverse map (payout-private wave
    // 2026-07-11) — server-only webhook lookup, never read by the web.
    'stripe_accounts',
    // Internal queues / async work
    'admin_email_queue', 'adminNotifications', 'job_notifications',
    'health_alerts_pending', 'execution_agents', 'browser_sessions',
    'credential_vault',
    // Out-of-area onboarding leads (Santa Clara County service-area gate) —
    // server-written, not part of the web read contract.
    'waitlist',
    // Checkr MCP bridge OTP/session state (caregiver-only report tools,
    // 2026-07-09) — server-only, never read by the web.
    'checkr_mcp_sessions',
    // In-shift caregiver→family update cadence/ledger state (2026-07-10) —
    // server-only; families receive the updates over SMS, the web reads
    // visits/shiftHours mirrors, not this.
    'in_shift_updates',
    // Matching / scheduling internals (web reads the user-facing mirrors, not these)
    // (memory_embeddings/facts/learned_facts, proactive_triggers/user_triggers,
    // health_signals, and user_preferences moved to CONTRACT_COLLECTIONS as
    // server/agent-only entries — agent-native audit 2026-07)
    'caregiver_booked_slots', 'replacement_candidates', 'recurring_schedules',
    'booking_patterns', 'day_patterns', 'match_history', 'match_outcomes',
    'clientMatches', 'match_assignments',
    // Triggers / engagement internals
    'trigger_engagement',
    // Health / wellbeing analytics streams
    'health_trends', 'health_summaries', 'wellbeing_checkins',
    'post_visit_feedback',
    // Billing / payment internals written server-side (web reads invoices/payments,
    // not these intermediate/event records)
    'billing_events', 'visit_billing', 'visit_payments', 'dispute_flags',
    // Misc internal config / metrics
    'system_config', 'experiment_scorecards', 'weekly_digests',
    'wow_fires', '_meta',
    // Server-only request/workflow records the web does not read directly
    // ('blocks' + 'shift_swap_requests' moved to CONTRACT_COLLECTIONS — agent-native audit 2026-07)
    'comments', 'client_cancel_requests', 'email_change_requests',
    'emergency_events', 'instant_payouts', 'refundRequests',
    // Subcollection leaf names that appear as bare collection("name") segments.
    // Their parent docs are governed by the contract entry for the parent path.
    'messages',          // threads/{id}/messages — covered by 'threads' entry
    'care_keepsakes', 'care_plans', 'appointment_care_plans', 'carePlanVersions',
    'versions',      // care_plans/{id}/versions — caregiver history, server-only
    'shift_checkins', 'shift_hours', 'tax_summaries',
    'responses',         // support_tickets/{id}/responses — covered by 'support_tickets' entry
    'subscriptions',     // customers/{uid}/subscriptions — covered by 'customers' entry
    // caregivers/{id}/private/{background|payout} — identity PII + Stripe payout
    // fields (2026-07-11 waves). Covered by the 'caregivers' contract entry and
    // the private/{docId} rules block (owner||admin read, client write:false).
    'private',
]);

// ── Tracked unregistered web-read collections (U10 backlog) ─────────────────
//
// CLOSED in U10. The pre-registry collections that the web reads are now all
// registered in CONTRACT_COLLECTIONS with accurate access classes and matching
// firestore.rules blocks:
//   chatRooms, customers, disputes, hire_requests, interview_requests,
//   interviews, invoices, job_applications, notifications, payments, payouts,
//   reports, reviews, seniors, shifts, video_interviews, web_onboarding_sessions
// Two former entries were subcollection leaves, not top-level shared
// collections, and moved to RUNTIME_ONLY_COLLECTIONS instead:
//   responses      → support_tickets/{id}/responses
//   subscriptions  → customers/{uid}/subscriptions
// 'seniors' is the Evia/QA-agent context store (keyed by seniorId), distinct
// from the web senior store senior_profiles; it is server-only (webReads:false).
//
// This set is now intentionally empty. The scanner still FAILS if a *new*
// unregistered collection appears that is in neither this set,
// RUNTIME_ONLY_COLLECTIONS, nor CONTRACT_COLLECTIONS.
const UNREGISTERED_WEB_READ_COLLECTIONS = new Set<string>([]);

describe('Evia ↔ Web collection contract', () => {
    const entries = Object.entries(CONTRACT_COLLECTIONS);

    it('has the core launch collections registered', () => {
        const names = entries.map(([k]) => k);
        for (const required of [
            'users', 'caregivers', 'clientIntakes', 'senior_profiles', 'carePlans',
            'job_postings', 'job_posts', 'appointments', 'shiftHours', 'threads',
            'support_tickets', 'admin_alerts', 'care_journal', 'proactive_drafts',
            'agent_audit_log', 'agent_action_ledger', 'pending_actions',
        ]) {
            expect(names, `contract.ts is missing '${required}'`).toContain(required);
        }
    });

    it('every Evia-written collection is registered in the contract or an explicit allowlist (U5)', () => {
        // Scan functions/src for collection("name") / collection('name') /
        // collection(db, "name") and extract the distinct top-level names Evia
        // writes. (Subcollection leaves appear as bare segments too — they are
        // covered by their parent path's contract entry or the allowlist.)
        const re = /\.collection\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*\)|collection\(\s*db\s*,\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*\)/g;
        const found = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = re.exec(backendSource)) !== null) {
            found.add(m[1] ?? m[2]);
        }

        // A scanned name is "known" if it is a contract key, a top-level segment
        // of a contract path, or in one of the explicit allowlists.
        const contractKeys = new Set(Object.keys(CONTRACT_COLLECTIONS));
        const contractTops = new Set(
            Object.values(CONTRACT_COLLECTIONS).map((c) => c.path.split('/')[0])
        );
        const known = (name: string) =>
            contractKeys.has(name) ||
            contractTops.has(name) ||
            RUNTIME_ONLY_COLLECTIONS.has(name) ||
            UNREGISTERED_WEB_READ_COLLECTIONS.has(name);

        const unregistered = [...found].filter((n) => !known(n)).sort();

        expect(
            unregistered,
            `Evia writes these collections but they are neither registered in ` +
            `CONTRACT_COLLECTIONS nor allowlisted in tests/contractCollections.test.ts.\n` +
            `Decide per collection: add a contract entry + firestore.rules block if the ` +
            `web reads it, or add it to RUNTIME_ONLY_COLLECTIONS if it is server/runtime-only:\n` +
            `  ${unregistered.join(', ')}`
        ).toEqual([]);
    });

    it('the agent_* shared collections this unit owns are registered (U5)', () => {
        const names = entries.map(([k]) => k);
        for (const required of ['agent_tasks', 'agent_tasks_active', 'agent_approvals']) {
            expect(names, `contract.ts is missing '${required}'`).toContain(required);
        }
    });

    it.each(entries.filter(([, c]) => c.caraWrites))(
        'Evia backend references %s (caraWrites)',
        (_key, c) => {
            const top = c.path.split('/')[0];
            expect(
                referencesCollection(backendSource, top),
                `contract says Evia writes '${top}' but functions/src never references it`
            ).toBe(true);
        }
    );

    it.each(entries.filter(([, c]) => c.webReads))(
        'frontend references %s (webReads)',
        (_key, c) => {
            const top = c.path.split('/')[0];
            expect(
                referencesCollection(frontendSource, top),
                `contract says the web reads '${top}' but services/components/hooks never reference it`
            ).toBe(true);
        }
    );

    it.each(entries.filter(([, c]) => c.webReads))(
        'firestore.rules covers %s (web reader needs a rules block)',
        (_key, c) => {
            const top = c.path.split('/')[0];
            expect(
                rulesSource.includes(`/${top}`),
                `firestore.rules has no match block mentioning '${top}' — the web reader will get permission-denied`
            ).toBe(true);
        }
    );

    it('uid-keyed parity docs are written uid-keyed by Evia (no .add() drift)', () => {
        // clientIntakes/{uid}: the onboarding write must use .doc(uid).set, with
        // .add() allowed only as the no-uid fallback. Cheap heuristic: the
        // uid-keyed write must exist.
        expect(backendSource).toMatch(/collection\(["']clientIntakes["']\)\s*\.doc\(/);
        // caregivers/{uid}: finalization keys by auth uid
        expect(backendSource).toMatch(/collection\(["']caregivers["']\)\s*\.doc\(authUid\)/);
        // senior_profiles/{uid}: Evia parity write exists
        expect(backendSource).toMatch(/collection\(["']senior_profiles["']\)\s*\.doc\(uid\)/);
    });

    it('Evia conversations are mirrored into the web threads model', () => {
        expect(backendSource).toContain('mirrorToWebThread');
        expect(backendSource).toMatch(/threads/);
        expect(backendSource).toContain('groupChatId');
    });

    it('Checkr lookup stays on backgroundCheckData.checkrCandidateId', () => {
        expect(backendSource).toContain('backgroundCheckData.checkrCandidateId');
    });
});

describe('Evia launch action-parity map (context/capability-map.md)', () => {
    const mapPath = path.join(ROOT, 'context', 'capability-map.md');

    it('the human-readable capability map exists', () => {
        expect(
            fs.existsSync(mapPath),
            'context/capability-map.md is the human-readable mirror of launchActionParity.ts and must exist'
        ).toBe(true);
    });

    it('groups parity rows by every actor (Client / Caregiver / Admin)', () => {
        const md = fs.readFileSync(mapPath, 'utf8');
        for (const heading of ['Client', 'Caregiver', 'Admin']) {
            expect(
                md.includes(heading),
                `capability-map.md must list at least the '${heading}' actor section`
            ).toBe(true);
        }
    });
});
