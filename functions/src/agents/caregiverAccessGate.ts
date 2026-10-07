// The website's caregiver gate, exactly — hooks/useCaregiverGate.tsx (2026-09-26).
//
// The site NEVER gates viewing (dashboard Nearby Jobs, the Jobs board, Details,
// profile, applications are all open before any payment). It gates ACTING, in
// this order:
//   1. membership  — membershipStatus active/trialing (or, with no status yet,
//                    membershipPaid === true)                       → "Activate membership"
//   2. background  — verified === true, or backgroundCheckStatus === "clear",
//                    or backgroundCheckComplete === true             → "Go to dashboard"
//   3. transport   — only for TRANSPORT jobs: the driving record (MVR) cleared
//                    approved AND the driving-record (MVR) check cleared
//                    (utils/transportDocs.ts hasValidTransportDocs)  → Settings
// plus `gateMembership` (membership only) for lower-stakes actions — messaging.
//
// Over SMS the "modal" is one text with the modal's own copy, followed by the
// same CTA the site offers: the membership checkout link, the background-check
// step link, or the transport-documents upload link. Read-only tools never call
// this — a caregiver who hasn't paid can still browse jobs by text, like the site.

import * as admin from "firebase-admin";
import { sendMessage } from "../linq/client";
import { appLink } from "../config/appUrl";

const db = admin.firestore();

export type CaregiverGateReason = "membership" | "background" | "transport";
export type CaregiverGateResult =
  | { ok: true; caregiver: Record<string, unknown> }
  | { ok: false; block: CaregiverGateReason; caregiver: Record<string, unknown> };

type Cg = Record<string, unknown> | null | undefined;

// useCaregiverGate.tsx:89
export function isCaregiverMembershipActive(cg: Cg): boolean {
  if (!cg) return false;
  return cg.membershipStatus === "active" || cg.membershipStatus === "trialing"
    || (!cg.membershipStatus && cg.membershipPaid === true);
}

// useCaregiverGate.tsx:90
export function isCaregiverBackgroundApproved(cg: Cg): boolean {
  if (!cg) return false;
  return cg.verified === true || cg.backgroundCheckStatus === "clear" || cg.backgroundCheckComplete === true;
}

export function caregiverOffersTransportation(cg: Cg): boolean {
  if (!cg) return false;
  const services = [
    ...((Array.isArray(cg.services) ? cg.services : []) as string[]),
    ...((Array.isArray(cg.skills)   ? cg.skills   : []) as string[]),
  ];
  return services.includes("Transportation");
}

// utils/transportDocs.ts hasValidTransportDocs: Transportation live = driving record cleared (no documents, 2026-10-06).
export function caregiverTransportDocsValid(cg: Cg): boolean {
  if (!cg) return false;
  return cg.isApprovedDriver === true;
}

// JobBoard.tsx: `job.careTypes?.includes('Transportation') || job.requirements?.includes('Driving')`
export function jobRequiresTransport(job: Record<string, unknown> | null | undefined): boolean {
  if (!job) return false;
  const careTypes = Array.isArray(job.careTypes) ? (job.careTypes as string[]) : [];
  const requirements = Array.isArray(job.requirements) ? (job.requirements as string[]) : [];
  return careTypes.includes("Transportation") || requirements.includes("Driving");
}

/**
 * useCaregiverGate.tsx:95-96 (+ gateMembership at :116). `transport` mirrors
 * gateTransport — used only when the job itself needs a driver.
 */
export function caregiverBlockReason(
  cg: Cg,
  opts: { transport?: boolean; membershipOnly?: boolean } = {},
): CaregiverGateReason | null {
  if (!isCaregiverMembershipActive(cg)) return "membership";
  if (opts.membershipOnly) return null;
  if (!isCaregiverBackgroundApproved(cg)) return "background";
  if (opts.transport && caregiverOffersTransportation(cg) && !caregiverTransportDocsValid(cg)) return "transport";
  if (opts.transport && !caregiverOffersTransportation(cg)) return "transport";
  return null;
}

export async function checkCaregiverAccess(
  caregiverId: string,
  opts: { transport?: boolean; membershipOnly?: boolean } = {},
): Promise<CaregiverGateResult> {
  const snap = await db.collection("caregivers").doc(caregiverId).get();
  const caregiver = (snap.exists ? snap.data() : undefined) ?? {};
  const block = caregiverBlockReason(caregiver, opts);
  return block ? { ok: false, block, caregiver } : { ok: true, caregiver };
}

