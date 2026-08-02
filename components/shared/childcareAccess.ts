// ── Childcare UI access + shared helpers (plan 2026-07-22-002, U11) ──────────
//
// Component-side seam for the childcare product surfaces. Everything here is
// callable-only (R11/KTD6): no Firestore reads/writes, no services additions.
//
// GATING CONTRACT (binding U11 rule): childcare visibility is fetched ONCE per
// session through the callables that already carry availability —
// v1-getMyHouseholdState (family) and v1-getMyChildcareProviderState
// (caregiver). Flags-off, network failure, or any other error resolve to
// `unavailable`, which HIDES the additive surfaces — an availability probe can
// never break a senior screen. The dedicated childcare pages do their own
// FRESH fetches with explicit loading/error/unavailable states; this cache is
// only for nav entries / hub switches / additive sections.
//
// PRIVACY: nothing here touches localStorage/sessionStorage/URLs/analytics —
// the session cache is an in-memory module variable (R57 / U11 binding rule).

import { functions } from '../../lib/firebase';
import { childcareCallable } from '../../lib/childcareCallable';

// ── Shared response types (component-local — types.ts is read-only) ─────────

export interface HouseholdSummary {
  householdId: string;
  status?: string;
  isPrimary: boolean;
  membershipStatus?: string;
  membershipRole?: string;
  derivedSummary?: {
    activeAdultCount?: number;
    provisionalMemberCount?: number;
    childIdsWithActiveAuthority?: string[];
    careVerticals?: string[];
    summaryVersion?: number;
  } | null;
}

export interface AuthoritySummary {
  authorityId: string;
  householdId: string;
  childId: string;
  scopes: string[];
  state: string;
  expiresAt: string | null;
  accessVersion: number;
}

export interface ChildSummary {
  childId: string;
  displayLabel: string;
  ageBand: string;
  careCategories: string[];
  safetyCurrentVersion: number;
}

export interface ChildcareJobSummary {
  jobId: string;
  title?: string;
  status?: string | null;
  childCount?: number | null;
  ageBands?: string[];
  serviceCategories?: string[];
  transportRequired?: boolean;
  schedule?: { startDate?: string; days?: string[]; timeOfDay?: string[] } | null;
  rate?: number | null;
  rateFlexible?: boolean;
  areaLabel?: string | null;
  applicantCount?: number;
  createdAt?: string | null;
}

export interface ChildcareApplicationSummary {
  applicationId: string;
  jobId: string | null;
  caregiverId: string | null;
  status: string | null;
  appliedAt?: string | null;
  jobTitle?: string;
  rate?: number | null;
}

/** Booking summary as the server projects it (subset of ChildcareBookingDoc). */
export interface ChildcareBookingSummary {
  bookingId: string;
  status: string;
  statusDescription?: string;
  stateVersion?: number;
  caregiverId?: string;
  caregiverName?: string;
  /** Age-band-safe display label(s) — the only recipient display field (R33). */
  recipientLabel?: string;
  childIds?: string[];
  schedule?: {
    dates?: Array<{ date: string; startTime: string; endTime: string }>;
    recurring?: { days: string[]; startTime: string; endTime: string } | null;
  } | null;
  hourlyRate?: number | null;
  paymentAuthorization?: { state?: string } | null;
  safetyAccessVersion?: number | null;
  pendingChange?: unknown;
}

export interface ChildcareProviderStateResponse {
  success?: boolean;
  hasVerticalProfile: boolean;
  verticalProfile: {
    ageBands: string[];
    services: string[];
    yearsChildcareExperience: number | null;
    hourlyRate: number | null;
    transport: { offersTransport: boolean };
    limitations: string[];
    jurisdictionState: string | null;
    adultAgeAttested: boolean;
    acceptedPolicyVersion: string | null;
    approvalState: string;
    suspensionActive: boolean;
    profileVersion: number;
  } | null;
  screening: {
    evidenceStatus: string;
    invitationStatus: string;
    expiresAt: string | null;
    adverseActionState: string;
    evidenceVersion: number;
  } | null;
  reusedBaseFields: string[];
  missingBaseFields: string[];
  missingChildcareFields: string[];
  eligibility: {
    eligible: boolean;
    issues: Array<{ code: string; field: string }>;
    transportCapable: boolean;
    renewalDue?: boolean;
  };
}

// ── Small helpers shared by the childcare components ─────────────────────────

/** Extract the machine-stable error code from a callable rejection. */
export function callableErrorCode(err: unknown): string {
  const details = (err as { details?: { code?: string } })?.details;
  if (details && typeof details.code === 'string') return details.code;
  // v8 compat HttpsError also exposes .code like "functions/permission-denied"
  const code = (err as { code?: string })?.code;
  return typeof code === 'string' ? code : '';
}

export function isChildcareDisabledError(err: unknown): boolean {
  return callableErrorCode(err) === 'childcare_disabled';
}

export function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const AGE_BAND_LABELS: Record<string, string> = {
  infant: 'Under 1',
  toddler: '1–2 yrs',
  preschool: '3–4 yrs',
  school_age: '5–9 yrs',
  preteen: '10–12 yrs',
  teen: '13–17 yrs',
};

export function ageBandLabel(band: string): string {
  return AGE_BAND_LABELS[band] ?? band;
}

