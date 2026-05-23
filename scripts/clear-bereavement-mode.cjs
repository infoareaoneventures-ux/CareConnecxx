// Clears a stale bereavementMode flag on agent_sessions docs.
//
// Why: a bug in isBereavementTrigger classified a bare "Yes" as a death
// disclosure, flipping sessions into bereavement mode. Once set, every
// subsequent reply gets routed through the bereavement branch.
//
// Usage:
//   node scripts/clear-bereavement-mode.cjs                  # list affected sessions (dry run)
//   node scripts/clear-bereavement-mode.cjs --phone=+1XXX    # clear one phone
//   node scripts/clear-bereavement-mode.cjs --all            # clear every flagged session
//
// Requires GOOGLE_APPLICATION_CREDENTIALS or default app creds.

const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const args = process.argv.slice(2);
const phoneArg = args.find((a) => a.startsWith('--phone='))?.split('=')[1];
const clearAll = args.includes('--all');

async function clearOne(docRef, data) {
  await docRef.update({
    bereavementMode: admin.firestore.FieldValue.delete(),
    bereavementActivatedAt: admin.firestore.FieldValue.delete(),
    bereavementClearedAt: new Date().toISOString(),
    bereavementClearedReason: 'false_trigger_from_bare_ack',
  });
  console.log(`Cleared bereavementMode for ${docRef.id} (activated ${data.bereavementActivatedAt ?? 'unknown'})`);
}

async function main() {
  if (phoneArg) {
    const ref = db.collection('agent_sessions').doc(phoneArg);
    const snap = await ref.get();
    if (!snap.exists) {
      console.error(`No agent_sessions doc for ${phoneArg}`);
      process.exit(1);
    }
    if (!snap.data().bereavementMode) {
      console.log(`${phoneArg} is not in bereavement mode — nothing to do.`);
      return;
    }
    await clearOne(ref, snap.data());
    return;
  }

  const snap = await db.collection('agent_sessions').where('bereavementMode', '==', true).get();
  if (snap.empty) {
    console.log('No sessions currently in bereavement mode.');
    return;
  }

  console.log(`Found ${snap.size} session(s) in bereavement mode:`);
  for (const doc of snap.docs) {
    const d = doc.data();
    console.log(`  ${doc.id}  activatedAt=${d.bereavementActivatedAt ?? 'unknown'}  userId=${d.userId ?? '-'}`);
  }

  if (!clearAll) {
    console.log('\nDry run — re-run with --all to clear all of the above, or --phone=+1XXX to clear one.');
    return;
  }

  for (const doc of snap.docs) {
    await clearOne(doc.ref, doc.data());
  }
  console.log(`\nCleared ${snap.size} session(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
