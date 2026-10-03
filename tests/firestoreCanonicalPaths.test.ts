// Canonical-path guard (U4).
//
// After retiring the empty legacy collections, this test fails if a runtime
// Firestore access to any of them reappears in source. It matches actual
// query/trigger callsites — `collection('x')`, `collection(db, 'x')`, and
// `document('x/...')` — NOT normal-language prose, so the caregiver-facing
// "Timesheets" tab wording is unaffected.
//
// See docs/plans/2026-07-19-001-fix-firestore-index-data-integrity-hardening-plan.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function collectFiles(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectFiles(full, acc);
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) acc.push(full);
    }
    return acc;
}

const SOURCE = ['services', 'components', 'hooks', 'context', 'functions/src']
    .flatMap((d) => collectFiles(path.join(ROOT, d)))
    .map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

// Retired legacy collections — no runtime access may reference them.
const RETIRED_COLLECTIONS = [
    'timesheets',
    'media_updates',
    'peer_recognitions',
    'caregiver_of_month',
    'billing_events',
    'videoInterviews', // camelCase; canonical is video_interviews
];

// A runtime access is collection('x') / collection(db, 'x') / collection("x")
// or document('x/...') / document("x/{...}"). Prose is not matched.
function runtimeAccessRegex(name: string): RegExp {
    return new RegExp(
        `collection\\(\\s*(?:db\\s*,\\s*)?['"\`]${name}['"\`]\\s*\\)` +
        `|document\\(\\s*['"\`]${name}/`,
    );
}

describe('Canonical Firestore paths — retired legacy collections have no runtime access', () => {
    it.each(RETIRED_COLLECTIONS)('no runtime access to %s', (name) => {
        const re = runtimeAccessRegex(name);
        const offenders = SOURCE.filter((s) => re.test(s.text)).map((s) => s.file);
        expect(
            offenders,
            `Retired collection '${name}' is still accessed at runtime in:\n  ${offenders.join('\n  ')}\n` +
            `Use the canonical collection instead (e.g. shiftHours, video_interviews, invoices/payments).`
        ).toEqual([]);
    });

    it('normal-language "timesheets"/"Timesheets" copy is allowed (not a runtime access)', () => {
        // The caregiver payments page keeps the familiar "Timesheets" tab label.
        // (CaregiverPayments.tsx — the legacy copy — was removed 2026-10-02; the live Payments page keeps the label.)
        const payments = SOURCE.find((s) => s.file.endsWith('CaregiverPaymentsPage.tsx'));
        expect(payments, 'CaregiverPaymentsPage.tsx should exist').toBeTruthy();
        expect(payments!.text).toMatch(/Timesheets/); // prose retained
        expect(runtimeAccessRegex('timesheets').test(payments!.text)).toBe(false); // no collection call
    });

    it('canonical collections remain referenced (shiftHours, video_interviews)', () => {
        const all = SOURCE.map((s) => s.text).join('\n');
        expect(/['"\`]shiftHours['"\`]/.test(all)).toBe(true);
        expect(/['"\`]video_interviews['"\`]/.test(all)).toBe(true);
    });
});