export function categoryLabel(category: string): string {
  return String(category)
    .split('_')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Display text for the ALLOWLISTED public evidence labels (R30). Only what the
 * projection provides is shown — no new claims, no safety-guarantee language.
 */
export const CHILDCARE_EVIDENCE_LABEL_TEXT: Record<string, string> = {
  background_check_current: 'Background check current',
  childcare_reviewed: 'Reviewed for childcare',
  childcare_policy_accepted: 'Childcare policy accepted',
  transport_capable: 'Can drive for childcare',
};

// ── Session-scoped availability cache (fetch once per session) ───────────────

export type ChildcareAccessStatus = 'available' | 'unavailable';

export interface FamilyChildcareAccess {
  status: ChildcareAccessStatus;
  households: HouseholdSummary[];
  authorities: AuthoritySummary[];
  children: ChildSummary[];
  hasChildren: boolean;
}

export interface CaregiverChildcareAccess {
  status: ChildcareAccessStatus;
  provider: ChildcareProviderStateResponse | null;
}

const UNAVAILABLE_FAMILY: FamilyChildcareAccess = {
  status: 'unavailable',
  households: [],
  authorities: [],
  children: [],
  hasChildren: false,
};

const UNAVAILABLE_CAREGIVER: CaregiverChildcareAccess = {
  status: 'unavailable',
  provider: null,
};

type ChildcareAccessRole = 'family' | 'caregiver';
type AccessCacheEntry<T> = {
  uid: string;
  role: ChildcareAccessRole;
  generation: number;
  promise: Promise<T>;
};

const familyAccessPromises = new Map<string, AccessCacheEntry<FamilyChildcareAccess>>();
const caregiverAccessPromises = new Map<string, AccessCacheEntry<CaregiverChildcareAccess>>();
let accessCacheGeneration = 0;

function accessKey(uid: string, role: ChildcareAccessRole): string {
  return `${uid}:${role}`;
}

/** Auth-transition/test hook. Invalidates in-flight and settled cache entries. */
export function resetChildcareAccessCache(uid?: string): void {
  accessCacheGeneration += 1;
  if (!uid) {
    familyAccessPromises.clear();
    caregiverAccessPromises.clear();
    return;
  }
  familyAccessPromises.delete(accessKey(uid, 'family'));
  caregiverAccessPromises.delete(accessKey(uid, 'caregiver'));
}

/**
 * Family-side availability + summaries, cached once per session. NEVER throws:
 * flags-off / errors resolve to `unavailable` so gated surfaces simply hide.
 */
export function fetchFamilyChildcareAccess(
  uid: string | null | undefined,
  opts: { force?: boolean } = {},
): Promise<FamilyChildcareAccess> {
  if (!uid) return Promise.resolve(UNAVAILABLE_FAMILY);
  const key = accessKey(uid, 'family');
  if (opts.force) familyAccessPromises.delete(key);
  const cached = familyAccessPromises.get(key);
  if (cached) return cached.promise;

  const generation = accessCacheGeneration;
  let failed = false;
  const load = async (): Promise<FamilyChildcareAccess> => {
      if (!functions) return UNAVAILABLE_FAMILY;
      const [householdResp, childrenResp] = await Promise.all([
        childcareCallable('getMyHouseholdState')({}),
        childcareCallable('listMyChildren')({}),
      ]);
      const householdData = householdResp.data as {
        households?: HouseholdSummary[];
        authorities?: AuthoritySummary[];
      };
      const childrenData = childrenResp.data as { children?: ChildSummary[] };
      const children = childrenData?.children ?? [];
      return {
        status: 'available',
        households: householdData?.households ?? [],
        authorities: householdData?.authorities ?? [],
        children,
        hasChildren: children.length > 0,
      };
    };
  const promise = load()
    .catch(() => {
      failed = true;
      return UNAVAILABLE_FAMILY;
    })
    .finally(() => {
      const current = familyAccessPromises.get(key);
      if (failed && current?.promise === promise) familyAccessPromises.delete(key);
    });
  familyAccessPromises.set(key, { uid, role: 'family', generation, promise });
  return promise;
}

/**
 * Caregiver-side availability + own provider state, cached once per session.
 * NEVER throws — unavailable hides the additive caregiver surfaces.
 */
export function fetchCaregiverChildcareAccess(
  uid: string | null | undefined,
  opts: { force?: boolean } = {},
): Promise<CaregiverChildcareAccess> {
  if (!uid) return Promise.resolve(UNAVAILABLE_CAREGIVER);
  const key = accessKey(uid, 'caregiver');
  if (opts.force) caregiverAccessPromises.delete(key);
  const cached = caregiverAccessPromises.get(key);
  if (cached) return cached.promise;

  const generation = accessCacheGeneration;
  let failed = false;
  const load = async (): Promise<CaregiverChildcareAccess> => {
      if (!functions) return UNAVAILABLE_CAREGIVER;
      const resp = await childcareCallable('getMyChildcareProviderState')({});
      return { status: 'available', provider: resp.data as ChildcareProviderStateResponse };
    };
  const promise = load()
    .catch(() => {
      failed = true;
      return UNAVAILABLE_CAREGIVER;
    })
    .finally(() => {
      const current = caregiverAccessPromises.get(key);
      if (failed && current?.promise === promise) caregiverAccessPromises.delete(key);
    });
  caregiverAccessPromises.set(key, { uid, role: 'caregiver', generation, promise });
  return promise;
}
