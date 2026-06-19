// Cara ↔ Web collection-contract guard.
//
// functions/src/data/contract.ts is the canonical registry of Firestore
// collections shared between Cara (Cloud Functions) and the web app. This test
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

describe('Cara ↔ Web collection contract', () => {
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

    it.each(entries.filter(([, c]) => c.caraWrites))(
        'Cara backend references %s (caraWrites)',
        (_key, c) => {
            const top = c.path.split('/')[0];
            expect(
                referencesCollection(backendSource, top),
                `contract says Cara writes '${top}' but functions/src never references it`
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

    it('uid-keyed parity docs are written uid-keyed by Cara (no .add() drift)', () => {
        // clientIntakes/{uid}: the onboarding write must use .doc(uid).set, with
        // .add() allowed only as the no-uid fallback. Cheap heuristic: the
        // uid-keyed write must exist.
        expect(backendSource).toMatch(/collection\(["']clientIntakes["']\)\s*\.doc\(/);
        // caregivers/{uid}: finalization keys by auth uid
        expect(backendSource).toMatch(/collection\(["']caregivers["']\)\s*\.doc\(authUid\)/);
        // senior_profiles/{uid}: Cara parity write exists
        expect(backendSource).toMatch(/collection\(["']senior_profiles["']\)\s*\.doc\(uid\)/);
    });

    it('Cara conversations are mirrored into the web threads model', () => {
        expect(backendSource).toContain('mirrorToWebThread');
        expect(backendSource).toMatch(/threads/);
        expect(backendSource).toContain('groupChatId');
    });

    it('Checkr lookup stays on backgroundCheckData.checkrCandidateId', () => {
        expect(backendSource).toContain('backgroundCheckData.checkrCandidateId');
    });
});
