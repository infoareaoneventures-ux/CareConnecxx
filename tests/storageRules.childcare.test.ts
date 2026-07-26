// @vitest-environment node
//
// Childcare U3 Storage Rules suite (plan 2026-07-22-002, R12/R59/AE7).
//
// Two halves:
//   1. ALWAYS-ON static posture — pins in storage.rules source that the
//      dedicated childcare root denies ALL client access (reads and writes),
//      sits before the default-deny catch-all, and is not token-bypassable:
//      no `allow read` grant exists on the root, and the server module that
//      serves these files never mints permanent getDownloadURL() tokens
//      (token URLs bypass Storage Rules entirely — the legacy lineage R12
//      prohibits). Delivery is an authenticated server stream with live
//      authority and generation checks; only upload intents use signed URLs.
//   2. EMULATOR cases — SELF-SKIP when FIREBASE_STORAGE_EMULATOR_HOST is not
//      set (plain `npm test` runs, machines without Java), mirroring the U2
//      convention in tests/firestoreRules.childcare.test.ts. Run via the
//      storage emulator:
//        firebase emulators:exec --only storage \
//          "npx vitest run tests/storageRules.childcare.test.ts"

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const rules = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8');

const EMULATOR = Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST);

/** Strip comment lines so prose about the prohibited pattern doesn't match. */
function stripComments(source: string): string {
    return source
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
        })
        .join('\n');
}

// ── static posture (always-on) ───────────────────────────────────────────────

describe('Childcare U3 storage.rules contract (static)', () => {
    it('has a childcare root match block', () => {
        expect(rules).toMatch(/match \/childcare\/\{[^}]+=\*\*\}/);
    });

    it('the childcare block denies ALL client access (reads and writes)', () => {
        const start = rules.indexOf('match /childcare/');
        expect(start).toBeGreaterThan(-1);
        const next = rules.indexOf('match /', start + 1);
        const block = next === -1 ? rules.slice(start) : rules.slice(start, next);
        expect(block).toMatch(/allow read,\s*write:\s*if false;/);
        // Not token-bypassable at the Rules layer: no read grant of ANY shape.
        expect(/allow read[^,:\n]*:\s*if (?!false)/.test(block)).toBe(false);
        expect(/allow write[^,:\n]*:\s*if (?!false)/.test(block)).toBe(false);
        // No admin/owner carve-outs either — server-only via signed URLs.
        expect(block).not.toMatch(/isAdmin\(\)/);
        expect(block).not.toMatch(/isOwner\(/);
        expect(block).not.toMatch(/isAuthenticated\(\)/);
    });

    it('the childcare block precedes the default-deny catch-all', () => {
        const childcareIdx = rules.indexOf('match /childcare/');
        const catchAllIdx = rules.indexOf('match /{allPaths=**}');
        expect(childcareIdx).toBeGreaterThan(-1);
        expect(catchAllIdx).toBeGreaterThan(-1);
        expect(childcareIdx).toBeLessThan(catchAllIdx);
    });

    it('the server module never mints read URLs or permanent download tokens (R12)', () => {
        const source = stripComments(
            fs.readFileSync(
                path.join(ROOT, 'functions', 'src', 'childcare', 'childFileAccess.ts'),
                'utf8',
            ),
        );
        expect(source).toMatch(/getSignedUrl/);
        expect(source).not.toMatch(/action:\s*['"]read['"]/);
        expect(source).not.toMatch(/getDownloadURL\s*\(/);
        expect(source).not.toMatch(/makePublic/);
        expect(source).toMatch(/authorizeChildFileDelivery/);
        expect(source).toMatch(/createReadStream/);
    });

    it('no frontend uploader writes to the childcare root (server-authorized intents only)', () => {
        // The existing browser upload service must not gain a childcare path —
        // uploads flow exclusively through v1-createChildFileUploadIntent.
        const uploaderPath = path.join(ROOT, 'services', 'documentUpload.ts');
        if (fs.existsSync(uploaderPath)) {
            const uploader = stripComments(fs.readFileSync(uploaderPath, 'utf8'));
            expect(uploader).not.toMatch(/['"`]childcare\//);
        }
    });
});

// ── emulator cases (self-skipping) ───────────────────────────────────────────

type TestEnv = import('@firebase/rules-unit-testing').RulesTestEnvironment;

if (EMULATOR) {
describe('Childcare U3 Storage Rules (emulator)', () => {
    let testEnv: TestEnv;
    let assertFails: (p: Promise<unknown>) => Promise<unknown>;

    const FILE_PATH = 'childcare/hh_parent-1/child-1/photo/cf1';

    beforeAll(async () => {
        const rut = await import('@firebase/rules-unit-testing');
        assertFails = rut.assertFails;
        // Explicit host/port: emulator discovery via the hub can hang on slow
        // machines; the env var is authoritative when set (self-skip gate above).
        const [host, port] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '')
            .replace(/^https?:\/\//, '')
            .split(':');
        testEnv = await rut.initializeTestEnvironment({
            projectId: 'childcare-storage-rules-test',
            storage: { rules, host: host || '127.0.0.1', port: Number(port) || 9199 },
        });
        // Server-side seed (rules disabled — the Admin-SDK posture).
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const storage = ctx.storage();
            await storage.ref(FILE_PATH).putString('restricted-child-file');
        });
    }, 60_000);

    afterAll(async () => {
        await testEnv?.cleanup();
    });

    const storageAs = (uid: string | null) =>
        uid === null
            ? testEnv.unauthenticatedContext().storage()
            : testEnv.authenticatedContext(uid).storage();

    it('unauthenticated SDK reads are denied (AE7)', async () => {
        await assertFails(storageAs(null).ref(FILE_PATH).getDownloadURL());
    });

    it('AUTHENTICATED reads are denied too — even the guardian (server-only root)', async () => {
        await assertFails(storageAs('parent-1').ref(FILE_PATH).getDownloadURL());
        await assertFails(storageAs('aunt-1').ref(FILE_PATH).getDownloadURL());
        await assertFails(storageAs('stranger-1').ref(FILE_PATH).getDownloadURL());
    });

    it('broad admins are denied (R55 — operator access is not a Storage bypass)', async () => {
        await assertFails(storageAs('admin-1').ref(FILE_PATH).getDownloadURL());
    });

    it('client writes are denied everywhere under the root', async () => {
        await assertFails(storageAs('parent-1').ref(FILE_PATH).putString('overwrite'));
        await assertFails(
            storageAs('parent-1')
                .ref('childcare/hh_parent-1/child-1/photo/new-file')
                .putString('new'),
        );
        await assertFails(storageAs('admin-1').ref(FILE_PATH).delete());
    });
});

}

if (!EMULATOR) {
describe('Childcare U3 Storage Rules (emulator not available)', () => {
    it('skipped — run with the Storage emulator (requires Java); static posture above is always-on', () => {
        expect(EMULATOR).toBe(false);
    });
});
}
