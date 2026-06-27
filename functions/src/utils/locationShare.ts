/**
 * Inbound location-share support.
 *
 * On iMessage (and some RCS) users can tap ➕ → Share Location and drop a pin in
 * one tap — far easier than typing an address, especially for older clients.
 * Linq delivers that pin as a non-text part on the inbound webhook. This module:
 *
 *   1. Detects a shared-location part (tolerant of several shapes — Linq's inbound
 *      schema for rich attachments isn't strictly documented, same caveat as the
 *      voice-memo handling in voiceTranscription.ts).
 *   2. Reverse-geocodes the coordinates to a city + zip so the rest of Cara —
 *      which is city/zip-centric (local-job teaser, display, proxy matcher) — keeps
 *      working unchanged, while the raw lat/lng unlocks true haversine matching.
 *
 * Plain SMS can't share location at all (carrier limitation), so a typed-address
 * fallback always remains in the onboarding handlers.
 */

import axios from "axios";

/**
 * Whether CARA can use Linq's native location-share prompt on this chat.
 *
 * The native request (`POST /chats/{id}/location/request`) works on 1:1 iMessage
 * ONLY — SMS, RCS, and group chats return HTTP 409. Gating on the session's
 * already-resolved `service` avoids an extra capability round-trip; a stale value
 * that 409s is caught by `requestLocation`'s fallback, so a wrong guess costs one
 * harmless failed call rather than a user-visible error.
 *
 * Param is intentionally structural (not the full `AgentSession`) so callers can
 * pass a raw Firestore session doc without a type import; `service === "iMessage"`
 * plus the absence of a `groupChatId` (group chats 409) is the whole gate.
 */
export function canRequestNativeLocation(
  session: { service?: string; groupChatId?: string | null } | null | undefined
): boolean {
  return session?.service === "iMessage" && !session.groupChatId;
}

export interface SharedLocation {
  lat:    number;
  lng:    number;
  /** Optional human label Linq/Apple may attach (e.g. a place name). */
  label?: string;
}

function isValidCoord(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" && Number.isFinite(lat) && lat >= -90  && lat <= 90 &&
    typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

/**
 * Pull lat/lng out of a map-link URL. iMessage often delivers a dropped pin as a
 * rich map link rather than a structured location part, so we parse the common
 * Apple/Google/geo URL shapes:
 *   - Apple:  maps.apple.com/?ll=LAT,LNG | &ll= | ?coordinate=LAT,LNG | ?sll=
 *   - Google: google.com/maps?q=LAT,LNG | /@LAT,LNG,z | ?ll=LAT,LNG
 *   - geo:    geo:LAT,LNG
 * Regex on a URL is mechanical extraction, NOT intent parsing — allowed under
 * CLAUDE.md (same justification as the URL extraction already in linq/client.ts).
 */
function parseCoordsFromUrl(url: string): SharedLocation | null {
  if (!url) return null;
  const u = url.trim();

  // geo:LAT,LNG (optionally with ?q= or ;params)
  const geo = u.match(/geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
  if (geo) {
    const lat = parseFloat(geo[1]); const lng = parseFloat(geo[2]);
    if (isValidCoord(lat, lng)) return { lat, lng };
  }

  // Query/path params that carry "LAT,LNG": ll=, q=, sll=, coordinate=, @
  const patterns = [
    /[?&](?:ll|sll|coordinate|center)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
    /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  ];
  for (const re of patterns) {
    const m = u.match(re);
    if (m) {
      const lat = parseFloat(m[1]); const lng = parseFloat(m[2]);
      if (isValidCoord(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

/**
 * Pull the first shared-location part out of an inbound webhook's parts array.
 * Returns null if none found.
 *
 * Tolerant of several shapes since Linq's inbound media field names aren't tightly
 * specified:
 *   - `type: "location" | "location_share" | "geo"` with latitude/longitude or lat/lng
 *     (top-level or nested under a `location` object)
 *   - a `link` / `url` / `rich_link` / `media` part whose URL is an Apple/Google/geo map link
 */
export function extractLocationPart(
  parts: Array<Record<string, unknown>>
): SharedLocation | null {
  for (const p of parts ?? []) {
    const type = String(p?.type ?? "").toLowerCase();

    // 1) Structured location part (top-level or nested)
    const nested = (p?.location ?? {}) as Record<string, unknown>;
    const lat =
      (p?.latitude as number | undefined) ??
      (p?.lat as number | undefined) ??
      (nested?.latitude as number | undefined) ??
      (nested?.lat as number | undefined);
    const lng =
      (p?.longitude as number | undefined) ??
      (p?.lng as number | undefined) ??
      (p?.lon as number | undefined) ??
      (nested?.longitude as number | undefined) ??
      (nested?.lng as number | undefined) ??
      (nested?.lon as number | undefined);
    const isLocationType =
      type === "location" || type === "location_share" || type === "geo";

    if ((isLocationType || (lat != null && lng != null)) && isValidCoord(lat, lng)) {
      const label =
        (p?.name as string | undefined) ??
        (p?.title as string | undefined) ??
        (nested?.name as string | undefined) ??
        (nested?.title as string | undefined);
      return { lat: lat as number, lng: lng as number, label };
    }

    // 2) Map-link part — parse coords out of the URL/value
    const urlish =
      (p?.url as string | undefined) ??
      (p?.value as string | undefined) ??
      (p?.link as string | undefined) ??
      (nested?.url as string | undefined);
    if (urlish) {
      const fromUrl = parseCoordsFromUrl(urlish);
      if (fromUrl) return fromUrl;
    }
  }
  return null;
}

/**
 * Reverse-geocode a pin to city + zip. Uses BigDataCloud's free, no-key
 * reverse-geocode endpoint (mirrors the free zippopotam.us choice in
 * buildJobPost.ts). Non-blocking: returns null on any failure, and callers still
 * keep the raw lat/lng for matching.
 */
export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ city: string; zipCode: string; region?: string } | null> {
  if (!isValidCoord(lat, lng)) return null;
  try {
    const resp = await axios.get(
      "https://api.bigdatacloud.net/data/reverse-geocode-client",
      {
        params:  { latitude: lat, longitude: lng, localityLanguage: "en" },
        timeout: 5000,
      }
    );
    const d = resp.data ?? {};
    const city =
      (d.city as string) || (d.locality as string) ||
      (d.localityInfo?.administrative?.[3]?.name as string) || "";
    const zipCode   = (d.postcode as string) || "";
    const region    = (d.principalSubdivision as string) || undefined;
    if (!city && !zipCode) return null;
    return { city, zipCode, region };
  } catch {
    // Non-critical — we still have raw coordinates for haversine matching.
    return null;
  }
}
