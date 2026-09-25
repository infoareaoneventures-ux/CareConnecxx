/**
 * Open Graph metadata for the token-gated onboarding pages.
 *
 * Evia texts caregivers /upload/photo, /upload/document, and /bgcheck links
 * during onboarding. Until now those URLs had to be delivered as raw inline
 * text — a giant JWT string in the message bubble — because the SPA's
 * index.html only carries the generic marketing OG tags, so a Linq `link`
 * part rendered a blank/generic preview card (see isCardSafeUrl in
 * linq/client.ts). This function is the hosting-rewrite target for /upload/**
 * and /bgcheck: it serves the real built index.html with route-specific OG
 * tags, so the texted link renders as a branded card ("Add your
 * certifications — Evia", "Authorize your background check — Evia", …)
 * instead of a wall of token.
 *
 * The tags are STATIC per route — nothing user-specific is looked up or
 * echoed, and the ?t= token is never reflected into the HTML. Human visitors
 * get the identical SPA payload (App.tsx routes /upload/* to UploadPage and
 * /bgcheck to BgcheckConsentPage).
 */
import * as functions from "firebase-functions/v1";
import { getAppUrl } from "./config/appUrl";
import { getIndexHtml, injectProfileMeta, ProfileMeta } from "./caregiverProfileMeta";

/** Route-specific card content. Exported for unit tests. */
export function buildUploadMeta(pathname: string): ProfileMeta {
  const appUrl = getAppUrl();
  if (/^\/bgcheck(\/|$)/i.test(pathname)) {
    return {
      title:       "Authorize your background check — Evia",
      description: "Review the disclosure and authorize your background check — it's already included in your membership and takes about a minute.",
      image:       `${appUrl}/icon-512.png`,
      url:         `${appUrl}/bgcheck`,
    };
  }
  const isPhoto = /^\/upload\/photo(\/|$)/i.test(pathname);
  if (isPhoto) {
    return {
      title:       "Add your profile photo — Evia",
      description: "A clear, friendly headshot helps families see who they're trusting. Tap to upload — it takes 30 seconds.",
      image:       `${appUrl}/icon-512.png`,
      url:         `${appUrl}/upload/photo`,
    };
  }
  return {
    title:       "Add your transportation documents — Evia",
    description: "Upload your driver's license, vehicle insurance, and vehicle registration. Our team reviews them after your background and driving-record checks.",
    image:       `${appUrl}/icon-512.png`,
    url:         `${appUrl}/upload/transport`,
  };
}

export const uploadPageMeta = functions.runWith({}).https.onRequest(async (req, res) => {
  let html: string;
  try {
    html = await getIndexHtml();
  } catch (err) {
    console.error("uploadPageMeta: index.html unavailable:", (err as Error)?.message);
    // Can't build the page — hand the visitor to the SPA-served alias route
    // (/upload-direct/* and /bgcheck-direct hit the catch-all rewrite, not this
    // function, so no redirect loop). The ?t= token is preserved so the page
    // still works.
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const aliasPath = req.path
      .replace(/^\/upload\//, "/upload-direct/")
      .replace(/^\/bgcheck(\/|$)/, "/bgcheck-direct$1");
    res.redirect(302, `${getAppUrl()}${aliasPath}${qs}`);
    return;
  }

  try {
    html = injectProfileMeta(html, buildUploadMeta(req.path));
    // The upload routes are onboarding-only utility pages — keep them out of
    // search results (the OG tags exist for messaging preview cards, not SEO).
    html = html.replace(
      /<\/head>/i,
      `  <meta name="robots" content="noindex" />\n  </head>`
    );
  } catch (err) {
    // Metadata is progressive enhancement — serve the plain SPA on any failure.
    console.error("uploadPageMeta: meta injection failed:", (err as Error)?.message);
  }

  res.set("Cache-Control", "public, max-age=300, s-maxage=600");
  res.status(200).type("text/html; charset=utf-8").send(html);
});
