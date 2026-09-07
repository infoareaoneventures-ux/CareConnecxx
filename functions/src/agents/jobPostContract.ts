import * as admin from "firebase-admin";

// Evia ↔ Web job-post contract (client-side parity wave, 2026-07-10).
//
// The caregiver Job Board (components/caregiver/JobBoard.tsx) renders the web
// wizard's JobPost shape (types.ts): `title`, `location` as a STRING, `rate`
// (number) + `rateFlexible`, `date` (mirror of startDate), top-level `lat`/`lng`,
// `clientName`, `requirements` (mirror of careTypes), `createdAt` as an ISO
// STRING. The server writers (Evia onboarding, the clientIntakes trigger, the
// MCP create_job_post tool) each hand-rolled a different shape — `summary`
// instead of title, `location` as an OBJECT (which crashes the board's JSX),
// `hourlyRate` instead of rate, Timestamp createdAt that the daily
// string-compared `createdAt >= isoString` match sweep can never see.
//
// Every server-side job_posts write MUST go through buildWebJobPostDoc so the
// board, the match sweeps, and the SMS notifiers all read one shape. Server-only
// extras (schedule object, summary, hourlyRate passthrough, notifiedCount) ride
// along for the existing SMS/snapshot consumers.

export interface WebJobPostInput {
  clientId:         string;
  source:           string;                  // "cara" | "cara_sms" | "intake_trigger"
  title:            string;
  description?:     string;
  clientName?:      string;
  careTypes?:       string[];
  careLevel?:       string;
  startDate?:       string;                  // "2026-08-01" or "ASAP" or free text
  endDate?:         string;                  // set only for a date-limited (non-ongoing) request
  frequency?:       string;                  // occasional | part_time | full_time | flexible
  days?:            string[];                // named days when known
  daysPerWeek?:     number;                  // count fallback when days unnamed
  timeOfDay?:       string[];                // morning | afternoon | evening | overnight
  hourlyRate?:      number | string;         // number, or "flexible"
  city?:            string;
  state?:           string;
  zipCode?:         string;
  lat?:             number | null;
  lng?:             number | null;
  recipientsCount?: number;
  caregiversNeeded?: number;      // 1-4, how many caregivers this job is looking to hire — mirrors PostJobFlow.tsx exactly
  minHoursPerWeek?: number;
  screeningQuestions?: string[];
  petsInHome?:      boolean;
  smokingHousehold?: boolean;
  phone?:           string;
  intakeId?:        string;
}

export function buildWebJobPostDoc(p: WebJobPostInput): Record<string, unknown> {
  const careTypes  = p.careTypes ?? [];
  const days       = p.days ?? [];
  const timeOfDay  = p.timeOfDay ?? [];
  const startDate  = (p.startDate || "ASAP") as string;
  const daysPerWeek = days.length || (p.daysPerWeek ?? 0);

  // Web rate contract: numeric `rate` + `rateFlexible` (the wizard writes
  // rate 0 when flexible). Evia's intake yields a number or the string
  // "flexible".
  const numericRate  = typeof p.hourlyRate === "number" && Number.isFinite(p.hourlyRate) && p.hourlyRate > 0
    ? p.hourlyRate : 0;
  const rateFlexible = numericRate === 0;

  // Cash/Venmo/Zelle removed platform-wide (Hamse, 2026-08-23) — every job
  // is paid by card now, regardless of what (if anything) a caller passes.
  // jobFrequency hyphenated (the board's pill map already handles 'occasional').
  const paymentMethod = "credit";
  const jobFrequency  = p.frequency ? p.frequency.replace(/_/g, "-") : undefined;

  const locationStr = [p.city, p.state, p.zipCode].filter(Boolean).join(", ");

  const description = (p.description ?? "").trim() ||
    `${careTypes.length ? careTypes.join(", ") : "General care"} needed` +
    `${p.city ? ` in ${p.city}` : ""}. Start: ${startDate}.` +
    `${timeOfDay.length ? ` Preferred times: ${timeOfDay.join(", ")}.` : ""}`;

  return {
    // ── Web JobPost contract (what the caregiver Job Board renders) ──────────
    clientId:     p.clientId,
    clientName:   p.clientName || "An Evia family",
    title:        p.title,
    description,
    rate:         numericRate,
    rateFlexible,
    date:         startDate,           // legacy mirror, same as the web wizard
    startDate,
    ...(p.endDate ? { endDate: p.endDate } : {}),
    ...(days.length      ? { daysOfWeek: days }   : {}),
    ...(timeOfDay.length ? { timeOfDay }          : {}),
    ...(jobFrequency     ? { jobFrequency }       : {}),
    paymentMethod,
    location:     locationStr,
    // streetAddress is deliberately NOT part of job_posts — the web wizard
    // (PostJobFlow.tsx) never sends it in this payload either; it only ever
    // lands in the carePlans mirror (see mirrorJobPostRecipientsToWeb).
    ...(p.city    ? { city: p.city }       : {}),
    ...(p.state   ? { state: p.state }     : {}),
    ...(p.zipCode ? { zipCode: p.zipCode } : {}),
    ...(typeof p.lat === "number" ? { lat: p.lat } : {}),
    ...(typeof p.lng === "number" ? { lng: p.lng } : {}),
    careTypes,
    requirements: careTypes,           // legacy mirror (jobMatchService keywords)
    ...(p.careLevel ? { careLevel: p.careLevel } : {}),
    ...(p.recipientsCount ? { recipientsCount: p.recipientsCount } : {}),
    // Matches PostJobFlow.tsx's own write exactly — always set, defaulting to
    // 1, never conditionally omitted.
    caregiversNeeded: p.caregiversNeeded || 1,
    ...(typeof p.minHoursPerWeek === "number" ? { minHoursPerWeek: p.minHoursPerWeek } : {}),
    ...(p.screeningQuestions?.length ? { screeningQuestions: p.screeningQuestions } : {}),
    petsInHome:       p.petsInHome ?? false,
    smokingHousehold: p.smokingHousehold ?? false,
    status:           "open",
    applicantCount:   0,
    // ISO string, NOT serverTimestamp: the board orders by createdAt alongside
    // web-written string values, and the daily match sweep compares
    // createdAt >= <iso string> — a Timestamp never matches either.
    createdAt:        new Date().toISOString(),

    // ── Server-side extras (SMS notifiers, snapshots, legacy readers) ─────────
    source:        p.source,
    notifiedCount: 0,
    ...(p.intakeId ? { intakeId: p.intakeId } : {}),
    ...(p.phone    ? { phone: p.phone }       : {}),
    ...(p.hourlyRate !== undefined ? { hourlyRate: p.hourlyRate } : {}),
    ...(daysPerWeek ? { daysPerWeek } : {}),
    schedule: { startDate, frequency: p.frequency ?? "flexible", days, timeOfDay, daysPerWeek },
    summary:  careTypes.length ? `New care job — ${careTypes.slice(0, 2).join(", ")}` : "New care job",
  };
}

