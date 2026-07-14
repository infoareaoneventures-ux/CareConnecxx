/**
 * Branded redirect pages for texted money-moment links.
 *
 * Evia texts families a Stripe Identity link (identity check) and a Stripe
 * Checkout link (membership). Raw verify.stripe.com / checkout.stripe.com
 * URLs unfurl with Stripe's generic card — a third-party brand at the exact
 * moment we're asking for trust. The hosting config rewrites /verify/** and
 * /pay/** to this function, which serves a tiny standalone HTML page with:
 *   - Evia OG tags → the texted link renders as a branded card
 *     ("Quick identity check — Evia") in iMessage/RCS;
 *   - an instant meta-refresh + JS redirect → a human tap lands on Stripe
 *     with no visible interstitial (plus a manual "Continue" link fallback).
 *
 * The {id} path segment keys a link_redirects doc holding the real Stripe URL
 * (written by utils/linkRedirects.createBrandedLink at send time). Unknown or
 * malformed ids bounce to /start — never an error page.
 */
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getAppUrl } from "./config/appUrl";

const db = admin.firestore();

const CARD_META: Record<string, { title: string; description: string }> = {
  verify: {
    title:       "Quick identity check — Evia",
    description: "A 30-second identity check keeps every family and caregiver on Evia real and safe. Tap to continue securely.",
  },
  pay: {
    title:       "Start your Evia membership",
    description: "Activate your membership so Evia can start coordinating care — scheduling, updates, and your care team in one place.",
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Exported for unit tests. */
export function buildRedirectHtml(
  meta: { title: string; description: string; image: string; pageUrl: string },
  targetUrl: string,
): string {
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const u = escapeHtml(targetUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t}</title>
  <meta name="robots" content="noindex" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:image" content="${escapeHtml(meta.image)}" />
  <meta property="og:url" content="${escapeHtml(meta.pageUrl)}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary" />
  <meta http-equiv="refresh" content="0;url=${u}" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; flex-direction: column; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f8fafc; color: #0f172a; text-align: center; padding: 24px; }
    .logo { width: 56px; height: 56px; border-radius: 16px; margin-bottom: 16px; }
    a { color: #4f46e5; font-weight: 600; }
  </style>
</head>
<body>
  <img class="logo" src="${escapeHtml(meta.image)}" alt="Evia" />
  <p>${d}</p>
  <p><a href="${u}">Continue&nbsp;→</a></p>
  <script>window.location.replace(${JSON.stringify(targetUrl)});</script>
</body>
</html>`;
}

export const linkRedirect = functions.runWith({}).https.onRequest(async (req, res) => {
  const appUrl = getAppUrl();
  const m = req.path.match(/^\/(verify|pay)\/([A-Za-z0-9_-]{8,})$/);
  if (!m) {
    res.redirect(302, appUrl);
    return;
  }
  const [, kind, id] = m;

  let url = "";
  try {
    const snap = await db.collection("link_redirects").doc(id).get();
    url = ((snap.data()?.url as string) ?? "").trim();
  } catch (err) {
    console.error("linkRedirect: lookup failed:", (err as Error)?.message);
  }
  if (!/^https:\/\//i.test(url)) {
    // Unknown/expired id — land them somewhere useful, never a dead page.
    res.redirect(302, `${appUrl}/start`);
    return;
  }

  const meta = CARD_META[kind];
  const html = buildRedirectHtml(
    {
      ...meta,
      image:   `${appUrl}/icon-512.png`,
      pageUrl: `${appUrl}${req.path}`,
    },
    url,
  );
  // Never cache: the underlying Stripe link is re-minted on re-sends and a
  // stale cached redirect would point at an expired session.
  res.set("Cache-Control", "no-store");
  res.status(200).type("text/html; charset=utf-8").send(html);
});
