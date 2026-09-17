import * as admin from "firebase-admin";

const db = admin.firestore();

// Accepts a real numeric rate, or a numeric-looking string (legacy docs), and
// nothing else. Anything else ("flexible", "25/hr", "", "abc", 0, negative)
// stays unknown: returns null. Shared so quote/booking paths everywhere agree
// on what counts as a real rate.
export function coerceHourlyRate(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\$/, "");
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

export type CaregiverRateResult =
  | { ok: true; caregiverName: string; hourlyRate: number }
  | { ok: false; message: string };

// Resolve caregiver name + hourly rate from the caregiver doc — the single
// source of truth every booking-creating call site must use. Extracted
// 2026-09-13 from mcp/server.ts's request_booking path (R9, 2026-07-17) after
// finding two OTHER booking call sites (routeIntent.ts's rebook flow,
// the since-retired taskApprovalHandler.ts) still carrying the exact hardcoded-$20-fallback
// pattern R9 was written to kill — they just never got updated to the fix
// applied here. When NO hourlyRate is on file this returns a structured
// failure instead of ever guessing a number: a fabricated rate here becomes
// a fabricated quote AND a fabricated charge the caregiver is asked to
// accept — the agent must ask for / confirm the real rate instead of
// silently booking at a made-up price.
// Name + existence only — decoupled from hourlyRate (2026-09-13). Confirmed
// against the website's own "Send Booking Request" modal: it NEVER defaults
// the committed booking rate from caregivers/{id}.hourlyRate (that field is
// browsing/display-only — search results, profile page, interview modal).
// The modal only ever defaults from the linked job post's own `rate` field,
// or leaves the input blank requiring the family to type one — so a call
// site building the actual COMMITTED rate for a booking must use the same
// precedence (agreedRate ?? job post rate ?? require it), never fall back
// to this caregiver doc's hourlyRate as if it were a real booking default.
export async function resolveCaregiverName(
  caregiverId: string,
): Promise<{ ok: true; caregiverName: string } | { ok: false; message: string }> {
  if (!caregiverId) return { ok: false, message: "caregiverId is required" };
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  if (!cgSnap.exists) return { ok: false, message: "caregiver not found" };
  const cg = cgSnap.data() || {};
  return { ok: true, caregiverName: (cg.name ?? cg.fullName ?? "your caregiver") as string };
}

export async function resolveCaregiverRate(caregiverId: string): Promise<CaregiverRateResult> {
  if (!caregiverId) return { ok: false, message: "caregiverId is required" };
  const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
  if (!cgSnap.exists) return { ok: false, message: "caregiver not found" };
  const cg = cgSnap.data() || {};
  const caregiverName = (cg.name ?? cg.fullName ?? "your caregiver") as string;
  const hourlyRate = coerceHourlyRate(cg.hourlyRate);
  if (hourlyRate === null) {
    return {
      ok: false,
      message:
        `${caregiverName} has no hourly rate on file, so nothing was quoted or booked. ` +
        `Do NOT assume, invent, or state any dollar rate. Tell the family you need to confirm ` +
        `this caregiver's rate first, and do not quote or book until a real rate is on file. ` +
        `If the family needs this resolved now, use create_support_ticket so the team can confirm the caregiver's rate.`,
    };
  }
  return { ok: true, caregiverName, hourlyRate };
}