export interface JobPostRecipient {
  firstName:    string;
  lastName?:    string;
  relationship?: string;
}

// Verbatim port of PostJobFlow.tsx's own post-submit mirror (lines 82-155,
// only runs there when careRecipients.length > 0) — job_postings gets the
// recipient roster, carePlans gets each recipient's care needs/notes/location.
// Fire-and-forget on the website (wrapped in try/catch, never blocks the
// job_posts write); called the same way here.
export async function mirrorJobPostRecipientsToWeb(params: {
  uid: string;
  careRecipients: JobPostRecipient[];
  careTypes: string[];
  careNeedDetails?: Record<string, unknown>;
  description?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  petsInHome?: boolean;
  smokingHousehold?: boolean;
}): Promise<void> {
  const { uid, careRecipients, careTypes, careNeedDetails, description, streetAddress, city, state, zipCode, petsInHome, smokingHousehold } = params;
  if (careRecipients.length === 0) return;
  const db = admin.firestore();
  try {
    const jpRef = db.collection("job_postings").doc(uid);
    const existing = await jpRef.get();
    const existingData = (existing.data() as Record<string, unknown>) ?? {};

    if (!existingData.careRecipientFirstName) {
      const primary = careRecipients[0];
      await jpRef.set({
        careRecipientFirstName: primary.firstName,
        careRecipientLastName:  primary.lastName || "",
        relationship:           primary.relationship || "",
      }, { merge: true });
    }

    for (const r of careRecipients) {
      const entry = { firstName: r.firstName, lastName: r.lastName || "", relationship: r.relationship || "", age: "" };
      if (
        entry.firstName === existingData.careRecipientFirstName &&
        entry.lastName === (existingData.careRecipientLastName || "")
      ) continue;
      await jpRef.set({ additionalRecipients: admin.firestore.FieldValue.arrayUnion(entry) }, { merge: true });
    }

    const cpRef = db.collection("carePlans").doc(uid);
    const cpSnap = await cpRef.get();
    const cpData = (cpSnap.data() as Record<string, any>) ?? {};
    const locationEntry = streetAddress
      ? [{ street: streetAddress, city, state, zipCode, petsInHome: petsInHome ?? false, smokingHousehold: smokingHousehold ?? false }]
      : [];

    if (streetAddress) {
      const pool: any[] = cpData.locationPool || [];
      const poolIdx = pool.findIndex((l: any) => l.street?.toLowerCase() === streetAddress.toLowerCase() && l.zipCode === zipCode);
      if (poolIdx >= 0) {
        pool[poolIdx] = { ...pool[poolIdx], petsInHome: petsInHome ?? false, smokingHousehold: smokingHousehold ?? false };
      } else {
        pool.push({ street: streetAddress, city, state, zipCode, petsInHome: petsInHome ?? false, smokingHousehold: smokingHousehold ?? false });
      }
      try { await cpRef.set({ locationPool: pool }, { merge: true }); } catch { /* non-critical */ }
    }

    for (const r of careRecipients) {
      const key = `${r.firstName.toLowerCase()}_${(r.lastName || "noname").toLowerCase()}`.replace(/\s+/g, "_");
      const existingLocs = cpData?.recipientPlans?.[key]?.locations;
      const updates: Record<string, unknown> = {
        [`recipientPlans.${key}.careNeeds`]:       careTypes,
        [`recipientPlans.${key}.careNeedDetails`]: careNeedDetails || {},
        [`recipientPlans.${key}.notes`]:           (description ?? "").trim(),
      };
      if (!existingLocs?.length) {
        updates[`recipientPlans.${key}.locations`] = locationEntry;
      }
      try {
        await cpRef.update(updates);
      } catch (e: any) {
        if (e.code === "not-found") {
          await cpRef.set({ recipientPlans: { [key]: { careNeeds: careTypes, careNeedDetails: careNeedDetails || {}, notes: (description ?? "").trim(), locations: locationEntry } } });
        }
      }
    }
  } catch {
    // non-critical — mirrors the website's own try/catch around this block
  }
}
