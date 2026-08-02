// ── Childcare rollback drill (plan 2026-07-22-002, U14 / Rollback Contract) ──
//
// Exercises the Rollback Contract ORDER against a synthetic world and asserts
// senior behavior is untouched. Nothing here rolls back a real deploy — it is a
// rehearsal that proves the sequence is correct and non-destructive:
//
//   1. Flags first: disable child discovery, contact, mutations, proactive
//      sources, and new external provider actions (server flags — no deploy).
//   2. Preserve accepted payment/booking state for controlled reconciliation;
//      NEVER blindly delete/reverse ledgers.
//   3. Revoke safety/chat/file access with NO current booking or authority.
//   4. Stop migration batches at a recorded cursor; compat adapters keep
//      reading already-migrated records.
//   5. Roll back Hosting/Functions only AFTER flags contain user impact
//      (code rollback last).
//   6. Senior production smokes before AND after — senior behavior unchanged.
//
// The drill is pure over an injected synthetic world; the write-capable variant
// (against an emulator) reuses the hard non-production guard.

import { assertNonProductionMigrationEnvironment } from "../migrations/nonProductionGuard";

export interface ChildFlagsWorld {
  enabled: boolean;
  discoveryEnabled: boolean;
  writesEnabled: boolean;
  proactiveEnabled: boolean;
  emergencyOff: boolean;
}

export interface SafetyAccessGrant {
  id: string;
  kind: "safety" | "chat" | "file";
  /** Whether this grant still has a CURRENT booking. */
  hasCurrentBooking: boolean;
  /** Whether the actor still holds CURRENT authority. */
  hasAuthority: boolean;
  revoked?: boolean;
}

export interface PaymentLedgerEntry {
  id: string;
  state: "authorized" | "captured" | "refunded";
}

export interface BookingState {
  id: string;
  state: string;
}

export interface RollbackWorld {
  seniorFlowsOperational: boolean;
  childFlags: ChildFlagsWorld;
  newProviderActionsAllowed: boolean;
  safetyAccess: SafetyAccessGrant[];
  paymentLedger: PaymentLedgerEntry[];
  bookings: BookingState[];
  migrationRunning: boolean;
  migrationCursor: string | null;
  hostingRolledBack: boolean;
  functionsRolledBack: boolean;
}

export interface RollbackStepLog {
  step: number;
  name: string;
  detail: string;
}

export interface RollbackDrillResult {
  steps: RollbackStepLog[];
  /** Stale (no booking/authority) access grants revoked this drill. */
  revokedAccessCount: number;
  /** Grants preserved because a current booking/authority still holds them. */
  retainedAccessCount: number;
  /** Payment/booking ledgers preserved (counts unchanged, nothing reversed). */
  ledgerPreserved: boolean;
  /** Code rollback happened strictly AFTER all flags were off. */
  codeRolledBackAfterFlags: boolean;
  /** Senior smoke identical before and after (behavior untouched). */
  seniorSmokeUnchanged: boolean;
  /** Synthetic snapshots for the proof bundle. */
  seniorSmokeBefore: Record<string, unknown>;
  seniorSmokeAfter: Record<string, unknown>;
}

/** Senior-visible surface the drill must NOT change. */
function seniorSmoke(world: RollbackWorld): Record<string, unknown> {
  return {
    operational: world.seniorFlowsOperational,
    ledgerSize: world.paymentLedger.length,
    ledgerStates: world.paymentLedger.map((p) => `${p.id}:${p.state}`).sort().join(","),
    bookingsSize: world.bookings.length,
    bookingStates: world.bookings.map((b) => `${b.id}:${b.state}`).sort().join(","),
  };
}

export interface RollbackDrillOptions {
  /** Migration cursor to freeze at (step 4). */
  cursor?: string;
  /** Assert the hard non-production guard (write-capable emulator runs). */
  assertEnvironment?: boolean;
}

/**
 * Run the rollback drill in order over a synthetic world (mutated in place).
 * Returns the ordered step log + the invariant assertions.
 */
export function runRollbackDrill(world: RollbackWorld, opts: RollbackDrillOptions = {}): RollbackDrillResult {
  if (opts.assertEnvironment) {
    assertNonProductionMigrationEnvironment("runRollbackDrill");
  }

  const steps: RollbackStepLog[] = [];
  const seniorSmokeBefore = seniorSmoke(world);
  const ledgerSizeBefore = world.paymentLedger.length;
  const bookingSizeBefore = world.bookings.length;

  // Step 1 — flags first (discovery/contact/mutations/proactive/new-provider).
  world.childFlags = {
    enabled: false,
    discoveryEnabled: false,
    writesEnabled: false,
    proactiveEnabled: false,
    emergencyOff: true,
  };
  world.newProviderActionsAllowed = false;
  const flagsOff =
    !world.childFlags.enabled &&
    !world.childFlags.discoveryEnabled &&
    !world.childFlags.writesEnabled &&
    !world.childFlags.proactiveEnabled &&
    !world.newProviderActionsAllowed;
  steps.push({ step: 1, name: "flags_off", detail: "discovery/contact/mutations/proactive/new-provider disabled via emergencyOff" });

  // Step 2 — preserve payment/booking state (no mutation, inventory only).
  steps.push({
    step: 2,
    name: "preserve_money_state",
    detail: `preserved ${world.paymentLedger.length} ledger entr(ies), ${world.bookings.length} booking(s) — none reversed`,
  });

  // Step 3 — revoke stale access (no current booking or authority).
  let revokedAccessCount = 0;
  let retainedAccessCount = 0;
  for (const grant of world.safetyAccess) {
    if (grant.hasCurrentBooking || grant.hasAuthority) {
      retainedAccessCount++;
    } else {
      grant.revoked = true;
      revokedAccessCount++;
    }
  }
  steps.push({ step: 3, name: "revoke_stale_access", detail: `revoked ${revokedAccessCount}, retained ${retainedAccessCount}` });

  // Step 4 — freeze migration at a recorded cursor.
  world.migrationRunning = false;
  world.migrationCursor = opts.cursor ?? world.migrationCursor ?? "frozen";
  steps.push({ step: 4, name: "freeze_migration", detail: `migration stopped at cursor ${world.migrationCursor}` });

  // Step 5 — code rollback LAST (only after flags contain user impact).
  const codeRolledBackAfterFlags = flagsOff; // must be true before we touch code
  if (codeRolledBackAfterFlags) {
    world.hostingRolledBack = true;
    world.functionsRolledBack = true;
  }
  steps.push({
    step: 5,
    name: "code_rollback_last",
    detail: codeRolledBackAfterFlags ? "Hosting/Functions rolled back after flags" : "REFUSED: flags not fully off",
  });

  // Step 6 — senior smoke after (must equal before).
  const seniorSmokeAfter = seniorSmoke(world);
  const seniorSmokeUnchanged = JSON.stringify(seniorSmokeBefore) === JSON.stringify(seniorSmokeAfter);
  steps.push({ step: 6, name: "senior_smoke", detail: seniorSmokeUnchanged ? "senior behavior unchanged" : "SENIOR REGRESSION" });

  const ledgerPreserved =
    world.paymentLedger.length === ledgerSizeBefore && world.bookings.length === bookingSizeBefore;

  return {
    steps,
    revokedAccessCount,
    retainedAccessCount,
    ledgerPreserved,
    codeRolledBackAfterFlags,
    seniorSmokeUnchanged,
    seniorSmokeBefore,
    seniorSmokeAfter,
  };
}
