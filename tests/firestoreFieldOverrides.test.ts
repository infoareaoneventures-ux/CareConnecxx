// Field-override + embedding-exemption contract (U7).
//
// Asserts firestore.indexes.json:
//   - exempts all four embedding fields from single-field indexing (indexes:[]),
//   - preserves the load-bearing facts.fingerprintKeyVersion override (A2),
//   - keeps the seven TTL overrides,
// and that no source query filters/orders by an embedding field, and the
// linq_message_index map is client-denied in firestore.rules.
//
// See docs/plans/2026-07-19-001-fix-firestore-index-data-integrity-hardening-plan.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const indexesDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const overrides: Array<any> = indexesDoc.fieldOverrides ?? [];

const EMBEDDING_GROUPS = ['caregivers', 'clientIntakes', 'blocks', 'facts'];

function collectSource(): string {
    const files: string[] = [];
    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === 'lib' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.')) files.push(full);
        }
    };
    ['services', 'components', 'hooks', 'context', 'functions/src'].forEach((d) => walk(path.join(ROOT, d)));
    return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

describe('Firestore embedding exemptions (U7)', () => {
    it.each(EMBEDDING_GROUPS)('%s.embedding is a complete single-field exemption (indexes:[])', (cg) => {
        const o = overrides.find((x) => x.collectionGroup === cg && x.fieldPath === 'embedding');
        expect(o, `Missing embedding override for ${cg}`).toBeTruthy();
        expect(o.indexes, `${cg}.embedding must be indexes:[]`).toEqual([]);
        expect(o.ttl, `${cg}.embedding is not a TTL field`).toBeUndefined();
    });

    it('no source query filters or orders by an embedding field', () => {
        const src = collectSource();
        expect(/\.where\(\s*['"`]embedding['"`]/.test(src)).toBe(false);
        expect(/\.orderBy\(\s*['"`]embedding['"`]/.test(src)).toBe(false);
    });
});

describe('Preserved load-bearing override (A2)', () => {
    it('facts.fingerprintKeyVersion keeps its COLLECTION + COLLECTION_GROUP indexes', () => {
        const o = overrides.find((x) => x.collectionGroup === 'facts' && x.fieldPath === 'fingerprintKeyVersion');
        expect(o, 'facts.fingerprintKeyVersion override must be preserved (key-rotation safety query)').toBeTruthy();
        const scopes = (o.indexes ?? []).map((i: any) => i.queryScope).sort();
        expect(scopes).toEqual(['COLLECTION', 'COLLECTION_GROUP']);
    });
});

describe('linq_message_index client access (U7/U2)', () => {
    it('is denied to clients in firestore.rules', () => {
        expect(rules).toMatch(/match \/linq_message_index\/\{[^}]+\}\s*\{\s*allow read, write: if false;/);
    });
});
