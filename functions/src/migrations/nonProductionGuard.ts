// Hard non-production environment guard for childcare migration REHEARSALS,
// synthetic production smokes, and the rollback drill (childcare marketplace
// plan 2026-07-22-002, U14 — the plan's restored "hard guard").
//
// U14 migrations, smokes, and drills are REHEARSAL-CAPABLE, not executed
// against production: dry-run by default, and every write-capable path must be
// TECHNICALLY unable to touch the production Firebase project. A runbook
// instruction is not a control — this guard is.
//
// It deliberately REUSES the write-capable eval/trajectory environment guard
// (evals/evalEnvironmentGuard.ts) so there is exactly ONE definition of "which
// project is production" and "which Stripe key is live". There is NO bypass
// parameter, env override, or CLI flag: a future migration that genuinely needs
// production READS must use a separate read-only entry point.

import { checkEvalEnvironment, PRODUCTION_PROJECT_ID } from "../evals/evalEnvironmentGuard";

export { PRODUCTION_PROJECT_ID };

export interface NonProductionCheck {
  ok: boolean;
  projectId: string | null;
  violations: string[];
}

/**
 * Same resolution + refusal set as the eval guard: refuses the production
 * project (from any Admin-SDK project env var), live-mode Stripe credentials,
 * a production database URL, and an environment whose sandbox identity cannot
 * be positively proven (no project id at all = cannot prove = refuse).
 */
export function checkNonProductionEnvironment(env: NodeJS.ProcessEnv = process.env): NonProductionCheck {
  return checkEvalEnvironment(env);
}

/**
 * Throws BEFORE any write, message, or provider call when the environment is
 * production or unprovable. Call this FIRST in every write-capable childcare
 * migration / smoke / rollback-drill entry point. No bypass exists.
 */
export function assertNonProductionMigrationEnvironment(
  context: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const report = checkNonProductionEnvironment(env);
  if (!report.ok) {
    throw new Error(
      `${context} refused — production or unprovable environment (U14 restored hard guard, no bypass exists):\n- ${report.violations.join("\n- ")}`,
    );
  }
}
