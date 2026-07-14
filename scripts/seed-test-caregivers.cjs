#!/usr/bin/env node
/*
 * Test-caregiver seeder for Evia end-to-end testing.
 *
 * Why: with zero caregivers in prod, a client signup dead-ends at the no-supply
 * hold — you can't reach matches -> paywall -> booking -> the QA-agent tools.
 * This seeds fully-bookable caregivers so the whole client flow is exercisable.
 *
 * Every seeded doc carries  __seedTag: "cara-test"  so cleanup is exact and can
 * NEVER touch a real caregiver. The shape mirrors the real onboarding finalize
 * write (onboardingConversation.ts ~L2889) plus the bookability gate
 * (status:active, onboardingStatus:profile_complete, verificationStatus:approved,
 * checkrResult:clear, verified:true, weeklyAvailability).
 *
 * Uses the Admin SDK (functions/serviceAccountKey.json) so it bypasses Firestore
 * rules — reliable for both seed and delete.
 *
 * Usage (run from repo root):
 *   node scripts/seed-test-caregivers.cjs seed                       # 3 in Los Altos Hills
 *   node scripts/seed-test-caregivers.cjs seed "San Jose" 5          # 5 in a named city
 *   node scripts/seed-test-caregivers.cjs cleanup                    # delete ALL __seedTag docs
 *   node scripts/seed-test-caregivers.cjs list                       # show current seeded docs
 *
 * IMPORTANT: pick a city that matches what you type during the test client
 * signup (Evia matches caregivers by exact city). Default is an uncommon Santa
 * Clara County city so seeded fakes don't surface to real Gilroy/San Jose signups.
 */

const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
const serviceAccount = require(path.join(__dirname, "..", "functions", "serviceAccountKey.json"));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const SEED_TAG = "cara-test";

// Hard guard: seeding writes fake, background-checked/verified caregiver
// docs. Never let that happen against the live prod project by accident —
// that's how a real family ends up matched to a fake caregiver. Checked only
// before the seed write path (not cleanup/list). Pass --allow-prod to
// override (e.g. deliberate prod smoke-testing with an explicit cleanup plan).
const PROD_PROJECT_ID = "careconnex-d4c8b";
function assertSeedNotProdUnlessAllowed() {
  const resolvedProjectId = serviceAccount.project_id;
  const allowProd = process.argv.includes("--allow-prod");
  if (resolvedProjectId === PROD_PROJECT_ID && !allowProd) {
    console.error(
      `REFUSING: this would seed fake caregivers into the LIVE prod project ("${PROD_PROJECT_ID}").\n` +
      `If you really mean to do this, re-run with --allow-prod.`,
    );
    process.exit(1);
  }
}

// A few Santa Clara County cities with coords, so seeded caregivers also have a
// real lat/lng for proximity matching. Default city is uncommon on purpose.
const SCC_COORDS = {
  "los altos hills": { zip: "94022", lat: 37.3797, lng: -122.1372 },
  "san jose":        { zip: "95110", lat: 37.3382, lng: -121.8863 },
  "gilroy":          { zip: "95020", lat: 37.0058, lng: -121.5683 },
  "palo alto":       { zip: "94301", lat: 37.4419, lng: -122.1430 },
  "mountain view":   { zip: "94040", lat: 37.3861, lng: -122.0839 },
  "sunnyvale":       { zip: "94086", lat: 37.3688, lng: -122.0363 },
};

const SAMPLE = [
  { name: "Maria Santos",  yearsExperience: 8, specialties: ["Dementia Care", "Mobility Assistance"], hourlyRate: 28, gender: "female", languages: ["English", "Spanish"], canDrive: true,  bio: "CNA who treats every client like family." },
  { name: "James Okafor",  yearsExperience: 5, specialties: ["Companionship", "Meal Preparation"],     hourlyRate: 25, gender: "male",   languages: ["English"],            canDrive: true,  bio: "Patient, reliable, and great with conversation." },
  { name: "Linda Tran",    yearsExperience: 12, specialties: ["Medication Management", "Bathing"],      hourlyRate: 32, gender: "female", languages: ["English", "Vietnamese"], canDrive: false, bio: "Twelve years of in-home senior care." },
  { name: "Robert Kim",    yearsExperience: 6, specialties: ["Mobility Assistance", "Housekeeping"],    hourlyRate: 26, gender: "male",   languages: ["English", "Korean"],   canDrive: true,  bio: "Calm, strong, and dependable." },
  { name: "Aisha Bello",   yearsExperience: 9, specialties: ["Dementia Care", "Companionship"],         hourlyRate: 30, gender: "female", languages: ["English"],            canDrive: true,  bio: "Specialized in memory care and dignity-first support." },
];

