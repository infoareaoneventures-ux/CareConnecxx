import * as admin from "firebase-admin";
import { sendToPhone } from "../linq/client";
import { getAppUrl } from "../config/appUrl";
import { logAudit } from "../observability/auditLog";
import { logAgentAction } from "../observability/actionLedger";

const db = admin.firestore();

export interface CreateCaregiverReferralInviteInput {
  referrerUserId: string;
  referrerPhone: string;
  referredName: string;
  referredPhone: string;
  referrerName?: string;
  source?: "cara_sms" | "web" | "mcp";
}

export interface CreateCaregiverReferralInviteResult {
  success: boolean;
  referralId: string;
  inviteUrl: string;
  deliveryStatus: "sent" | "failed";
  referredName: string;
  referredPhone: string;
  bookable: false;
  eligibilityRequired: {
    onboardingStatus: "profile_complete";
    verificationStatus: "approved";
    checkrResult: "clear";
  };
  errorReason?: string;
}

export function normalizeCaregiverReferralPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim();
}

export async function resolveCaregiverReferralName(caregiverId: string | undefined, fallbackPhone: string): Promise<string> {
  if (caregiverId) {
    const snap = await db.collection("caregivers").doc(caregiverId).get().catch(() => null);
    const name = (snap?.data()?.name ?? "") as string;
    if (name.trim()) return name.trim();
  }
  return fallbackPhone;
}

export async function createCaregiverReferralInvite(
  input: CreateCaregiverReferralInviteInput,
): Promise<CreateCaregiverReferralInviteResult> {
  const now = new Date().toISOString();
  const source = input.source ?? "cara_sms";
  const referredPhone = normalizeCaregiverReferralPhone(input.referredPhone);
  const referralRef = db.collection("referrals").doc();
  const inviteUrl = `${getAppUrl()}/start?role=caregiver&ref=${encodeURIComponent(referralRef.id)}`;
  const eligibilityRequired = {
    onboardingStatus: "profile_complete" as const,
    verificationStatus: "approved" as const,
    checkrResult: "clear" as const,
  };

  await referralRef.set({
    referrerUserId: input.referrerUserId,
    referrerRole: "caregiver",
    referredRole: "caregiver",
    referredName: input.referredName,
    referredPhone,
    source,
    status: "invited",
    inviteUrl,
    createdAt: now,
    updatedAt: now,
    checkrRequired: true,
    bookable: false,
    eligibilityRequired,
  });

  const inviteText =
    `${input.referrerName ?? input.referrerPhone} thought you might be a good fit as an Evia caregiver.\n\n` +
    `You can start here: ${inviteUrl}\n\n` +
    `Evia caregivers complete onboarding and Checkr background screening before they can accept visits. Reply STOP to opt out.`;

  try {
    await sendToPhone(referredPhone, inviteText, { preferredService: "SMS" });
    await referralRef.update({ inviteSentAt: now, deliveryStatus: "sent", updatedAt: now });
    logAudit({
      eventType: "referral_invited",
      userId: input.referrerUserId,
      phone: input.referrerPhone,
      data: {
        referralId: referralRef.id,
        referredRole: "caregiver",
        referredPhone,
        source,
        deliveryStatus: "sent",
      },
    }).catch(() => {});
    logAgentAction({
      actionType: "referral_invite",
      status: "executed",
      userId: input.referrerUserId,
      phone: input.referrerPhone,
      role: "caregiver",
      toolName: "create_caregiver_referral",
      targetCollection: "referrals",
      targetDocId: referralRef.id,
      metadata: { referredRole: "caregiver", referredPhone, source },
    }).catch(() => {});
    return {
      success: true,
      referralId: referralRef.id,
      inviteUrl,
      deliveryStatus: "sent",
      referredName: input.referredName,
      referredPhone,
      bookable: false,
      eligibilityRequired,
    };
  } catch (err) {
    const errorReason = err instanceof Error ? err.message : String(err);
    await referralRef.update({ deliveryStatus: "failed", errorReason, updatedAt: now }).catch(() => {});
    await db.collection("admin_alerts").add({
      type: "caregiver_referral_invite_failed",
      severity: "medium",
      referralId: referralRef.id,
      referrerUserId: input.referrerUserId,
      referredPhone,
      createdAt: now,
      resolved: false,
      error: errorReason,
    }).catch(() => {});
    logAgentAction({
      actionType: "referral_invite",
      status: "failed",
      userId: input.referrerUserId,
      phone: input.referrerPhone,
      role: "caregiver",
      toolName: "create_caregiver_referral",
      targetCollection: "referrals",
      targetDocId: referralRef.id,
      errorReason,
      metadata: { referredRole: "caregiver", referredPhone, source },
    }).catch(() => {});
    return {
      success: false,
      referralId: referralRef.id,
      inviteUrl,
      deliveryStatus: "failed",
      referredName: input.referredName,
      referredPhone,
      bookable: false,
      eligibilityRequired,
      errorReason,
    };
  }
}
