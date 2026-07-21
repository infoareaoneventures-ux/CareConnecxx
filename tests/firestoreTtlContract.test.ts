// TTL policy + field-override contract (U6).
//
// Asserts firestore.indexes.json declares every intended TTL policy as a field
// override with `ttl: true` and `indexes: []` (no single-field index fanout on a
// retention timestamp), and that the removed memory_operations(status,expiresAt)
// cleanup composite is gone (TTL replaces it — Amendment A1).
//
// See docs/plans/2026-07-19-001-fix-firestore-index-data-integrity-hardening-plan.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const indexesDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
const overrides: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean; indexes?: unknown[] }> =
    indexesDoc.fieldOverrides ?? [];

// The seven intended TTL policies: [collectionGroup, fieldPath].
const TTL_POLICIES: Array<[string, string]> = [
    ['agent_audit_log', 'ttl'],
    ['agent_action_ledger', 'ttl'],
    ['user_activity_feed', 'ttl'],
    ['linq_outbound_queue', 'ttl'],
    ['agent_imessage_retry', 'ttl'],
    ['memory_operations', 'expiresAt'],
    ['linq_message_index', 'ttl'],
];

describe('Firestore TTL policy contract', () => {
    it.each(TTL_POLICIES)('%s.%s is a TTL field override with no single-field index', (cg, fp) => {
        const o = overrides.find((x) => x.collectionGroup === cg && x.fieldPath === fp);
        expect(o, `Missing TTL field override for ${cg}.${fp}`).toBeTruthy();
        expect(o!.ttl, `${cg}.${fp} must set ttl:true`).toBe(true);
        expect(o!.indexes, `${cg}.${fp} must set indexes:[] to stop single-field index fanout`).toEqual([]);
    });

    it('declares exactly the seven intended TTL policies (no accidental extras)', () => {
        const ttlOverrides = overrides.filter((o) => o.ttl === true);
        expect(ttlOverrides.length).toBe(TTL_POLICIES.length);
    });

    it('the memory_operations(status, expiresAt) cleanup composite is removed (A1)', () => {
        const present = (indexesDoc.indexes as Array<any>).some(
            (i) => i.collectionGroup === 'memory_operations' &&
                i.fields.length === 2 &&
                i.fields[0].fieldPath === 'status' &&
                i.fields[1].fieldPath === 'expiresAt',
        );
        expect(present, 'memory_operations(status, expiresAt) composite must be removed; TTL replaces it').toBe(false);
    });

    it('memory_operations expiresAt TTL uses the expiresAt field, not ttl', () => {
        const o = overrides.find((x) => x.collectionGroup === 'memory_operations');
        expect(o?.fieldPath).toBe('expiresAt');
    });
});
