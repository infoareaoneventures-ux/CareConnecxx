// Typed per-turn CareSituation (plan 2026-07-18-001 U2, R3/R7-R12, KTD3).
//
// One ephemeral, provenance-aware picture of the actor, senior, and current
// care state, assembled BEFORE prompt rendering. Wave 1 ships this DARK: the
// `care_situation` rollout capability gates a shadow build that wraps values
// the turn already loaded (zero additional Firestore reads) and emits
// content-free health metrics. Prompt consumption comes later, gated on
// shadow parity.
//
// Contracts enforced here:
//  - R3: every fact carries source type/ref, authority, and retrieval time.
//  - R11: a failed loader never erases sibling domain state; statuses
//    distinguish loaded / none / unavailable / stale / skipped.
//  - R10: free-text content is marked untrusted so the projection layer must
//    sanitize it at the prompt boundary; this module never renders prose.
//  - R55: loaders run concurrently under per-loader timeouts inside one
//    overall budget; a slow domain degrades to `unavailable`, never hangs
//    the turn.

export const CARE_SITUATION_CAPABILITY = "care_situation";

export const DEFAULT_LOADER_TIMEOUT_MS = 2_500;

export type EvidenceSourceType = "firestore" | "prefetch" | "derived" | "memory" | "provider";

// Authority tiers per the plan's Authority And Evidence Order (fresh canonical
// reads outrank derived observations outrank memory outrank inference).
export type EvidenceAuthority = "canonical" | "derived" | "memory" | "inferred";

export type DomainStatus =
  | "loaded"       // loader succeeded and returned substantive data
  | "none"         // loader succeeded and the domain is genuinely empty
  | "unavailable"  // loader failed or timed out — truth unknown, NOT empty
  | "stale"        // loaded but older than the domain's freshness window
  | "skipped";     // not attempted (missing identity, out of role scope)

export interface EvidenceFact<T> {
  value: T;
  source: { type: EvidenceSourceType; ref: string };
  authority: EvidenceAuthority;
  retrievedAt: string; // ISO
  /** Effective/observed time of the underlying record, when known. */
  observedAt?: string;
  /** True when the value contains free text that must be sanitized at the prompt boundary. */
  untrusted?: boolean;
}

export interface DomainResult<T> {
  status: DomainStatus;
  fact?: EvidenceFact<T>;
  /** Short machine reason for unavailable/skipped — never raw error content. */
  reason?: string;
  latencyMs: number;
}

export type CareSituationRole = "client" | "caregiver" | "unknown";
export type CareSituationChannel = "linq" | "web";

export interface CareSituationActor {
  phone: string;
  userId?: string;
  seniorId?: string;
  role: CareSituationRole;
  channel: CareSituationChannel;
}

export interface CareSituation {
  actor: CareSituationActor;
  builtAt: string;
  domains: {
    seniorProfile: DomainResult<Record<string, unknown> | null>;
    nextAppointment: DomainResult<Record<string, unknown> | null>;
    recentJournal: DomainResult<Array<Record<string, unknown>>>;
  };
  totalLatencyMs: number;
}

// A domain loader returns the raw value plus enough metadata to build the
// fact. Loaders may be real async reads or sync wrappers around values the
// turn already fetched (the Wave 1 shadow path).
export interface DomainLoader<T> {
  load: () => Promise<T> | T;
  source: { type: EvidenceSourceType; ref: string };
  authority: EvidenceAuthority;
  untrusted?: boolean;
  /** Distinguishes "loaded" from "none" for this domain's value shape. */
  isEmpty?: (value: T) => boolean;
}

export interface CareSituationLoaders {
  seniorProfile?: DomainLoader<Record<string, unknown> | null>;
  nextAppointment?: DomainLoader<Record<string, unknown> | null>;
  recentJournal?: DomainLoader<Array<Record<string, unknown>>>;
}

async function runLoader<T>(
  loader: DomainLoader<T> | undefined,
  emptyValue: T,
  opts: { timeoutMs: number; now: () => number; nowIso: () => string },
): Promise<DomainResult<T>> {
  if (!loader) return { status: "skipped", reason: "no_loader", latencyMs: 0 };

  const started = opts.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve(loader.load()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("loader_timeout")), opts.timeoutMs);
      }),
    ]);
    const latencyMs = opts.now() - started;
    const empty = loader.isEmpty
      ? loader.isEmpty(value)
      : value === null || value === undefined || (Array.isArray(value) ? value.length === 0 : false);
    if (empty) return { status: "none", latencyMs };
    return {
      status: "loaded",
      latencyMs,
      fact: {
        value,
        source: loader.source,
        authority: loader.authority,
        retrievedAt: opts.nowIso(),
        untrusted: loader.untrusted,
      },
    };
  } catch (err) {
    // R11: failure is UNKNOWN truth, never rendered as "empty"; the reason is
    // a short enum-ish token, never raw error content (which could carry PII).
    const reason = err instanceof Error && err.message === "loader_timeout" ? "timeout" : "load_error";
    return { status: "unavailable", reason, latencyMs: opts.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildCareSituation(
  actor: CareSituationActor,
  loaders: CareSituationLoaders,
  opts?: { loaderTimeoutMs?: number; now?: () => Date },
): Promise<CareSituation> {
  const nowFn = opts?.now ?? (() => new Date());
  const clock = { now: () => nowFn().getTime(), nowIso: () => nowFn().toISOString() };
  const timeoutMs = opts?.loaderTimeoutMs ?? DEFAULT_LOADER_TIMEOUT_MS;
  const started = clock.now();

  // Independent domains load concurrently (R55); each failure is isolated to
  // its own DomainResult (R11).
  const [seniorProfile, nextAppointment, recentJournal] = await Promise.all([
    runLoader(loaders.seniorProfile, null, { timeoutMs, ...clock }),
    runLoader(loaders.nextAppointment, null, { timeoutMs, ...clock }),
    runLoader(loaders.recentJournal, [] as Array<Record<string, unknown>>, { timeoutMs, ...clock }),
  ]);

  return {
    actor,
    builtAt: clock.nowIso(),
    domains: { seniorProfile, nextAppointment, recentJournal },
    totalLatencyMs: clock.now() - started,
  };
}

/** Content-free per-domain status map for shadow telemetry (R52). */
export function situationHealth(s: CareSituation): Record<string, DomainStatus> {
  return {
    seniorProfile: s.domains.seniorProfile.status,
    nextAppointment: s.domains.nextAppointment.status,
    recentJournal: s.domains.recentJournal.status,
  };
}