// useCaregiverGate.tsx REASON_CONFIG — the modal's title + description, verbatim.
export function caregiverGateText(reason: CaregiverGateReason, caregiver: Record<string, unknown> = {}): string {
  switch (reason) {
    case "membership":
      return "Membership required — you need an active membership to take this action. Activate your membership to continue:";
    case "background":
      return "Background check required — your background check must be cleared before you can take this action.";
    case "transport":
      // 2026-10-06: Transportation offered + driving record cleared (no documents); one line with the site's modal + Jobs button.
      // Not offering yet → the site's button opens the Care Services editor; by text that is SERVICES (no Settings link).
      if (!caregiverOffersTransportation(caregiver)) {
        return "Set Up Transportation — this job includes driving. To apply, add Transportation to your services (reply SERVICES) and complete the driving record check, included in your membership.";
      }
      // Offering already → the site's button opens Settings › Membership & verification; Evia TEXTS that card
      // (textCaregiverGateBlock appends the driving record line) — never a link to the site (founder, 2026-10-06).
      return "Set Up Transportation — this job includes driving. To apply, offer Transportation on your profile and complete the driving record check, included in your membership.";
  }
}

// The modal, over SMS: its copy, then its CTA link (the same link the site's
// button leads to: membership checkout / the background-check step / the
// transport-documents upload page).
export async function textCaregiverGateBlock(
  phone: string,
  chatId: string,
  reason: CaregiverGateReason,
  caregiver: Record<string, unknown> = {},
): Promise<void> {
  await sendMessage(chatId, caregiverGateText(reason, caregiver));
  if (reason === "transport") {
    // Not offering yet: the text already said "reply SERVICES" — nothing more to send.
    if (!caregiverOffersTransportation(caregiver)) return;
    // Offering: the site's button opens Settings › Membership & verification — Evia texts that
    // card itself (the same words the page prints), not a link to the site (founder, 2026-10-06:
    // "people do the same thing they could've done on the site, through Evia").
    try {
      const { driverCardFor, DRIVER_CARD_TEXT, shortDate } = await import("./caregiverMembership");
      const card = driverCardFor(caregiver, caregiverTransportDocsValid(caregiver));
      const clearedOn = shortDate(caregiver.mvrClearedAt);
      const line = clearedOn && card === "approved"
        ? DRIVER_CARD_TEXT[card].replace("Driving record check cleared. ", `Driving record check cleared on ${clearedOn}. `)
        : DRIVER_CARD_TEXT[card];
      await sendMessage(chatId, `Where it stands: ${line} Reply MEMBERSHIP for your whole Membership & verification section.`);
    } catch (err) {
      console.error("caregiverAccessGate: driving record line failed", err);
      await sendMessage(chatId, "Reply MEMBERSHIP to see where your driving record stands.");
    }
    return;
  }
  try {
    const { sendOnboardingLink } = await import("./onboardingConversation");
    if (reason === "membership") {
      if ((await sendOnboardingLink(phone, "caregiver_membership")).success) return;
    } else if (reason === "background") {
      if ((await sendOnboardingLink(phone, "caregiver_background_check")).success) return;
    }
  } catch (err) {
    console.error("caregiverAccessGate: link mint failed, falling back to the site page", err);
  }
  // Membership & verification lives on Account Settings (2026-10-04): Activate and
  // Authorize have their card there (external steps = a link is the twin).
  const fallback = "/caregiver/settings";
  await sendMessage(chatId, { parts: [{ type: "link", value: appLink(fallback) }] });
}

// Flow helper: true = blocked (and the caregiver has already been texted).
export async function enforceCaregiverGate(
  phone: string,
  chatId: string,
  caregiverId: string,
  opts: { transport?: boolean; membershipOnly?: boolean } = {},
): Promise<boolean> {
  const res = await checkCaregiverAccess(caregiverId, opts);
  if (res.ok) return false;
  await textCaregiverGateBlock(phone, chatId, res.block, res.caregiver);
  return true;
}

// Tool-path helper: find the caregiver's Evia conversation so the block can be
// texted from a tool that only knows the caregiverId.
export async function findCaregiverSession(caregiverId: string, phone?: unknown): Promise<{ phone: string; chatId: string } | null> {
  if (typeof phone === "string" && phone) {
    const snap = await db.collection("agent_sessions").doc(phone).get();
    const chatId = snap.data()?.chatId as string | undefined;
    if (chatId) return { phone, chatId };
  }
  for (const field of ["caregiverId", "userId"]) {
    const q = await db.collection("agent_sessions").where(field, "==", caregiverId).limit(1).get();
    const doc = q.docs[0];
    const chatId = doc?.data()?.chatId as string | undefined;
    if (doc && chatId) return { phone: doc.id, chatId };
  }
  return null;
}
