import { createHash } from "crypto";
import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import {
  OPERATOR_SCOPE_GENERAL,
  requireOperatorScope,
} from "../admin/requireOperatorScope";
import { getChildcareAppCheckConfig } from "../config/featureFlags";
import { childcareOnCall } from "./appCheckPolicy";

export const CHILDCARE_APPCHECK_PROBE_CHALLENGES =
  "childcare_appcheck_probe_challenges";

function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

function asMillis(value: unknown): number {
  if (typeof value === "string") return Date.parse(value);
  if (value && typeof value === "object" && "toMillis" in value) {
    const toMillis = (value as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === "function") {
      return Number(toMillis.call(value));
    }
  }
  return Number.NaN;
}

function normalizedOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return new URL(value).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Production-only release proof. The probe performs no domain write. Release
 * tooling seeds a short-lived challenge with the Admin SDK, invokes this
 * callable twice with the same limited-use App Check token, and records the
 * first success plus the wrapper's replay denial.
 */
export const appCheckReplayProbe = childcareOnCall(
  "appCheckReplayProbe",
  async (data, context) => {
    await requireOperatorScope(context, OPERATOR_SCOPE_GENERAL, {
      recentAuth: true,
    });

    if (!context.app) throw permissionDenied();
    const inputKeys =
      data && typeof data === "object" && !Array.isArray(data)
        ? Object.keys(data)
        : [];
    if (inputKeys.length !== 1 || inputKeys[0] !== "challengeId") {
      throw permissionDenied();
    }
    const challengeId =
      typeof data?.challengeId === "string" ? data.challengeId.trim() : "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(challengeId)) {
      throw permissionDenied();
    }

    const config = await getChildcareAppCheckConfig();
    const expectedProjectId = String(
      process.env.GCLOUD_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      "",
    ).trim();
    const tokenProjectId = String(context.auth?.token?.aud ?? "").trim();
    const origin = normalizedOrigin(context.rawRequest?.headers?.origin);
    if (
      !expectedProjectId ||
      tokenProjectId !== expectedProjectId ||
      !origin ||
      !config.verifiedDomains.includes(origin)
    ) {
      throw permissionDenied();
    }

    const snap = await admin
      .firestore()
      .collection(CHILDCARE_APPCHECK_PROBE_CHALLENGES)
      .doc(challengeId)
      .get();
    const challenge = snap.exists ? snap.data() ?? {} : {};
    const expiresAtMs = asMillis(challenge.expiresAt);
    if (
      !snap.exists ||
      challenge.active !== true ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= Date.now() ||
      String(challenge.projectId ?? "") !== expectedProjectId ||
      (
        typeof challenge.appId === "string" &&
        challenge.appId !== context.app.appId
      )
    ) {
      throw permissionDenied();
    }

    return {
      success: true,
      policy: "limited-use",
      projectId: expectedProjectId,
      appId: context.app.appId,
      challengeDigest: createHash("sha256")
        .update(`${expectedProjectId}:${challengeId}`)
        .digest("hex")
        .slice(0, 24),
      verifiedAt: new Date().toISOString(),
    };
  },
);
