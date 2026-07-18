/**
 * READ-ONLY audit of hourlyRate field types across the `caregivers` collection.
 *
 * Prod docs written by the legacy onboarding correction path (and free-text
 * update_signup_field) can carry hourlyRate as a STRING ("25", "$25") instead
 * of a number. resolveCaregiverRate (functions/src/mcp/server.ts) coerces
 * strict plain-numeric strings; this script reports every doc whose
 * hourlyRate is NOT already a number so the team can see what shapes exist
 * and decide on a backfill. Changes nothing.
 *
 * Usage: node scripts/audit-hourly-rate-types.mjs
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sa = JSON.parse(readFileSync(join(root, 'functions/serviceAccountKey.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

// Mirror of the coercion rule in resolveCaregiverRate: trimmed, one leading
// "$" stripped, strict digits with optional decimal part, > 0.
function coercible(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim().replace(/^\$/, '');
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0;
}

async function run() {
  console.log('Auditing caregivers.hourlyRate types (read-only)\n');

  const snap = await db.collection('caregivers').get();
  const counts = { total: 0, number: 0, string_coercible: 0, string_junk: 0, missing: 0, other: 0 };
  const offenders = [];

  for (const doc of snap.docs) {
    counts.total++;
    const d = doc.data() || {};
    const rate = d.hourlyRate;
    if (typeof rate === 'number') { counts.number++; continue; }

    const name = d.name ?? d.fullName ?? '(no name)';
    if (rate === undefined || rate === null) {
      counts.missing++;
      offenders.push({ id: doc.id, name, type: rate === null ? 'null' : 'missing', value: rate });
    } else if (typeof rate === 'string') {
      const ok = coercible(rate);
      counts[ok ? 'string_coercible' : 'string_junk']++;
      offenders.push({ id: doc.id, name, type: ok ? 'string (coercible)' : 'string (NOT coercible)', value: rate });
    } else {
      counts.other++;
      offenders.push({ id: doc.id, name, type: typeof rate, value: rate });
    }
  }

  if (offenders.length === 0) {
    console.log('All caregiver docs carry a numeric hourlyRate (or none exist).');
  } else {
    console.log('=== Docs with non-number hourlyRate ===');
    for (const o of offenders) {
      console.log(`  ${o.id}  ${o.name}`);
      console.log(`    type: ${o.type}  value: ${JSON.stringify(o.value)}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  total caregiver docs:        ${counts.total}`);
  console.log(`  hourlyRate is number:        ${counts.number}`);
  console.log(`  string, coercible:           ${counts.string_coercible}`);
  console.log(`  string, NOT coercible:       ${counts.string_junk}`);
  console.log(`  missing/null:                ${counts.missing}`);
  console.log(`  other types:                 ${counts.other}`);
}

run().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e); process.exit(1); });