const WEEKLY_AVAILABILITY = {
  monday:    [{ start: "08:00", end: "18:00" }],
  tuesday:   [{ start: "08:00", end: "18:00" }],
  wednesday: [{ start: "08:00", end: "18:00" }],
  thursday:  [{ start: "08:00", end: "18:00" }],
  friday:    [{ start: "08:00", end: "18:00" }],
  saturday:  [{ start: "09:00", end: "15:00" }],
  sunday:    [],
};

async function seed(cityArg, countArg) {
  assertSeedNotProdUnlessAllowed();
  const city = cityArg || "Los Altos Hills";
  const key = city.toLowerCase().trim();
  const geo = SCC_COORDS[key] || { zip: "", lat: undefined, lng: undefined };
  if (!SCC_COORDS[key]) {
    console.warn(`! "${city}" not in the coords table — seeding without lat/lng (city-match still works).`);
  }
  const count = Math.max(1, Math.min(SAMPLE.length, Number(countArg) || 3));
  const now = new Date().toISOString();

  console.log(`Seeding ${count} test caregiver(s) in "${city}"...`);
  const created = [];
  for (let i = 0; i < count; i++) {
    const s = SAMPLE[i];
    const doc = {
      __seedTag: SEED_TAG,                 // marker for exact cleanup
      phone: `+1408555${String(1000 + i).slice(-4)}`,
      name: s.name,
      city,
      zipCode: geo.zip,
      ...(geo.lat !== undefined ? { lat: geo.lat, lng: geo.lng, location: { lat: geo.lat, lng: geo.lng } } : {}),
      yearsExperience: s.yearsExperience,
      certifications: ["CPR", "First Aid"],
      specialties: s.specialties,
      primaryServices: s.specialties.map((n) => ({ name: n })),
      availability: "Weekdays and Saturday mornings",
      weeklyAvailability: WEEKLY_AVAILABILITY,
      hourlyRate: s.hourlyRate,
      email: `${s.name.split(" ")[0].toLowerCase()}.test@example.com`,
      bio: s.bio,
      jobType: "part-time",
      gender: s.gender,
      languages: s.languages,
      canDrive: s.canDrive,
      // visibility + bookability gates
      status: "active",
      onboardingStatus: "profile_complete",
      verificationStatus: "approved",
      checkrResult: "clear",
      verified: true,
      source: "seed-test",
      createdAt: now,
    };
    const ref = await db.collection("caregivers").add(doc);
    created.push({ id: ref.id, name: s.name });
    console.log(`  + ${ref.id}  ${s.name}`);
  }
  console.log(`\nDone. ${created.length} caregiver(s) live in "${city}".`);
  console.log(`Test by signing up a client and giving "${city}" as the location.`);
  console.log(`When finished:  node scripts/seed-test-caregivers.cjs cleanup`);
}

async function cleanup() {
  const snap = await db.collection("caregivers").where("__seedTag", "==", SEED_TAG).get();
  if (snap.empty) { console.log("No seeded test caregivers found — nothing to delete."); return; }
  console.log(`Deleting ${snap.size} seeded test caregiver(s)...`);
  let n = 0;
  for (const d of snap.docs) {
    console.log(`  - ${d.id}  ${d.data().name || ""}`);
    await d.ref.delete();
    n++;
  }
  console.log(`\nDeleted ${n}. Real caregivers untouched (filtered on __seedTag).`);
}

async function list() {
  const snap = await db.collection("caregivers").where("__seedTag", "==", SEED_TAG).get();
  if (snap.empty) { console.log("No seeded test caregivers."); return; }
  console.log(`${snap.size} seeded test caregiver(s):`);
  snap.docs.forEach((d) => console.log(`  ${d.id}  ${d.data().name}  (${d.data().city})  ${d.data().status}/${d.data().verificationStatus}`));
}

(async () => {
  const mode = (process.argv[2] || "").toLowerCase();
  try {
    if (mode === "seed")          await seed(process.argv[3], process.argv[4]);
    else if (mode === "cleanup")  await cleanup();
    else if (mode === "list")     await list();
    else {
      console.log("Usage:");
      console.log('  node scripts/seed-test-caregivers.cjs seed ["City" [count]]');
      console.log("  node scripts/seed-test-caregivers.cjs cleanup");
      console.log("  node scripts/seed-test-caregivers.cjs list");
    }
    process.exit(0);
  } catch (err) {
    console.error("ERROR:", err && err.message ? err.message : err);
    process.exit(1);
  }
})();
