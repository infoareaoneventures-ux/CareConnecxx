# Location Request + SMS/RCS Fallback — Requirements

**Date:** 2026-06-26
**Status:** Ready for planning
**Scope:** Standard (feature)

## Problem

CARA today only *receives* location — when a user taps ➕ → Share Location, Linq
delivers a pin and `extractLocationPart` → `reverseGeocode` turns it into raw
lat/lng + city/zip ([functions/src/utils/locationShare.ts](../../functions/src/utils/locationShare.ts)).
CARA never *asks* for location via Linq's native prompt; it only types
"what city and zip code are you in?" and parses the reply.

Linq exposes `POST /v3/chats/{chatId}/location/request`, which fires Apple's
native one-tap "Share Your Location" sheet — far lower friction than typing,
especially for older users. But it works on **1:1 iMessage only**; SMS, RCS, and
group chats return HTTP `409`.

We want CARA to use the native prompt where it works, and degrade cleanly
everywhere else.

## Goal

CARA actively requests location through the native iMessage prompt when the chat
supports it, and falls back to a typed city+zip ask (the existing mechanism)
otherwise. Reuse the existing inbound pin + reverse-geocode pipeline unchanged.

## Outcome / Success Criteria

- On a 1:1 iMessage chat, CARA's location ask triggers the native share sheet;
  the returned pin flows through the existing inbound handler with no new ingest
  code.
- On SMS, RCS, or iMessage group chats, CARA never calls the request endpoint
  (no `409` surfaced to the user) and asks for typed city+zip instead.
- A user who ignores the native prompt receives exactly one nudge after a delay,
  then is asked for typed city+zip.
- Matching quality is unchanged for typed-zip users — city/zip proxy buckets
  remain valid; precise coords (when present) still unlock haversine matching.

## Approach

**Native request on iMessage 1:1; typed city+zip everywhere else. No hosted GPS link.**

1. **Protocol gate.** Before requesting, check the resolved chat service
   (`LinqService = "iMessage" | "RCS" | "SMS"`, [functions/src/linq/client.ts:30](../../functions/src/linq/client.ts#L30))
   and that the chat is 1:1. Only `iMessage` + 1:1 → call the request endpoint.
2. **Request.** Call `POST /v3/chats/{chatId}/location/request`. On any non-2xx
   (incl. `409`), treat as "native unavailable" and fall to the typed ask.
3. **Consume the reply.** The user's pin arrives async as an inbound part —
   already handled by `extractLocationPart` / `reverseGeocode`. No change needed
   on the receive side.
4. **Fallback (typed city+zip).** Reuse the existing onboarding location parse
   ("what city and zip code are you in?" → LLM → `{city, zipCode}`). SMS gets zip
   only; RCS users may still manually pin (inbound path catches it).
5. **One nudge, then typed.** If no pin arrives after a delay, send one follow-up;
   if still nothing, ask for typed city+zip. Follow the existing scheduled
   send-after-delay pattern in
   [functions/src/scheduled/interviewResponseReminder.ts](../../functions/src/scheduled/interviewResponseReminder.ts).

**Where it fires:** both the onboarding location step *and* a new anytime MCP
tool CARA can call mid-conversation (e.g. "find caregivers near me", address
update). Both paths share the same gate → request → fallback logic.

### Rejected alternative — hosted GPS web link

A CareConnect-hosted page that captures browser geolocation would give precise
coords on every protocol including SMS. Rejected: a text with a link asking for
your location reads like smishing (bad for a healthcare brand's trust), it adds
real carrying cost (page + token + callback webhook + privacy surface), and it
buys precision the matching doesn't need — zip centroid is sufficient for
within-metro care matching.

## Scope Boundaries

**In scope**
- Protocol + group gate before requesting.
- Request call + `409`/error handling → fallback.
- Onboarding location step uses the gate.
- New anytime MCP tool exposing request-location to CARA.
- One scheduled nudge before typed-ask fallback.

**Out of scope**
- Hosted GPS web link or any new SMS precision mechanism.
- Changing matching to require precise coords — city/zip proxy stays valid.
- Inbound pin parsing / reverse-geocode (already built, unchanged).

## Dependencies / Assumptions

- **Assumption:** CareConnect chats are effectively 1:1 (one caregiver/client
  phone per chat); group chats are rare but the gate must still guard against
  them since the endpoint `409`s on groups.
- The resolved `service` is available per chat/session
  ([functions/src/linq/client.ts](../../functions/src/linq/client.ts)) — confirmed.
- `POST /v3/chats/{chatId}/location/request` returns `409` on SMS/RCS/group
  (per Linq docs, /api/resources/chats/subresources/location/). Exact non-2xx
  shape to be confirmed during implementation.

## Open Questions (deferred to planning)

- Nudge delay duration (minutes vs hours) — tune to onboarding drop-off data.
- Whether the anytime MCP tool should auto-fall to typed ask inline or report
  "couldn't prompt" back to CARA for it to decide phrasing.

## Handoff

Ready for `/ce-plan`. Core decisions resolved: native request on iMessage 1:1,
typed city+zip fallback elsewhere, onboarding + MCP tool entry points, one nudge
before fallback. Implementation specifics (endpoint client method, MCP tool
schema, scheduled-job wiring) are planning's job.
