// Deterministic autonomy policy (plan 2026-07-18-001 U5, R27, KTD16).
//
// Whether an action runs automatically, requires explicit confirmation, or is
// denied is computed from explicit permissions, risk, reversibility, evidence
// coverage, and provider health — never from model self-confidence, and
// learned convenience can never override a required approval (R27).
// Pure module: no I/O, stable results.

export type ActionRisk = "read" | "low" | "medium" | "high" | "critical";

export type AutonomyDecision = "auto" | "confirm" | "deny";

export interface AutonomyInput {
  risk: ActionRisk;
  reversible: boolean;
  /** Explicit user permission for THIS class of action (e.g. canBookAutomatically). null = never asked. */
  explicitPermission: boolean | null;
  /** Can the action's postcondition be verified right now (provider/db healthy)? */
  evidenceAvailable: boolean;
  /** Current provider degradation (from operational snapshots / alerts). */
  providerHealthy: boolean;
}

export function decideAutonomy(input: AutonomyInput): AutonomyDecision {
  // Reads are always safe to run.
  if (input.risk === "read") return "auto";

  // Explicit denial is absolute (R27): no risk math can override the user.
  if (input.explicitPermission === false) return "confirm";

  // Money/medical/authority-critical writes always require an explicit
  // confirmation regardless of stored permissions — a standing permission
  // covers routine actions, not critical ones.
  if (input.risk === "critical") return "confirm";

  // Degraded providers or unverifiable postconditions demote autonomy one
  // notch: an action we cannot verify should not run silently.
  const degraded = !input.providerHealthy || !input.evidenceAvailable;

  if (input.risk === "high") {
    if (input.explicitPermission !== true) return "confirm";
    return degraded ? "confirm" : "auto";
  }

  // medium: explicit permission or reversibility earns auto when healthy.
  if (input.risk === "medium") {
    if (degraded) return "confirm";
    return input.explicitPermission === true || input.reversible ? "auto" : "confirm";
  }

  // low: auto unless degraded AND irreversible.
  return degraded && !input.reversible ? "confirm" : "auto";
}
