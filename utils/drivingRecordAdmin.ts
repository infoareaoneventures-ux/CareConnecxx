// The admin's "Driving Record (MVR)" line — ONE rule for both admin surfaces
// (Admin › Caregivers detail and the Verification queue), 2026-10-06.
// Separate from the criminal check whether Checkr ran them bundled or apart:
// the server records the MVR on its own fields (mvrStatus / isApprovedDriver /
// mvrClearedAt / mvrReportId), so each surface reads those, never the overall
// report result.

export type AdminMvrStatus = 'clear' | 'pending' | 'consider' | 'suspended' | 'not_approved' | 'not started' | string;

/** Should the admin see a driving-record line for this record at all? */
export function adminMvrLineApplies(s: any): boolean {
  const offersTransportation = ((s?.services || s?.skills || []) as string[]).includes('Transportation');
  return offersTransportation || s?.mvrPaid === true || !!s?.mvrStatus || s?.isApprovedDriver === true;
}

/** The status word the pill shows. */
export function adminMvrStatusFor(s: any): AdminMvrStatus {
  if (s?.isApprovedDriver === true) return 'clear';
  return (s?.mvrStatus as string | undefined)
    ?? (s?.mvrCheckInitiated || s?.backgroundCheckData?.mvrIncluded ? 'pending' : 'not started');
}

/** Tailwind classes for the pill. */
export function adminMvrTone(status: AdminMvrStatus): string {
  return status === 'clear' ? 'bg-green-100 text-green-700'
    : status === 'consider' ? 'bg-orange-100 text-orange-700'
    : status === 'suspended' || status === 'not_approved' ? 'bg-red-100 text-red-700'
    : status === 'pending' ? 'bg-amber-100 text-amber-700'
    : 'bg-slate-100 text-slate-500';
}

/** What Transportation means for families given the record. */
export function adminTransportationLine(s: any): string {
  return s?.mvrStatus === 'not_approved' ? 'not approved — driving record'
    : s?.isApprovedDriver === true ? 'live for families — driving record clear'
    : 'waiting on the driving record';
}

/** The Checkr report the admin can open for the MVR: the standalone MVR report when
 *  it ran on its own, else the bundled criminal+MVR report (one report in Checkr). */
export function adminMvrReportId(s: any): string | null {
  if (typeof s?.mvrReportId === 'string' && s.mvrReportId) return s.mvrReportId;
  if (s?.backgroundCheckData?.mvrIncluded === true || (s?.mvrPaid === true && !s?.mvrCheckInitiated)) {
    const id = s?.backgroundCheckData?.checkrReportId;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

export const checkrReportUrl = (id: string) => `https://dashboard.checkr.com/reports/${id}`;
