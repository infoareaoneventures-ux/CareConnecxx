/**
 * Centralized resolution + validation of MVR ("Approved Driver") configuration.
 *
 * The MVR feature hinges on env config that, when wrong, fails silently in one of
 * two dangerous ways. These helpers turn both into loud errors at the charge/check
 * boundary instead:
 *   - MVR shown/charged but no check runs — STRIPE_MVR_PRICE_ID unset → the line item
 *     is silently dropped, so the caregiver pays for membership only yet is told they
 *     have MVR.
 *   - MVR check runs with no charge — a CHECKR_PACKAGE_MVR* var defaulting to (or set
 *     equal to) the base criminal-only package, so an MVR-priced order runs a non-MVR
 *     check (or vice versa).
 */

const PLACEHOLDER_PREFIX = "FILL_IN";

function clean(v: string | undefined): string {
  return (v ?? "").trim();
}

/** The base (criminal-only) Checkr package. Mirrors the historical default. */
export function basePackage(): string {
  return clean(process.env.CHECKR_PACKAGE) || "driver_pro";
}

/** The configured MVR add-on price id (may be empty/placeholder — see isMvrPaymentConfigured). */
export function mvrPriceId(): string {
  return clean(process.env.STRIPE_MVR_PRICE_ID);
}

/** True when the MVR add-on price is set and not a placeholder — safe to offer/charge. */
export function isMvrPaymentConfigured(): boolean {
  const id = mvrPriceId();
  return id.length > 0 && !id.startsWith(PLACEHOLDER_PREFIX);
}

/** Resolve the MVR price id or throw. Call before creating an MVR charge/line item. */
export function assertMvrPaymentConfig(): string {
  const id = mvrPriceId();
  if (!id || id.startsWith(PLACEHOLDER_PREFIX)) {
    throw new Error(
      "MVR not configured: STRIPE_MVR_PRICE_ID is unset or a placeholder.",
    );
  }
  return id;
}

export type MvrCheckKind = "bundled" | "mvr_only";

/**
 * Resolve the Checkr package for an MVR-bearing check and assert it differs from the
 * base criminal-only package. `bundled` = criminal+MVR (signup); `mvr_only` = the
 * standalone later add. Throws when unset or equal to the base package — either of
 * which would mean charging for MVR while running the wrong check.
 */
/** Boolean form of assertMvrCheckConfig — true when the kind's package is set and distinct from base. */
export function isMvrCheckConfigured(kind: MvrCheckKind): boolean {
  try {
    assertMvrCheckConfig(kind);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when the bundled signup MVR can be BOTH charged (price set) AND run
 * (bundled package set and distinct from base). The gate for adding the MVR line
 * item at signup — if false, MVR is never charged, so it can never run uncharged.
 */
export function canChargeBundledMvr(): boolean {
  return isMvrPaymentConfigured() && isMvrCheckConfigured("bundled");
}

/**
 * True only when the standalone "add MVR later" upgrade can be BOTH charged
 * (price set) AND run (MVR-only package set and distinct from base). The gate for
 * offering/creating the one-time MVR add-on checkout.
 */
export function canChargeStandaloneMvr(): boolean {
  return isMvrPaymentConfigured() && isMvrCheckConfigured("mvr_only");
}

export function assertMvrCheckConfig(kind: MvrCheckKind): string {
  const envName = kind === "mvr_only" ? "CHECKR_PACKAGE_MVR_ONLY" : "CHECKR_PACKAGE_MVR";
  const pkg = clean(process.env[envName]);
  if (!pkg) {
    throw new Error(`MVR not configured: ${envName} is unset.`);
  }
  if (pkg === basePackage()) {
    throw new Error(
      `MVR misconfigured: ${envName} ("${pkg}") must differ from CHECKR_PACKAGE — ` +
        "it would run a non-MVR check while charging for MVR.",
    );
  }
  return pkg;
}
