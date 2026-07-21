// Firestore index coverage guard.
//
// firestore.query-contracts.json is the machine-readable contract of every
// active compound Firestore query that requires a composite index (Q1-Q26),
// plus explicit no-index dispositions for wrong-schema/dead signatures. This
// test fails CI when:
//   1. a contract with disposition "composite" has no matching index in
//      firestore.indexes.json (prints the collection + expected field order),
//   2. firestore.indexes.json contains an exact-duplicate composite,
//   3. a Q25/Q26 "existing" contract is missing (regression guard on the two
//      already-checked-in scheduled-worker indexes),
//   4. a forbidden signature's known collection+fields reappears as an active
//      index BEFORE its retirement unit has run (see allowlist below).
//
// See docs/plans/2026-07-19-001-fix-firestore-index-data-integrity-hardening-plan.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

interface FieldSpec { fieldPath: string; order?: string; arrayConfig?: string; }
interface IndexDef {
    collectionGroup: string;
    queryScope: string;
    fields: FieldSpec[];
}
interface Contract {
    id: string;
    collectionGroup: string;
    queryScope: string;
    fields: FieldSpec[];
    disposition: string;
    status: string;
}

const contractsDoc = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'firestore.query-contracts.json'), 'utf8')
);
const indexesDoc = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8')
);

const contracts: Contract[] = contractsDoc.contracts;
const indexes: IndexDef[] = indexesDoc.indexes;

// Canonical signature: collectionGroup | scope | fieldPath:order,fieldPath:order
// Order and direction are significant for composite indexes.
function signature(def: { collectionGroup: string; queryScope?: string; fields: FieldSpec[] }): string {
    const scope = def.queryScope ?? 'COLLECTION';
    const fields = def.fields
        .map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig ?? 'ASCENDING'}`)
        .join(',');
    return `${def.collectionGroup}|${scope}|${fields}`;
}

describe('Firestore query-contract index coverage', () => {
    const indexSignatures = indexes.map(signature);
    const indexSignatureSet = new Set(indexSignatures);

    it.each(contracts.filter((c) => c.disposition === 'composite'))(
        '$id has a checked-in composite index',
        (c) => {
            const want = signature(c);
            expect(
                indexSignatureSet.has(want),
                `Contract ${c.id} requires a composite index that firestore.indexes.json does not contain.\n` +
                `  Expected collectionGroup=${c.collectionGroup} scope=${c.queryScope}\n` +
                `  fields (in order): ${c.fields.map((f) => `${f.fieldPath} ${f.order ?? 'ASCENDING'}`).join(', ')}`
            ).toBe(true);
        }
    );

    it('firestore.indexes.json contains no exact-duplicate composite', () => {
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const sig of indexSignatures) {
            if (seen.has(sig)) dupes.push(sig);
            seen.add(sig);
        }
        expect(dupes, `Duplicate composite index definitions:\n  ${dupes.join('\n  ')}`).toEqual([]);
    });

    it('the two already-checked-in scheduled-worker indexes (Q25, Q26) are present', () => {
        for (const id of ['Q25', 'Q26']) {
            const c = contracts.find((x) => x.id === id)!;
            expect(c.status, `${id} should be marked status:"existing"`).toBe('existing');
            expect(
                indexSignatureSet.has(signature(c)),
                `${id} is expected to already exist in firestore.indexes.json`
            ).toBe(true);
        }
    });

    it('every contract collectionGroup/field is well-formed', () => {
        for (const c of contracts) {
            expect(c.id).toMatch(/^Q\d+$/);
            expect(c.collectionGroup.length).toBeGreaterThan(0);
            expect(['COLLECTION', 'COLLECTION_GROUP']).toContain(c.queryScope);
            expect(c.fields.length).toBeGreaterThan(0);
            for (const f of c.fields) {
                expect(['ASCENDING', 'DESCENDING', undefined]).toContain(f.order);
            }
        }
    });

    // Forbidden signatures whose composite still exists in firestore.indexes.json
    // pending its retirement unit. Once the unit removes the index, delete the
    // entry here so the test starts enforcing its absence.
    // Empty: all previously-pending composites have been removed from the local
    // manifest (U4 videoInterviews, U6 memory_operations). They now live in
    // PERMANENTLY_FORBIDDEN below.
    const FORBIDDEN_PENDING_REMOVAL = new Set<string>([]);

    // Signatures that must NEVER exist as an active composite. Wrong-schema
    // (would make a broken path look healthy) or retired dead paths.
    const PERMANENTLY_FORBIDDEN = [
        'invoices|COLLECTION|userId:ASCENDING,createdAt:DESCENDING',
        'billing_events|COLLECTION|userId:ASCENDING,createdAt:DESCENDING',
        'media_updates|COLLECTION|clientId:ASCENDING,timestamp:DESCENDING',
        'peer_recognitions|COLLECTION|toCaregiverId:ASCENDING,createdAt:DESCENDING',
        'videoInterviews|COLLECTION|caregiverId:ASCENDING,scheduledTime:DESCENDING',
        'videoInterviews|COLLECTION|clientId:ASCENDING,scheduledTime:DESCENDING',
        // U6: memory_operations cleanup composite removed; TTL replaces it.
        'memory_operations|COLLECTION|status:ASCENDING,expiresAt:ASCENDING',
    ];

    it('no permanently-forbidden wrong-schema/dead composite is present', () => {
        const present = PERMANENTLY_FORBIDDEN.filter((sig) => indexSignatureSet.has(sig));
        expect(present, `Forbidden composite(s) present in firestore.indexes.json:\n  ${present.join('\n  ')}`).toEqual([]);
    });

    it('no composites are pending retirement (allowlist is empty)', () => {
        const stillPending = [...FORBIDDEN_PENDING_REMOVAL].filter((sig) => indexSignatureSet.has(sig));
        expect(stillPending).toEqual([]);
    });
});
