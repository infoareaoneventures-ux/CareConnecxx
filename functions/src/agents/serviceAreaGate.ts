// Service-area gate side effects — Evia serves Santa Clara County only. When an
// onboarding location is out of area we politely decline, capture a waitlist lead,
// and park the session so further messages don't keep re-collecting. Applies to
// BOTH clients and caregivers.

import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { evaluateServiceArea } from "../config/serviceArea";

const db = admin.firestore();

// Terminal-ish step set when a signup is out of area. Not a collection step, so it
// never routes to the agent loop; handleOnboardingStep short-circuits it.
export const WAITLISTED_STEP = "out_of_area_waitlisted";

export type ServiceAreaVerdict = "in" | "out" | "need_zip";

/** Persist an out-of-area lead so we can reach out when we expand. */
async function recordWaitlist(args: {
  phone: string; role: "client" | "caregiver";
  city: string; zipCode: string; name?: string;
  onboardingData?: Record<string, unknown>;
}): Promise<void> {
  await db.collection("waitlist").doc(args.phone).set({
    phone:          args.phone,
    role:           args.role,
    attemptedCity:  args.city || null,
    attemptedZip:   args.zipCode || null,
    name:           args.name ?? null,
    reason:         "out_of_area_santa_clara_only",
    source:         "text",
    onboardingData: args.onboardingData ?? null,
    createdAt:      new Date().toISOString(),
  }, { merge: true }).catch((err) => console.error("recordWaitlist error:", err));
}

/**
 * Evaluate an onboarding location and, when it's out of area, run the decline +
 * waitlist side effects and return "out". Returns "in" (proceed) or "need_zip"
 * (caller should ask for a ZIP to confirm) without side effects.
 *
 * The caller MUST stop its normal advance when this returns "out".
 */
export async function gateOnboardingLocation(args: {
  phone: string; chatId: string; role: "client" | "caregiver";
  city: string; zipCode: string;
  name?: string;
  onboardingData?: Record<string, unknown>;
}): Promise<ServiceAreaVerdict> {
  const verdict = evaluateServiceArea({ city: args.city, zip: args.zipCode });
  if (verdict !== "out") return verdict;

  await recordWaitlist({
    phone: args.phone, role: args.role, city: args.city, zipCode: args.zipCode,
    name: args.name, onboardingData: args.onboardingData,
  });
  await db.collection("agent_sessions").doc(args.phone).set({
    onboardingStep: WAITLISTED_STEP,
    waitlisted:     true,
    attemptedCity:  args.city || null,
    attemptedZip:   args.zipCode || null,
  }, { merge: true }).catch((err) => console.error("gate session update error:", err));

  const where = args.city || args.zipCode || "that area";
  const hi = args.name ? ` ${args.name}` : "";
  await sendMessage(
    args.chatId,
    `Thanks so much${hi} — I want to be upfront: right now Evia only serves Santa Clara County, ` +
    `California, so I'm not able to set up care in ${where} just yet. I've added you to our ` +
    `waitlist and we'll reach out the moment we expand to your area. 💙`,
  );
  return "out";
}

/** Short, warm message for a ZIP confirmation when a city isn't recognized. */
export function askForZipMessage(): string {
  return "Got it — what's the ZIP code there? I want to make sure we cover your area before we go further.";
}

/**
 * Side effects only (waitlist + park session), NO outbound message — for the agent
 * loop, which composes its own decline reply. Call when evaluateServiceArea === "out".
 */
export async function parkOutOfArea(args: {
  phone: string; role: "client" | "caregiver";
  city: string; zipCode: string; name?: string;
  onboardingData?: Record<string, unknown>;
}): Promise<void> {
  await recordWaitlist(args);
  await db.collection("agent_sessions").doc(args.phone).set({
    onboardingStep: WAITLISTED_STEP,
    waitlisted:     true,
    attemptedCity:  args.city || null,
    attemptedZip:   args.zipCode || null,
  }, { merge: true }).catch((err) => console.error("parkOutOfArea session update error:", err));
}
