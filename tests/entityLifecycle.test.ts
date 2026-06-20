// Entity-lifecycle delete-protection guard (U10).
//
// The launch invariant: audit-sensitive, payment, and health entities must NOT
// be destructively deletable by clients/caregivers. They terminate via a soft
// flag, a terminal status, or an admin-only (audited) hard delete.
//
// This test statically scans firestore.rules. For each protected collection it
// locates the top-level match block and asserts that EVERY `allow delete:` (and
// any combined `allow ...delete...:`) within that block resolves to one of the
// safe conditions: `if false` or `if isAdmin()`. Any broader condition — e.g.
// `if isAuthenticated()`, an ownership check, or a status diff — is a launch
// blocker because it would let a client erase an audit/payment/health record.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const rulesSource = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

// Entities that must never be client-destructively deletable.
const PROTECTED_ENTITIES = [
    'caregivers',
    'appointments',
    'shiftHours',
    'invoices',
    'payments',
    'payouts',
    'care_journal',
    'agent_action_ledger',
    'agent_audit_log',
    'disputes',
    'support_tickets',
] as const;

// Extract the body of the FIRST top-level `match /<collection>/{...} { ... }`
// block, balancing braces so nested subcollection match blocks are included
// (their delete rules are still part of this entity's governance and must be
// equally safe). Returns null if no block is found.
function extractMatchBlock(rules: string, collection: string): string | null {
    const re = new RegExp(`match\\s+/${collection}/\\{[^}]*\\}\\s*\\{`);
    const m = re.exec(rules);
    if (!m) return null;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < rules.length && depth > 0) {
        const ch = rules[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return rules.slice(start, i - 1);
}

// Pull every delete condition out of a match block. Matches:
//   allow delete: if <cond>;
//   allow create, delete: if <cond>;
//   allow read, write: if <cond>;   (write implies delete)
// Returns the raw condition strings (trimmed, semicolon-stripped).
function deleteConditions(block: string): string[] {
    const conds: string[] = [];
    const allowRe = /allow\s+([a-z,\s]+?)\s*:\s*if\s+([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = allowRe.exec(block)) !== null) {
        const verbs = m[1].split(',').map((v) => v.trim());
        if (verbs.includes('delete') || verbs.includes('write')) {
            conds.push(m[2].trim().replace(/\s+/g, ' '));
        }
    }
    return conds;
}

const SAFE = new Set(['false', 'isAdmin()']);

describe('Entity lifecycle — destructive-delete protection (U10)', () => {
    it.each(PROTECTED_ENTITIES)(
        'firestore.rules has a match block for protected entity %s',
        (entity) => {
            expect(
                extractMatchBlock(rulesSource, entity),
                `firestore.rules has no top-level match block for protected entity '${entity}'`
            ).not.toBeNull();
        }
    );

    it.each(PROTECTED_ENTITIES)(
        'protected entity %s is not client-destructively deletable',
        (entity) => {
            const block = extractMatchBlock(rulesSource, entity);
            expect(block, `missing match block for '${entity}'`).not.toBeNull();
            const conds = deleteConditions(block as string);

            // A protected entity must declare at least one delete/write rule —
            // a missing rule would fall through to the default-deny, which is
            // safe, but we require an explicit, auditable statement of intent.
            expect(
                conds.length,
                `protected entity '${entity}' has no explicit allow delete/write rule — ` +
                `add 'allow delete: if false;' (or 'if isAdmin();') to state intent`
            ).toBeGreaterThan(0);

            for (const cond of conds) {
                expect(
                    SAFE.has(cond),
                    `protected entity '${entity}' grants a non-admin destructive delete: ` +
                    `"allow ... : if ${cond};" — clients/caregivers must never destructively ` +
                    `delete audit/payment/health records. Use 'if false' or 'if isAdmin()'.`
                ).toBe(true);
            }
        }
    );
});
