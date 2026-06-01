"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractLocationPart = extractLocationPart;
exports.reverseGeocode = reverseGeocode;
const axios_1 = __importDefault(require("axios"));
function isValidCoord(lat, lng) {
    return (typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
        typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180);
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
function parseCoordsFromUrl(url) {
    if (!url)
        return null;
    const u = url.trim();
    // geo:LAT,LNG (optionally with ?q= or ;params)
    const geo = u.match(/geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
    if (geo) {
        const lat = parseFloat(geo[1]);
        const lng = parseFloat(geo[2]);
        if (isValidCoord(lat, lng))
            return { lat, lng };
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
            const lat = parseFloat(m[1]);
            const lng = parseFloat(m[2]);
            if (isValidCoord(lat, lng))
                return { lat, lng };
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
function extractLocationPart(parts) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
    for (const p of parts !== null && parts !== void 0 ? parts : []) {
        const type = String((_a = p === null || p === void 0 ? void 0 : p.type) !== null && _a !== void 0 ? _a : "").toLowerCase();
        // 1) Structured location part (top-level or nested)
        const nested = ((_b = p === null || p === void 0 ? void 0 : p.location) !== null && _b !== void 0 ? _b : {});
        const lat = (_e = (_d = (_c = p === null || p === void 0 ? void 0 : p.latitude) !== null && _c !== void 0 ? _c : p === null || p === void 0 ? void 0 : p.lat) !== null && _d !== void 0 ? _d : nested === null || nested === void 0 ? void 0 : nested.latitude) !== null && _e !== void 0 ? _e : nested === null || nested === void 0 ? void 0 : nested.lat;
        const lng = (_k = (_j = (_h = (_g = (_f = p === null || p === void 0 ? void 0 : p.longitude) !== null && _f !== void 0 ? _f : p === null || p === void 0 ? void 0 : p.lng) !== null && _g !== void 0 ? _g : p === null || p === void 0 ? void 0 : p.lon) !== null && _h !== void 0 ? _h : nested === null || nested === void 0 ? void 0 : nested.longitude) !== null && _j !== void 0 ? _j : nested === null || nested === void 0 ? void 0 : nested.lng) !== null && _k !== void 0 ? _k : nested === null || nested === void 0 ? void 0 : nested.lon;
        const isLocationType = type === "location" || type === "location_share" || type === "geo";
        if ((isLocationType || (lat != null && lng != null)) && isValidCoord(lat, lng)) {
            const label = (_o = (_m = (_l = p === null || p === void 0 ? void 0 : p.name) !== null && _l !== void 0 ? _l : p === null || p === void 0 ? void 0 : p.title) !== null && _m !== void 0 ? _m : nested === null || nested === void 0 ? void 0 : nested.name) !== null && _o !== void 0 ? _o : nested === null || nested === void 0 ? void 0 : nested.title;
            return { lat: lat, lng: lng, label };
        }
        // 2) Map-link part — parse coords out of the URL/value
        const urlish = (_r = (_q = (_p = p === null || p === void 0 ? void 0 : p.url) !== null && _p !== void 0 ? _p : p === null || p === void 0 ? void 0 : p.value) !== null && _q !== void 0 ? _q : p === null || p === void 0 ? void 0 : p.link) !== null && _r !== void 0 ? _r : nested === null || nested === void 0 ? void 0 : nested.url;
        if (urlish) {
            const fromUrl = parseCoordsFromUrl(urlish);
            if (fromUrl)
                return fromUrl;
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
async function reverseGeocode(lat, lng) {
    var _a, _b, _c, _d;
    if (!isValidCoord(lat, lng))
        return null;
    try {
        const resp = await axios_1.default.get("https://api.bigdatacloud.net/data/reverse-geocode-client", {
            params: { latitude: lat, longitude: lng, localityLanguage: "en" },
            timeout: 5000,
        });
        const d = (_a = resp.data) !== null && _a !== void 0 ? _a : {};
        const city = d.city || d.locality ||
            ((_d = (_c = (_b = d.localityInfo) === null || _b === void 0 ? void 0 : _b.administrative) === null || _c === void 0 ? void 0 : _c[3]) === null || _d === void 0 ? void 0 : _d.name) || "";
        const zipCode = d.postcode || "";
        const region = d.principalSubdivision || undefined;
        if (!city && !zipCode)
            return null;
        return { city, zipCode, region };
    }
    catch (_e) {
        // Non-critical — we still have raw coordinates for haversine matching.
        return null;
    }
}
//# sourceMappingURL=locationShare.js.map