// Childcare U2 rules-contract guard (plan 2026-07-22-002, R59).
//
// Static companion to tests/firestoreRules.childcare.test.ts (the emulator
// suite, which needs the Firestore emulator + Java to run). This test always
// runs in CI and pins the WRITE POSTURE of the new childcare paths in
// firestore.rules source (style: tests/firestoreCanonicalPaths.test.ts):
//
//   • every U2 collection has a match block, placed BEFORE the deny-all
//     catch-all;
//   • households / household_memberships / guardian_authorities are
//     server-write-only (`allow write: if false`);
//   • childcare_invite_tokens and guardianAuthorityOutbox are FULLY
//     server-only (reads denied too — token secrecy / worker state);
//   • household reads authorize via a household_memberships record lookup
//     (get()/exists()), never via an ID derivable from the caller's UID;
//   • none of the new blocks contains an isAdmin() bypass (R55 — broad admin
//     gets least-privilege operator paths in U12, not blanket authority reads).

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

const U2_PATHS = [
    'households',
    'household_memberships',
    'guardian_authorities',
    'childcare_invite_tokens',
    'guardianAuthorityOutbox',
];

/** Extract the body of `match /<name>/{...} { ... }` (to the next `match /`). */
function blockFor(name: string): string {
    const start = rules.indexOf(`match /${name}/`);
    expect(start, `firestore.rules has no match block for /${name}`).toBeGreaterThan(-1);
    const rest = rules.slice(start);
    const next = rest.indexOf('match /', 1);
    return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The shared-collection delete posture for the verticalized senior collections:
 * admin-ONLY (no `||` arm widening it past admin) and further narrowed so a
 * childcare-vertical doc can never be browser-deleted even by an admin. This is
 * strictly stricter than the pre-childcare `if isAdmin();` and is accepted by
 * the entityLifecycle destructive-delete guard.
 */
function expectAdminOnlyChildcareExcludedDelete(block: string): void {
    const del = block.slice(block.indexOf('allow delete:'));
    const statement = del.slice(0, del.indexOf(';') + 1);
    expect(statement).toMatch(/allow delete: if isAdmin\(\)/);
    expect(statement).not.toMatch(/\|\|/);
    expect(statement).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
}

describe('Childcare U2 firestore.rules contract (static)', () => {
    it.each(U2_PATHS)('/%s has a match block before the deny-all catch-all', (name) => {
        const matchIdx = rules.indexOf(`match /${name}/`);
        const catchAllIdx = rules.indexOf('match /{document=**}');
        expect(matchIdx).toBeGreaterThan(-1);
        expect(catchAllIdx).toBeGreaterThan(-1);
        expect(
            matchIdx,
            `/${name} block must come before the deny-all catch-all`,
        ).toBeLessThan(catchAllIdx);
    });

    it.each(U2_PATHS)('/%s is server-write-only (no browser create/update/delete)', (name) => {
        const block = blockFor(name);
        // Either `allow write: if false;` or `allow read, write: if false;`
        expect(
            /allow (read,\s*)?write:\s*if false;/.test(block),
            `/${name} must deny all client writes (allow write: if false)`,
        ).toBe(true);
        // No other write verbs may be granted anywhere in the block.
        expect(
            /allow [^:\n]*(create|update|delete)[^:\n]*:\s*if (?!false)/.test(block),
            `/${name} grants a client write verb — U2 collections are callable-only`,
        ).toBe(false);
    });

    it.each(['childcare_invite_tokens', 'guardianAuthorityOutbox'])(
        '/%s is FULLY server-only — reads denied too',
        (name) => {
            const block = blockFor(name);
            expect(
                /allow read,\s*write:\s*if false;/.test(block),
                `/${name} must deny reads as well as writes (token secrecy / worker state)`,
            ).toBe(true);
            expect(/allow read:\s*if (?!false)/.test(block)).toBe(false);
        },
    );

    it('household reads authorize via a household_memberships record lookup (never a UID-derived ID)', () => {
        const block = blockFor('households');
        expect(block).toMatch(/isActiveHouseholdMember\(householdId\)/);
        const helper = rules.slice(rules.indexOf('function isActiveHouseholdMember'));
        const helperBody = helper.slice(0, helper.indexOf('}') + 1);
        expect(helperBody).toMatch(/household_memberships/);
        expect(helperBody).toMatch(/exists\(/);
        expect(helperBody).toMatch(/get\(/);
        expect(helperBody).toMatch(/\.data\.status == 'active'/);
        expect(helperBody).toMatch(/\.data\.adultUid == request\.auth\.uid/);
        // The household ID itself must never be compared to the caller's uid —
        // that would be the derivable-ID authorization the plan prohibits.
        expect(block).not.toMatch(/householdId\s*==\s*request\.auth\.uid/);
        expect(block).not.toMatch(/'hh_'\s*\+\s*request\.auth\.uid/);
    });

    it('membership/authority reads are own-row-scoped (resource.data.adultUid == caller)', () => {
        for (const name of ['household_memberships', 'guardian_authorities']) {
            const block = blockFor(name);
            expect(block).toMatch(/resource\.data\.adultUid == request\.auth\.uid/);
        }
    });

    it('no U2 block carries an isAdmin() bypass (R55 — operator access is U12 least-privilege work)', () => {
        for (const name of U2_PATHS) {
            const block = blockFor(name);
            expect(
                /isAdmin\(\)/.test(block),
                `/${name} block must not grant broad-admin access`,
            ).toBe(false);
        }
    });

    it('the deny-all catch-all is still the last match block', () => {
        const catchAllIdx = rules.lastIndexOf('match /{document=**}');
        const lastMatchIdx = rules.lastIndexOf('match /');
        expect(catchAllIdx).toBe(lastMatchIdx);
    });
});

// ── U3: child profiles + privacy lifecycle (plan 2026-07-22-002) ─────────────
//
// Posture pinned here (always-on; the emulator suite exercises live behavior):
//   • /child_profiles reads are authorized ONLY via the authorizedViewerUids
//     derived cache membership (R6 — display read, never authority); writes
//     are server-only.
//   • The private zone (exact DOB, safety versions, file records) is FULLY
//     server-only — no browser read path at all, guardians included.
//   • /data_lifecycle_requests is FULLY server-only (status is a callable).
//   • No isAdmin() bypass anywhere (R55).

const U3_PATHS = ['child_profiles', 'data_lifecycle_requests'];

describe('Childcare U3 firestore.rules contract (static)', () => {
    it.each(U3_PATHS)('/%s has a match block before the deny-all catch-all', (name) => {
        const matchIdx = rules.indexOf(`match /${name}/`);
        const catchAllIdx = rules.indexOf('match /{document=**}');
        expect(matchIdx).toBeGreaterThan(-1);
        expect(catchAllIdx).toBeGreaterThan(-1);
        expect(matchIdx, `/${name} block must come before the deny-all catch-all`).toBeLessThan(catchAllIdx);
    });

    it.each(U3_PATHS)('/%s is server-write-only (no browser create/update/delete)', (name) => {
        const block = blockFor(name);
        expect(
            /allow (read,\s*)?write:\s*if false;/.test(block),
            `/${name} must deny all client writes`,
        ).toBe(true);
        expect(
            /allow [^:\n]*(create|update|delete)[^:\n]*:\s*if (?!false)/.test(block),
            `/${name} grants a client write verb — U3 collections are callable-only`,
        ).toBe(false);
    });

    it('child_profiles reads authorize ONLY via authorizedViewerUids membership (derived cache, R6)', () => {
        const block = blockFor('child_profiles');
        expect(block).toMatch(/'authorizedViewerUids' in resource\.data/);
        expect(block).toMatch(/request\.auth\.uid in resource\.data\.authorizedViewerUids/);
        // Never an ID-shape or ownership-field shortcut.
        expect(block).not.toMatch(/childId\s*==\s*request\.auth\.uid/);
        expect(block).not.toMatch(/resource\.data\.createdByUid == request\.auth\.uid/);
    });

    it('the child private zone is FULLY server-only — recursive deny, no read grant', () => {
        // The nested block lives INSIDE the child_profiles match (after blockFor's
        // slice) — locate it directly.
        const start = rules.indexOf('match /private/{privatePath=**}');
        expect(start, 'child_profiles must contain the nested private/{privatePath=**} deny block').toBeGreaterThan(-1);
        const body = rules.slice(start, rules.indexOf('match /', start + 1));
        expect(body).toMatch(/allow read,\s*write:\s*if false;/);
        expect(/allow read:\s*if (?!false)/.test(body)).toBe(false);
        // And it is nested under child_profiles, before the lifecycle block.
        expect(start).toBeGreaterThan(rules.indexOf('match /child_profiles/'));
        expect(start).toBeLessThan(rules.indexOf('match /data_lifecycle_requests/'));
    });

    it('/data_lifecycle_requests denies reads too (status flows through the callable)', () => {
        const block = blockFor('data_lifecycle_requests');
        expect(block).toMatch(/allow read,\s*write:\s*if false;/);
        expect(/allow read:\s*if (?!false)/.test(block)).toBe(false);
    });

    it('no U3 block carries an isAdmin() bypass (R55)', () => {
        for (const name of U3_PATHS) {
            const block = blockFor(name);
            expect(/isAdmin\(\)/.test(block), `/${name} block must not grant broad-admin access`).toBe(false);
        }
    });
});

// ── U4: consent receipts + identity gate (plan 2026-07-22-002) ───────────────
//
// Posture pinned here:
//   • /consent_receipts, /childcare_identity_sessions, and
//     /childcare_identity_callbacks are FULLY server-only — no browser read or
//     write path at all (receipt privacy, nonce secrecy/enumeration safety;
//     status is served exclusively by callables).
//   • No isAdmin() bypass anywhere (R55).

const U4_PATHS = [
    'consent_receipts',
    'childcare_identity_sessions',
    'childcare_identity_callbacks',
];

describe('Childcare U4 firestore.rules contract (static)', () => {
    it.each(U4_PATHS)('/%s has a match block before the deny-all catch-all', (name) => {
        const matchIdx = rules.indexOf(`match /${name}/`);
        const catchAllIdx = rules.indexOf('match /{document=**}');
        expect(matchIdx).toBeGreaterThan(-1);
        expect(catchAllIdx).toBeGreaterThan(-1);
        expect(matchIdx, `/${name} block must come before the deny-all catch-all`).toBeLessThan(catchAllIdx);
    });

    it.each(U4_PATHS)('/%s is FULLY server-only — reads AND writes denied', (name) => {
        const block = blockFor(name);
        expect(
            /allow read,\s*write:\s*if false;/.test(block),
            `/${name} must deny all client access (allow read, write: if false)`,
        ).toBe(true);
        expect(/allow read:\s*if (?!false)/.test(block)).toBe(false);
        expect(
            /allow [^:\n]*(create|update|delete)[^:\n]*:\s*if (?!false)/.test(block),
            `/${name} grants a client write verb — U4 collections are callable-only`,
        ).toBe(false);
    });

    it('no U4 block carries an isAdmin() bypass (R55)', () => {
        for (const name of U4_PATHS) {
            const block = blockFor(name);
            expect(/isAdmin\(\)/.test(block), `/${name} block must not grant broad-admin access`).toBe(false);
        }
    });

    it('web_onboarding_sessions stays owner-read + server-write (the U4 careVertical stamp adds no browser write)', () => {
        const block = blockFor('web_onboarding_sessions');
        expect(block).toMatch(/resource\.data\.uid == request\.auth\.uid/);
        expect(block).toMatch(/allow write:\s*if false;/);
    });
});

// ── U5: provider vertical profiles + screenings (plan 2026-07-22-002) ────────
//
// Posture pinned here:
//   • caregivers/{uid}/vertical_profiles/{vertical}: owner-read,
//     server-write-only (approval/policy-acceptance/suspension are
//     server-owned state — R27/R28).
//   • caregivers/{uid}/screenings/{vertical}: FULLY server-only (screening
//     EVIDENCE — no browser read path at all; own status flows through
//     v1-getMyChildcareProviderState).
//   • The parent-doc childcareProvider derived summary is blocked from
//     caregiver self-writes on BOTH the create and update paths.
//   • firestore.rules has TWO /caregivers match blocks and rules OR across
//     matching blocks — the second (enumeration) block must contain NO
//     subcollection grants or the first block's posture silently re-opens.

// ── U6: childcare jobs, applications, and the legacy mirror (plan 2026-07-22-002) ──
//
// Posture pinned here:
//   • /job_posts: browser create/update/delete carry the careVertical != 'child'
//     guard on BOTH resource and request sides — childcare jobs are
//     callable-only writes (R11/R32); reads stay authenticated (childcare docs
//     are safe-projection-only by construction, R33).
//   • /job_posts/{jobId}/private/... (child linkage) is FULLY server-only.
//   • /job_applications: browser create/update carry the same guards —
//     childcare applications are callable-only (hard eligibility precedes the
//     write, R34).
//   • /job_postings (the legacy SENIOR singleton mirror) rejects any
//     careVertical:'child' write from the browser (R32).

describe('Childcare U6 firestore.rules contract (static)', () => {
    it('/job_posts browser create is guarded against childcare-vertical docs', () => {
        const block = blockFor('job_posts');
        const create = block.slice(block.indexOf('allow create:'));
        expect(create).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('/job_posts browser update/delete cannot touch or produce childcare-vertical docs', () => {
        const block = blockFor('job_posts');
        const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'));
        expect(update).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expect(update).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        const del = block.slice(block.indexOf('allow delete:'), block.indexOf('allow create:'));
        expect(del).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('/job_posts child linkage subcollection (private/) is FULLY server-only', () => {
        const start = rules.indexOf('match /job_posts/');
        const jobPostsRegion = rules.slice(start, rules.indexOf('match /job_applications/'));
        expect(jobPostsRegion).toMatch(/match \/private\/\{privateDoc\}\s*\{\s*allow read,\s*write:\s*if false;/);
    });

    it('/job_applications browser create/update are guarded against childcare-vertical docs', () => {
        const block = blockFor('job_applications');
        const create = block.slice(block.indexOf('allow create:'), block.indexOf('allow update:'));
        expect(create).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'));
        expect(update).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expect(update).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('/job_postings (legacy SENIOR singleton mirror) rejects childcare-vertical writes (R32)', () => {
        const block = blockFor('job_postings');
        const write = block.slice(block.indexOf('allow create, update:'));
        expect(write).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });
});

describe('Childcare U5 firestore.rules contract (static)', () => {
    /** Slice out one full /caregivers block (brace-balanced from its match line). */
    function caregiverBlocks(): string[] {
        const blocks: string[] = [];
        let idx = 0;
        for (;;) {
            const start = rules.indexOf('match /caregivers/', idx);
            if (start === -1) break;
            // The block-opening brace is the LAST '{' on the match line — the
            // earlier '{caregiverId}' is a path template, not a block open.
            const headerEnd = rules.indexOf('\n', start);
            const open = start + rules.slice(start, headerEnd).lastIndexOf('{');
            let depth = 0;
            let end = start;
            for (let i = open; i < rules.length; i++) {
                if (rules[i] === '{') depth++;
                else if (rules[i] === '}') {
                    depth--;
                    if (depth === 0) { end = i + 1; break; }
                }
            }
            blocks.push(rules.slice(start, end));
            idx = end;
        }
        return blocks;
    }

    it('there are exactly TWO /caregivers match blocks (the known OR hazard)', () => {
        expect(caregiverBlocks().length).toBe(2);
    });

    it('vertical_profiles is owner-read + server-write-only inside the primary caregivers block', () => {
        const [primary] = caregiverBlocks();
        const start = primary.indexOf('match /vertical_profiles/');
        expect(start, 'primary /caregivers block must contain the vertical_profiles match').toBeGreaterThan(-1);
        const body = primary.slice(start, primary.indexOf('match /', start + 1));
        expect(body).toMatch(/allow read:\s*if isOwner\(caregiverId\);/);
        expect(body).toMatch(/allow write:\s*if false;/);
        expect(/allow [^:\n]*(create|update|delete)[^:\n]*:\s*if (?!false)/.test(body)).toBe(false);
        expect(/isAdmin\(\)/.test(body), 'no broad-admin bypass (R55)').toBe(false);
    });

    it('screenings is FULLY server-only (evidence) inside the primary caregivers block', () => {
        const [primary] = caregiverBlocks();
        const start = primary.indexOf('match /screenings/');
        expect(start, 'primary /caregivers block must contain the screenings match').toBeGreaterThan(-1);
        const nextMatch = primary.indexOf('match /', start + 1);
        const body = nextMatch === -1 ? primary.slice(start) : primary.slice(start, nextMatch);
        expect(body).toMatch(/allow read,\s*write:\s*if false;/);
        expect(/allow read:\s*if (?!false)/.test(body)).toBe(false);
        expect(/isAdmin\(\)/.test(body)).toBe(false);
    });

    it('the SECOND /caregivers block grants nothing beyond admin list (no subcollection re-grant via OR)', () => {
        const [, second] = caregiverBlocks();
        expect(second).toBeDefined();
        expect(second).not.toMatch(/match \/vertical_profiles\//);
        expect(second).not.toMatch(/match \/screenings\//);
        expect(second).not.toMatch(/match \/private\//);
        // The only grant in the enumeration block is the admin list.
        const grants = [...second.matchAll(/allow [^;]+;/g)].map((m) => m[0]);
        expect(grants).toEqual(['allow list: if isAdmin();']);
    });

    it('caregiver self-writes cannot touch the derived childcareProvider summary (create AND update)', () => {
        const [primary] = caregiverBlocks();
        // update: in the webhook-only blocked-field list.
        const blocked = primary.match(/hasAny\(\[([\s\S]*?)\]\)/);
        expect(blocked, 'caregivers update rule must carry the blocked-field list').not.toBeNull();
        expect(blocked![1]).toContain("'childcareProvider'");
        // create: explicit keys().hasAny denial.
        expect(primary).toMatch(/allow create:[\s\S]*?!request\.resource\.data\.keys\(\)\.hasAny\(\['childcareProvider'\]\)/);
        // The 'submitted' escape hatch must not include childcareProvider.
        const escape = primary.match(/hasOnly\(\[([^\]]*)\]\)/);
        expect(escape).not.toBeNull();
        expect(escape![1]).not.toContain('childcareProvider');
    });
});

describe('Childcare U7 firestore.rules contract (static)', () => {
    /** Brace-balanced block extraction (the safety block NESTS a versions match). */
    function balancedBlockFor(name: string): string {
        const start = rules.indexOf(`match /${name}/`);
        expect(start, `firestore.rules has no match block for /${name}`).toBeGreaterThan(-1);
        const headerEnd = rules.indexOf('\n', start);
        const open = start + rules.slice(start, headerEnd).lastIndexOf('{');
        let depth = 0;
        for (let i = open; i < rules.length; i++) {
            if (rules[i] === '{') depth++;
            else if (rules[i] === '}') {
                depth--;
                if (depth === 0) return rules.slice(start, i + 1);
            }
        }
        throw new Error(`unbalanced braces for /${name}`);
    }

    it('/childcare_booking_safety is FULLY server-only, before the catch-all, with a recursive versions deny', () => {
        const matchIdx = rules.indexOf('match /childcare_booking_safety/');
        const catchAllIdx = rules.indexOf('match /{document=**}');
        expect(matchIdx).toBeGreaterThan(-1);
        expect(matchIdx).toBeLessThan(catchAllIdx);
        const block = balancedBlockFor('childcare_booking_safety');
        expect(block).toMatch(/allow read,\s*write:\s*if false;/);
        expect(/allow read:\s*if (?!false)/.test(block)).toBe(false);
        expect(block).toMatch(/match \/versions\/\{versionPath=\*\*\}/);
        // The nested versions match must itself be a full deny.
        const versionsIdx = block.indexOf('match /versions/');
        expect(block.slice(versionsIdx)).toMatch(/allow read,\s*write:\s*if false;/);
        expect(/isAdmin\(\)/.test(block), 'no broad-admin bypass (R55)').toBe(false);
    });

    it('/booking_requests browser create/update/delete cannot touch or produce childcare-vertical docs (R11/R36)', () => {
        const block = blockFor('booking_requests');
        const create = block.slice(block.indexOf('allow create:'), block.indexOf('allow update:'));
        expect(create).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'));
        expect(update).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expect(update).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        // delete stays admin-ONLY, further narrowed to exclude childcare docs
        // (entityLifecycle accepts isAdmin() narrowed by &&-joined terms).
        expectAdminOnlyChildcareExcludedDelete(block);
    });

    it('/appointments browser create/update/delete cannot touch or produce childcare-vertical docs (R11/R46)', () => {
        const block = blockFor('appointments');
        const create = block.slice(block.indexOf('allow create:'), block.indexOf('allow update:'));
        expect(create).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'));
        expect(update).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expect(update).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expectAdminOnlyChildcareExcludedDelete(block);
    });

    it('/shifts browser create/update/delete cannot touch or produce childcare-vertical docs (R11/R39)', () => {
        const block = blockFor('shifts');
        const create = block.slice(block.indexOf('allow create:'), block.indexOf('allow read:'));
        expect(create).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'));
        expect(update).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expect(update).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expectAdminOnlyChildcareExcludedDelete(block);
    });

    it('senior booking_requests/appointments/shifts grants are otherwise unchanged (participant-scoped)', () => {
        // Characterization: the pre-U7 participant grants survive verbatim.
        const booking = blockFor('booking_requests');
        expect(booking).toMatch(/resource\.data\.clientId == request\.auth\.uid/);
        expect(booking).toMatch(/resource\.data\.caregiverId == request\.auth\.uid/);
        const appts = blockFor('appointments');
        expect(appts).toMatch(/resource\.data\.clientId == request\.auth\.uid/);
        expect(appts).toMatch(/resource\.data\.caregiverId == request\.auth\.uid/);
        const shifts = blockFor('shifts');
        expect(shifts).toMatch(/request\.resource\.data\.createdBy == 'client'/);
    });
});

describe('Childcare U8 firestore.rules contract (static)', () => {
    it('/reviews browser create cannot produce a childcare-vertical review (R44 — server-only)', () => {
        const block = blockFor('reviews');
        const create = block.slice(block.indexOf('allow create:'));
        expect(create).toMatch(/request\.resource\.data\.clientId == request\.auth\.uid/);
        expect(create).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('/reviews browser update can neither edit a childcare review nor rewrite one INTO the child vertical', () => {
        const block = blockFor('reviews');
        const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'));
        expect(update).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        expect(update).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('only moderated childcare projections are public; senior reads remain public', () => {
        const block = blockFor('reviews');
        expect(block).toMatch(/resource\.data\.moderationState == 'published'/);
        expect(block).toMatch(/resource\.data\.isPublic == true/);
        expect(block).toMatch(/resource\.data\.schemaVersion == 'childcare-review-public-v1'/);
        expect(block).toMatch(/resource\.data\.sourceStateVersion is int/);
        expect(block).toMatch(/allow delete: if isAdmin\(\)[\s\S]*?!= 'child';/);
        expect(block).toMatch(/resource\.data\.clientId == request\.auth\.uid/);
    });

    it('private review submissions and child quality events have no browser path', () => {
        for (const name of ['childcare_review_submissions', 'childcare_quality_events']) {
            const block = blockFor(name);
            expect(block).toMatch(/allow read,\s*write:\s*if false;/);
        }
    });

    it('/childcare_pricing_configs has NO rules block — server-only by the default deny (R40)', () => {
        expect(rules.includes('match /childcare_pricing_configs/')).toBe(false);
        // The default-deny catch-all that enforces this must still exist.
        expect(rules).toMatch(/match \/\{document=\*\*\}[\s\S]*?allow read,\s*write:\s*if false;/);
    });

    it('/shiftHours money posture is unchanged: server-only create; caregiver update path is offline-methods-only (childcare rows are credit ⇒ structurally excluded)', () => {
        const block = blockFor('shiftHours');
        expect(block).toMatch(/allow create: if false;/);
        expect(block).toMatch(/resource\.data\.paymentMethod in \['cash', 'venmo', 'zelle'\]/);
    });

    it('/refundRequests and /disputes stay server-only-writable (the childcare refund/dispute rails are callable/trigger-owned)', () => {
        const refunds = blockFor('refundRequests');
        expect(refunds).toMatch(/allow create, update, delete: if false;/);
        const disputes = blockFor('disputes');
        expect(disputes).toMatch(/allow create, update: if false;/);
    });
});

describe('Childcare U9 firestore.rules contract (static)', () => {
    // Context-chat posture (plan 2026-07-22-002 U9, R41-R42/KTD14): childcare
    // chatRooms are SERVER-owned — the browser can never create/update/delete
    // a childcare-vertical room or write a message into one; message reads
    // for childcare rooms have NO isAdmin() bypass (R55). The senior pairwise
    // grants keep their exact pre-U9 shapes.

    function chatRoomsBlock(): string {
        const start = rules.indexOf('match /chatRooms/');
        expect(start).toBeGreaterThan(-1);
        // The chatRooms block ends where the next TOP-LEVEL match begins
        // (skip the nested /messages match inside it).
        const afterMessages = rules.indexOf('match /messages/', start);
        const next = rules.indexOf('match /', afterMessages + 10);
        return rules.slice(start, next);
    }

    it('browser CREATE of a childcare-vertical room is denied (server keys rooms by context)', () => {
        const block = chatRoomsBlock();
        const create = block.slice(block.indexOf('allow create:'), block.indexOf('allow delete:'));
        expect(create).toMatch(/request\.resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('browser UPDATE/DELETE of a childcare room is denied (participants/phase/state are policy)', () => {
        const block = chatRoomsBlock();
        const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow create:'));
        expect(update).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        const del = block.slice(block.indexOf('allow delete:'), block.indexOf('match /messages/'));
        expect(del).toMatch(/resource\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('childcare MESSAGE writes are server-only; message reads have NO childcare admin bypass (R55)', () => {
        const block = chatRoomsBlock();
        const messages = block.slice(block.indexOf('match /messages/'));
        const write = messages.slice(messages.indexOf('allow write:'));
        expect(write).toMatch(/\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
        const read = messages.slice(messages.indexOf('allow read:'), messages.indexOf('allow write:'));
        // The admin branch of message reads is guarded off childcare rooms.
        expect(read).toMatch(/isAdmin\(\)\s*&&[\s\S]*?\.data\.get\('careVertical',\s*'senior'\)\s*!=\s*'child'/);
    });

    it('senior pairwise grants keep their exact pre-U9 participant shapes', () => {
        const block = chatRoomsBlock();
        // Read grant: the get-or-create null read and the participant arm
        // survive verbatim. The admin arm is the ONE deliberate U9 change — it
        // is now guarded off childcare rooms (pinned separately above) — so the
        // three arms are asserted individually instead of as one literal line.
        const read = block.slice(block.indexOf('allow read:'), block.indexOf('allow update:'));
        expect(read).toMatch(/resource == null/);
        expect(read).toMatch(/request\.auth\.uid in resource\.data\.participants/);
        expect(read).toMatch(/isAdmin\(\)/);
        // Participant-membership condition still present on create/update.
        expect(block).toContain('request.auth.uid in request.resource.data.participants || isAdmin()');
    });
});

// ── U12: restricted incident cases + operator scope grants (plan 2026-07-22-002) ──
//
// Posture pinned here (R55/R56/AE18):
//   • /childcare_incidents is FULLY server-only — browser reads denied to
//     EVERYONE including admins (detail flows through the childSafetyOperator
//     + reason callable, never a doc read), with a recursive deny on the
//     restricted subcollection.
//   • /childcare_operators (scope grants) is FULLY server-only — no client
//     can read the operator roster or write a scope (self-grant impossible).
//   • No isAdmin() bypass anywhere in either block (R55 — broad admin alone
//     never reads child-sensitive incident data).

describe('Childcare U12 firestore.rules contract (static)', () => {
    /** Brace-balanced extraction (the incidents block nests a restricted match). */
    function balancedBlockFor(name: string): string {
        const start = rules.indexOf(`match /${name}/`);
        expect(start, `firestore.rules has no match block for /${name}`).toBeGreaterThan(-1);
        const headerEnd = rules.indexOf('\n', start);
        const open = start + rules.slice(start, headerEnd).lastIndexOf('{');
        let depth = 0;
        for (let i = open; i < rules.length; i++) {
            if (rules[i] === '{') depth++;
            else if (rules[i] === '}') {
                depth--;
                if (depth === 0) return rules.slice(start, i + 1);
            }
        }
        throw new Error(`unbalanced braces for /${name}`);
    }

    it.each(['childcare_incidents', 'childcare_operators'])(
        '/%s has a match block before the deny-all catch-all',
        (name) => {
            const matchIdx = rules.indexOf(`match /${name}/`);
            const catchAllIdx = rules.indexOf('match /{document=**}');
            expect(matchIdx).toBeGreaterThan(-1);
            expect(catchAllIdx).toBeGreaterThan(-1);
            expect(matchIdx, `/${name} block must come before the deny-all catch-all`).toBeLessThan(catchAllIdx);
        },
    );

    it.each(['childcare_incidents', 'childcare_operators'])(
        '/%s is FULLY server-only — reads AND writes denied (even to admins)',
        (name) => {
            const block = balancedBlockFor(name);
            expect(
                /allow read,\s*write:\s*if false;/.test(block),
                `/${name} must deny all client access`,
            ).toBe(true);
            expect(/allow read:\s*if (?!false)/.test(block)).toBe(false);
            expect(
                /allow [^:\n]*(create|update|delete)[^:\n]*:\s*if (?!false)/.test(block),
                `/${name} grants a client write verb — U12 collections are callable-only`,
            ).toBe(false);
        },
    );

    it('the incidents restricted subcollection is a recursive deny', () => {
        const block = balancedBlockFor('childcare_incidents');
        expect(block).toMatch(/match \/restricted\/\{restrictedPath=\*\*\}/);
        const restrictedIdx = block.indexOf('match /restricted/');
        expect(block.slice(restrictedIdx)).toMatch(/allow read,\s*write:\s*if false;/);
    });

    it('no U12 block carries an isAdmin() bypass (R55 — broad admin never reads incident data)', () => {
        for (const name of ['childcare_incidents', 'childcare_operators']) {
            const block = balancedBlockFor(name);
            expect(/isAdmin\(\)/.test(block), `/${name} block must not grant broad-admin access`).toBe(false);
        }
    });
});
