#!/usr/bin/env node
/**
 * One-off backfill for name binding (2026-10-24): every care provider whose
 * background check already cleared gets the profile name compared with the
 * legal name they typed at consent (caregivers/{uid}/private/background).
 *
 *   match    → nameLocked: true, verifiedLegalName (nothing else changes)
 *   mismatch → nameReview { status: "mismatch", source: "checkr", ... } on the
 *              record + an admin_alerts row — the admin decides from the
 *              person's page (Use the verified name / Keep the account name).
 *              The provider stays active (already approved); only the name is
 *              in review. No text is sent by this script.
 *   no legal name on file → listed, nothing written.
 *
 * Usage:
 *   node scripts/backfill-name-binding.mjs             # dry run (default)
 *   node scripts/backfill-name-binding.mjs --execute   # actually write
 *
 * Requires admin credentials:
 *   gcloud auth application-default login
 *   # or: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');

// Same rules as functions/src/nameBinding.ts (keep in step).
const normalizeName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const split = (name) => { const p = String(name ?? '').trim().split(/\s+/).filter(Boolean); return { first: p[0] ?? '', last: p.slice(1).join(' ') }; };
const namesMatch = (a, v) => {
  const af = normalizeName(a.first), al = normalizeName(a.last), vf = normalizeName(v.first), vl = normalizeName(v.last);
  if (!af || !al || !vf || !vl) return false;
  if (al.replace(/ /g, '').length < 2) return false;
  return af === vf && al === vl;
};

async function main() {
  initializeApp();
  const db = getFirestore();
  console.log(EXECUTE ? 'EXECUTE mode — writing' : 'DRY RUN — nothing written');
  const snap = await db.collection('caregivers').where('backgroundCheckStatus', '==', 'clear').get();
  console.log(`${snap.size} cleared care providers`);
  let matched = 0, mismatched = 0, noLegal = 0, already = 0;
  for (const doc of snap.docs) {
    const cg = doc.data();
    if (cg.nameLocked === true || cg.nameReview?.status === 'mismatch') { already++; continue; }
    const pii = (await db.collection('caregivers').doc(doc.id).collection('private').doc('background').get()).data() ?? {};
    const first = String(pii.legalFirstName ?? '').trim(), last = String(pii.legalLastName ?? '').trim();
    const account = split(cg.name);
    const label = `${doc.id}  account="${cg.name ?? ''}"  legal="${[first, last].filter(Boolean).join(' ')}"`;
    if (!first && !last) { noLegal++; console.log(`NO LEGAL NAME  ${label}`); continue; }
    const now = new Date().toISOString();
    if (namesMatch(account, { first, last })) {
      matched++;
      console.log(`MATCH          ${label}`);
      if (EXECUTE) {
        await db.collection('caregivers').doc(doc.id).set({ nameLocked: true, verifiedLegalName: [first, last].filter(Boolean).join(' ') }, { merge: true });
        await db.collection('users').doc(doc.id).set({ nameLocked: true, verifiedLegalName: [first, last].filter(Boolean).join(' ') }, { merge: true }).catch(() => {});
      }
    } else {
      mismatched++;
      console.log(`MISMATCH       ${label}`);
      if (EXECUTE) {
        const review = { status: 'mismatch', source: 'checkr', accountName: String(cg.name ?? ''), verifiedFirst: first, verifiedLast: last, at: now };
        await db.collection('caregivers').doc(doc.id).set({ nameReview: review }, { merge: true });
        await db.collection('users').doc(doc.id).set({ nameReview: review }, { merge: true }).catch(() => {});
        await db.collection('admin_alerts').add({
          type: 'name_mismatch', severity: 'high', priority: 'high', userId: doc.id, role: 'caregiver', phone: cg.phone ?? null,
          message: `${cg.name || 'An account with no name'} (care provider, already cleared): the background check cleared as "${[first, last].filter(Boolean).join(' ')}" but the account says "${cg.name || '—'}". Decide from their admin page.`,
          source: 'name_binding_backfill', createdAt: now, resolved: false,
        });
      }
    }
  }
  console.log(`\nmatched ${matched} · mismatched ${mismatched} · no legal name ${noLegal} · already handled ${already}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
