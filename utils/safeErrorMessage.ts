// What a person may see when something fails (2026-10-19, live-caught: the job
// post wizard printed a raw Firestore message — with the record path — on screen).
//
// An error thrown by our own code with words written for the person ("You've
// already applied to this job") passes through. Anything that looks like an SDK
// or infrastructure message (Firestore / Storage / Functions shapes, paths,
// internal codes) is replaced by the caller's plain fallback. The detail belongs
// in console.error at the call site, never on screen.
const SDK_SHAPES: RegExp[] = [
  /FirebaseError/i,
  /Firestore/i,
  /Function \w+(\.\w+)*\(\)/,            // "Function DocumentReference.set() called with invalid data…"
  /FieldValue\./,
  /\bdocument [\w-]+\/[\w-]+/i,          // "…in document job_postings/abc123"
  /\b(job_postings|job_posts|users|caregivers|carePlans|shifts|booking_requests)\/[\w-]{8,}/,
  /Missing or insufficient permissions/i,
  /permission-denied|unauthenticated|unavailable|deadline-exceeded|resource-exhausted/i,
  /storage\/|gs:\/\/|firebasestorage/i,
  /\bINTERNAL\b|internal error|\bUNKNOWN\b/,
  /^Error:\s*$/,
];

export function safeErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const msg = raw.trim();
  if (!msg) return fallback;
  if (msg.length > 200) return fallback;
  if (SDK_SHAPES.some((re) => re.test(msg))) return fallback;
  return msg;
}
