// users/{uid} record changes → family account-event notifications.
//
// The family's dashboard tracker (Care Plan → Identity → Membership) reads the
// users record; whoever changes it (Stripe webhooks, the admin panel's Approved /
// Revoked overrides, Evia's own steps) the change lands here ONCE and the family
// hears about it once — bell + text with the way to finish by text
// (notifications/clientAccountEvents.ts). The FIRST membership activation keeps
// its own once-per-account sender (membershipNotify) — this trigger calls it so
// an admin Approved tells the family too (it used to send nothing).
import * as functions from "firebase-functions/v1";
import { clientAccountTransitions, clientMembershipActive, notifyClientAccountEvent } from "../notifications/clientAccountEvents";

type Doc = Record<string, unknown>;

export const onClientAccountChange = functions.firestore
  .document("users/{uid}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() as Doc | undefined;
    const after = change.after.data() as Doc | undefined;
    const uid = context.params.uid as string;
    if (!after || after.userType === "caregiver") return;

    // First membership activation → the existing once-per-account notice (marker-keyed,
    // so a Stripe webhook that already sent it is a no-op here, and an admin Approved
    // with no Stripe event behind it finally tells the family).
    if (!clientMembershipActive(before) && clientMembershipActive(after)) {
      const { notifyClientMembershipActivatedOnce } = await import("../membershipNotify");
      await notifyClientMembershipActivatedOnce(uid).catch((err) => console.warn(`[onClientAccountChange] first-activation notice failed for ${uid}:`, err));
    }

    const needsMembership = !clientMembershipActive(after);
    for (const kind of clientAccountTransitions(before, after)) {
      await notifyClientAccountEvent(uid, kind, { eventId: context.eventId, ctx: { needsMembership } })
        .catch((err) => console.error(`[onClientAccountChange] ${kind} failed for ${uid}:`, err));
    }
  });
