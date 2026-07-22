import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";
import { gateOptionalSend } from "./engineGate";

const db = admin.firestore();

// One-nudge follow-up for the native location request.
//
// When EVIA fires Linq's native "Share Your Location" prompt (1:1 iMessage), it
// stores `pendingLocationRequest` on the session. The location comes back
// asynchronously as an inbound pin; the onboarding handlers clear the marker
// once a pin OR a typed city/zip arrives. If neither arrives, this job sends
// EXACTLY ONE gentle nudge that also offers the typed-zip path, then sets
// `nudgeSent` so it never fires again. After `stateExpiresAt` the marker is
// dropped so a stale request is never nudged.
//
// Idempotency mirrors shiftTaskNudges / clientDayBeforeReminder: the query is
// scoped to `nudgeSent == false`, and the flag is flipped BEFORE the send so a
// failed post-send write can never cause a duplicate nudge on the next run.

const NUDGE_AFTER_MS = 15 * 60 * 1000; // wait 15 min for a pin before nudging

export const sendLocationRequestNudges = functions.pubsub
  .schedule("*/15 * * * *") // every 15 minutes
  .onRun(async () => {
    const now = Date.now();

    // Sessions with an unanswered, not-yet-nudged native location request.
    // Sessions without the marker (field absent) do not match.
    const snap = await db.collection("agent_sessions")
      .where("pendingLocationRequest.nudgeSent", "==", false)
      .get();

    for (const doc of snap.docs) {
      const data    = doc.data() as Record<string, unknown>;
      const pending = data.pendingLocationRequest as
        | { sentAt?: string; nudgeSent?: boolean }
        | undefined;
      if (!pending?.sentAt) continue;
      if ((data as { optedOut?: boolean }).optedOut) continue;

      const phone     = doc.id;
      const sentAtMs  = Date.parse(pending.sentAt);
      const expiresAt = typeof data.stateExpiresAt === "string" ? Date.parse(data.stateExpiresAt) : NaN;

      // Expired window → drop the marker, never nudge.
      if (!Number.isNaN(expiresAt) && now >= expiresAt) {
        await doc.ref.update({ pendingLocationRequest: admin.firestore.FieldValue.delete() })
          .catch(() => {/* non-critical */});
        continue;
      }

      // Too soon — give the native prompt time to be answered.
      if (Number.isNaN(sentAtMs) || now - sentAtMs < NUDGE_AFTER_MS) continue;

      try {
        // U8 engine gate (KTD15): optional nudge — submit as a PolicyCandidate
        // instead of sending directly. A lost pass re-enters on the next 15-min
        // run: nudgeSent is only flipped below, after an allowed pass.
        const day = new Date(now).toISOString().slice(0, 10);
        const g = await gateOptionalSend({
          phone,
          candidate: {
            source: "locationRequestNudge",
            category: "re_engagement",
            urgency: 1,
            evidenceCount: 1,
            dedupeKey: `locnudge:${phone}:${day}`,
          },
        });
        if (!g.allowed) {
          // File policy: never log the raw phone number (doc id) — last 4 only.
          console.info("locationRequestNudge.policy", { phone: `…${phone.slice(-4)}`, disposition: g.disposition, reason: g.reason });
          continue;
        }

        const lang = (data as { preferredLanguage?: string }).preferredLanguage === "es" ? "es" : "en";
        const message = await generateCaraMessage({
          audience: "family",
          language: lang,
          context:
            `Evia asked the user to share their location a little while ago via the tap-to-share prompt, ` +
            `but hasn't received it yet. Send ONE short, friendly nudge. Make clear there are two easy ` +
            `options: tap the location prompt, OR just text their city and zip code (e.g. "Austin, TX 78701"). ` +
            `Warm and brief, not pushy.`,
          fallback: lang === "es"
            ? `¿Aún por ahí? Puedes tocar para compartir tu ubicación, o solo escríbeme tu ciudad y código postal ` +
              `(por ejemplo "Austin, TX 78701").`
            : `Still there? You can tap to share your location, or just text me your city and zip code ` +
              `(e.g. "Austin, TX 78701").`,
        });

        // Flip the flag BEFORE the send: if the update ran after a successful
        // send and failed, the next run would re-send the "exactly one" nudge.
        // A nudge is non-critical, so at-most-once beats a duplicate.
        await doc.ref.update({ "pendingLocationRequest.nudgeSent": true });

        await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "location_request_nudge",
          canDrop:     false,
        });
      } catch (err) {
        // Don't log the raw phone number (doc id) — last 4 digits only.
        const redacted = `…${phone.slice(-4)}`;
        console.error(`[sendLocationRequestNudges] Error for ${redacted}:`, err);
      }
    }
  });
