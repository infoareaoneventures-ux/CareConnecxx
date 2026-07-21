// Hard environment guard for write-capable evals (plan 2026-07-18-001 U0,
// R45/AE22, Non-Production Trajectory Gate).
//
// Write-capable eval and trajectory runs create users, conversations, actions,
// and provider side effects. They must be TECHNICALLY unable to run against
// production — a runbook instruction is not a control. This module refuses:
//   - the production Firebase project (careconnex-d4c8b), from any of the env
//     vars the Admin SDK resolves a project from
//   - live-mode Stripe credentials
//   - any environment whose sandbox identity cannot be positively proven
//     (no project id at all = cannot prove = refuse)
//
// There is deliberately NO bypass parameter, env override, or CLI flag. If a
// future test genuinely needs production READS, it must use a different,
// read-only entry point — this guard stays absolute for write-capable runs.

export const PRODUCTION_PROJECT_ID = "careconnex-d4c8b";

export interface EvalEnvironmentReport {
  ok: boolean;
  projectId: string | null;
  violations: string[];
}

function resolveProjectId(env: NodeJS.ProcessEnv): string | null {
  const direct = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.FIREBASE_PROJECT_ID;
  if (direct) return direct;
  if (env.FIREBASE_CONFIG) {
    try {
      const parsed = JSON.parse(env.FIREBASE_CONFIG) as { projectId?: string };
      if (parsed.projectId) return parsed.projectId;
    } catch {
      // Malformed FIREBASE_CONFIG is reported as unprovable identity below.
    }
  }
  return null;
}

export function checkEvalEnvironment(env: NodeJS.ProcessEnv = process.env): EvalEnvironmentReport {
  const violations: string[] = [];
  const projectId = resolveProjectId(env);

  if (!projectId) {
    violations.push(
      "no Firebase project id found (GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT / FIREBASE_PROJECT_ID / FIREBASE_CONFIG) — sandbox identity cannot be proven",
    );
  } else if (projectId === PRODUCTION_PROJECT_ID) {
    violations.push(`Firebase project is PRODUCTION (${PRODUCTION_PROJECT_ID})`);
  }

  for (const name of ["STRIPE_SECRET_KEY", "STRIPE_API_KEY", "STRIPE_RESTRICTED_KEY"]) {
    const v = env[name];
    if (v && (v.startsWith("sk_live_") || v.startsWith("rk_live_"))) {
      violations.push(`${name} is a LIVE-mode Stripe credential`);
    }
  }

  // The Firestore emulator is a positive sandbox signal; its absence is only a
  // violation when combined with the production project (covered above), but a
  // production DATABASE_URL is refused outright.
  const dbUrl = env.FIREBASE_DATABASE_URL ?? "";
  if (dbUrl.includes(PRODUCTION_PROJECT_ID)) {
    violations.push("FIREBASE_DATABASE_URL points at the production project");
  }

  return { ok: violations.length === 0, projectId, violations };
}

/**
 * Throws before any read, write, message, or provider call when the
 * environment is production or unprovable. Call this FIRST in every
 * write-capable eval/trajectory entry point. No bypass exists.
 */
export function assertSafeEvalEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const report = checkEvalEnvironment(env);
  if (!report.ok) {
    throw new Error(
      `Write-capable eval refused (AE22 — no bypass exists):\n- ${report.violations.join("\n- ")}`,
    );
  }
}
