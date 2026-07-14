// Branded wrappers for third-party money-moment links (Stripe Identity /
// Stripe Checkout). A raw verify.stripe.com URL unfurls as a Stripe card at the
// exact moment Evia is asking a family for trust and money — wrapping it in a
// short app-domain URL (/verify/{id}, /pay/{id}) makes the texted link render
// as an Evia card instead (OG tags served by v1-linkRedirect, which the
// hosting rewrites route these paths to; isCardSafeUrl in linq/client.ts
// whitelists both prefixes as card-safe).
//
// The mapping doc is the only place the real destination lives; the random id
// is the secret (same trust model as the raw Stripe link itself — anyone
// holding the URL can open it). Fail-open: any error returns the raw URL so a
// checkout is never blocked by the vanity layer.

import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { getAppUrl } from "../config/appUrl";

const db = admin.firestore();

export type BrandedLinkKind = "verify" | "pay";

export async function createBrandedLink(
  kind: BrandedLinkKind,
  targetUrl: string,
  phone: string,
): Promise<string> {
  try {
    // Only wrap real external https destinations — app-hosted fallbacks are
    // already branded and wrapping them would just add a hop.
    if (!/^https:\/\//i.test(targetUrl)) return targetUrl;
    const id = randomBytes(12).toString("base64url");
    await db.collection("link_redirects").doc(id).set({
      kind,
      url:       targetUrl,
      phone,
      createdAt: new Date().toISOString(),
    });
    return `${getAppUrl()}/${kind}/${id}`;
  } catch (err) {
    console.error("createBrandedLink failed — sending raw url instead:", err);
    return targetUrl;
  }
}
