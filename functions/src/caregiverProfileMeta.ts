/**
 * Per-caregiver Open Graph metadata for shared profile links.
 *
 * Evia texts caregiver profile links to families (matching gallery) and to
 * caregivers (your-profile-is-live). Linq renders each link as a rich preview
 * card on iMessage/RCS — but the preview content comes from the OG tags at the
 * URL, and the SPA's static index.html only carries the generic marketing tags.
 * This function is the hosting-rewrite target for /p/{caregiverId}: it serves
 * the REAL built index.html (fetched from hosting, cached in memory) with the
 * OG/twitter/title tags swapped for that caregiver's name, photo, rate, and
 * city — so the texted card shows a face and a name instead of the site logo.
 * Human visitors get the identical SPA payload (App.tsx routes /p/:id to
 * PublicCaregiverProfile), crawlers get the caregiver-specific tags.
 *
 * Only fields the public profile page already renders are exposed (name,
 * photo, city/state, rate, specialties) and the same profileVisibility gate
 * applies — a hidden/missing caregiver serves the untouched index.html.
 */
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { getAppUrl } from "./config/appUrl";
import { fetchWithTimeout } from "./utils/httpTimeout";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface ProfileMeta {
  title:       string;
  description: string;
  image:       string;
  url:         string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Replace the content attribute of a <meta property|name="key" ...> tag,
// tolerant of attribute order and self-closing style. Missing tags are
// appended just before </head> so a future index.html that drops a tag
// still gets the caregiver metadata.
function setMetaTag(
  html: string,
  attr: "property" | "name",
  key: string,
  value: string
): string {
  // Replacer FUNCTIONS, not replacement strings — values like "$28/hr" would
  // otherwise be mangled by String.replace's $-pattern expansion ($2 → group 2).
  const escaped = escapeHtml(value);
  const tagRe = new RegExp(
    `(<meta\\s+[^>]*${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*content=")[^"]*(")`,
    "i"
  );
  if (tagRe.test(html)) return html.replace(tagRe, (_m, p1, p2) => `${p1}${escaped}${p2}`);
  // content= before property= variant
  const tagRe2 = new RegExp(
    `(<meta\\s+content=")[^"]*("\\s+[^>]*${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")`,
    "i"
  );
  if (tagRe2.test(html)) return html.replace(tagRe2, (_m, p1, p2) => `${p1}${escaped}${p2}`);
  return html.replace(
    /<\/head>/i,
    `  <meta ${attr}="${key}" content="${escaped}" />\n  </head>`
  );
}

/** Pure tag-swap — exported for unit tests. */
export function injectProfileMeta(html: string, meta: ProfileMeta): string {
  let out = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    () => `<title>${escapeHtml(meta.title)}</title>`
  );
  out = setMetaTag(out, "property", "og:title",       meta.title);
  out = setMetaTag(out, "property", "og:description", meta.description);
  out = setMetaTag(out, "property", "og:image",       meta.image);
  out = setMetaTag(out, "property", "og:url",         meta.url);
  out = setMetaTag(out, "property", "og:type",        "profile");
  out = setMetaTag(out, "name", "twitter:title",       meta.title);
  out = setMetaTag(out, "name", "twitter:description", meta.description);
  out = setMetaTag(out, "name", "twitter:image",       meta.image);
  // Shared profile links shouldn't inherit the homepage's SEO description.
  out = setMetaTag(out, "name", "description", meta.description);
  return out;
}

/** Build the caregiver-specific meta from a caregivers/{id} doc. Exported for tests. */
export function buildProfileMeta(
  id: string,
  cg: Record<string, unknown>
): ProfileMeta {
  const appUrl = getAppUrl();
  const name = typeof cg.name === "string" && cg.name.trim() ? cg.name.trim() : "Caregiver";

  const parts: string[] = [];
  const bg = (cg.backgroundCheckStatus ?? "") as string;
  parts.push(bg === "clear" ? "Background-checked caregiver" : "Caregiver");
  const city = [cg.city, cg.state].filter((v) => typeof v === "string" && v).join(", ");
  if (city) parts[0] += ` in ${city}`;
  const rate = Number(cg.hourlyRate);
  if (Number.isFinite(rate) && rate > 0) parts.push(`$${rate}/hr`);
  const yearsExp = Number(cg.yearsExperience ?? cg.experience);
  if (Number.isFinite(yearsExp) && yearsExp > 0) {
    parts.push(`${yearsExp} ${yearsExp === 1 ? "year" : "years"} experience`);
  }
  const specialties = Array.isArray(cg.specialties)
    ? (cg.specialties as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3)
    : [];
  if (specialties.length) parts.push(specialties.join(", "));

  const photo = [cg.profilePhoto, cg.photoURL, cg.photo, cg.imageUrl]
    .find((p): p is string => typeof p === "string" && /^https?:\/\//i.test(p));

  return {
    title:       `${name} — Caregiver on Evia`,
    description: `${parts.join(" · ")}. View their profile and book on Evia.`,
    image:       photo ?? `${appUrl}/icon-512.png`,
    url:         `${appUrl}/p/${id}`,
  };
}

// The built index.html (with hashed asset paths) fetched from hosting itself.
// Cached in-module so warm instances serve without a hosting round-trip; the
// short TTL keeps the cache from pinning a stale deploy's asset hashes.
let indexCache: { html: string; fetchedAt: number } | null = null;
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getIndexHtml(): Promise<string> {
  if (indexCache && Date.now() - indexCache.fetchedAt < INDEX_CACHE_TTL_MS) {
    return indexCache.html;
  }
  // /index.html is a real static file in dist, so hosting serves it directly —
  // this never re-enters the /p/** rewrite.
  const res = await fetchWithTimeout(`${getAppUrl()}/index.html`, { method: "GET" });
  if (!res.ok) throw new Error(`index.html fetch failed: ${res.status}`);
  const html = await res.text();
  if (!html.includes("</head>")) throw new Error("index.html fetch returned unexpected content");
  indexCache = { html, fetchedAt: Date.now() };
  return html;
}

export const caregiverProfileMeta = functions.runWith({}).https.onRequest(async (req, res) => {
  // Hosting rewrite preserves the original path: /p/{caregiverId}
  const segments = req.path.split("/").filter(Boolean);
  const id = segments[0] === "p" ? segments[1] ?? "" : segments[0] ?? "";

  let html: string;
  try {
    html = await getIndexHtml();
  } catch (err) {
    console.error("caregiverProfileMeta: index.html unavailable:", (err as Error)?.message);
    // Can't build any page — hand the visitor to the SPA-served legacy route
    // (different path, so it hits the catch-all rewrite, not this function).
    res.redirect(302, `${getAppUrl()}/caregiver/${encodeURIComponent(id)}`);
    return;
  }

  try {
    if (DOC_ID_RE.test(id)) {
      const snap = await db.collection("caregivers").doc(id).get();
      const cg = snap.data();
      if (cg && cg.profileVisibility !== "hidden") {
        html = injectProfileMeta(html, buildProfileMeta(id, cg));
      }
    }
  } catch (err) {
    // Metadata is progressive enhancement — serve the plain SPA on any failure.
    console.error("caregiverProfileMeta: meta injection failed:", (err as Error)?.message);
  }

  res.set("Cache-Control", "public, max-age=300, s-maxage=600");
  res.status(200).type("text/html; charset=utf-8").send(html);
});
