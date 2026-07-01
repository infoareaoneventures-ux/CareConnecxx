import * as admin from "firebase-admin";
import { z } from "zod";
import { defineCaraAction } from "../actionNative/defineCaraAction";
import { runCaraAction } from "../actionNative/runCaraAction";
import type { CaraActionContext } from "../actionNative/caraActionTypes";

const db = admin.firestore();

const caregiverPreviewInputSchema = z.object({
  city: z.string().optional().default(""),
  seniorName: z.string().optional().default("your loved one"),
  careNeeds: z.array(z.string()).optional().default([]),
});

const caregiverPreviewItemSchema = z.object({
  name: z.string(),
  yearsExperience: z.string().optional(),
  strongestFit: z.string().optional(),
});

const caregiverPreviewOutputSchema = z.object({
  available: z.boolean(),
  widened: z.boolean(),
  total: z.number(),
  locationLabel: z.string(),
  needsLabel: z.string(),
  items: z.array(caregiverPreviewItemSchema),
  message: z.string(),
});

export type CaregiverPreviewInput = z.infer<typeof caregiverPreviewInputSchema>;
export type CaregiverPreviewOutput = z.infer<typeof caregiverPreviewOutputSchema>;

type RawCaregiver = Record<string, unknown>;

export const getCaregiverPreviewCaraAction = defineCaraAction({
  name: "get_caregiver_preview",
  description: "Read active caregivers and return a short curated preview for client onboarding.",
  inputSchema: caregiverPreviewInputSchema,
  outputSchema: caregiverPreviewOutputSchema,
  readOnly: true,
  modelVisible: true,
  webVisible: true,
  adminOnly: false,
  publicAllowed: false,
  allowedRoles: ["client", "admin", "system"],
  run: async input => {
    const localSnap = input.city
      ? await db
          .collection("caregivers")
          .where("status", "==", "active")
          .where("city", "==", input.city)
          .limit(5)
          .get()
      : await emptyQuerySnapshot();

    if (!localSnap.empty) {
      return buildCaregiverPreviewResult({
        caregivers: localSnap.docs.map(doc => doc.data()),
        widened: false,
        city: input.city,
        seniorName: input.seniorName,
        careNeeds: input.careNeeds,
      });
    }

    const widerSnap = await db.collection("caregivers").where("status", "==", "active").limit(5).get();
    return buildCaregiverPreviewResult({
      caregivers: widerSnap.docs.map(doc => doc.data()),
      widened: !widerSnap.empty,
      city: input.city,
      seniorName: input.seniorName,
      careNeeds: input.careNeeds,
    });
  },
});

export async function runGetCaregiverPreviewAction(
  input: unknown,
  ctx: CaraActionContext,
): Promise<CaregiverPreviewOutput> {
  return runCaraAction(getCaregiverPreviewCaraAction, input, ctx);
}

export function buildCaregiverPreviewResult(opts: {
  caregivers: RawCaregiver[];
  widened: boolean;
  city?: string;
  seniorName?: string;
  careNeeds?: string[];
}): CaregiverPreviewOutput {
  const city = (opts.city ?? "").trim();
  const seniorName = (opts.seniorName ?? "").trim() || "your loved one";
  const careNeeds = Array.isArray(opts.careNeeds) ? opts.careNeeds.filter(Boolean) : [];
  const locationLabel = city || "your area";
  const needsLabel = careNeeds.length > 0 ? careNeeds.slice(0, 2).join(" & ") : "care";
  const caregivers = opts.caregivers.slice(0, 5);
  const items = caregivers.slice(0, 3).map(toPreviewItem);

  if (caregivers.length === 0) {
    return {
      available: false,
      widened: false,
      total: 0,
      locationLabel,
      needsLabel,
      items: [],
      message:
        `I don't have caregivers available in ${locationLabel} just yet, but I've saved everything about ` +
        `${seniorName}'s care, and I'll text you the moment the right person is available. No charge until then.`,
    };
  }

  const previewText = joinCaregiverPreview(
    items.map(item =>
      `${item.name}${item.yearsExperience ? `, ${item.yearsExperience} yrs experience` : ""}` +
      `${item.strongestFit ? `, strongest fit for ${item.strongestFit}` : ""}`,
    ),
  );

  const message = opts.widened
    ? `I don't have caregivers right in ${locationLabel} yet, but I do have nearby options for ${seniorName}: ${previewText}. ` +
      "I would start with the best fit, confirm the schedule, and keep the family updated here."
    : `I found ${caregivers.length > 5 ? "6+" : caregivers.length} caregiver${caregivers.length !== 1 ? "s" : ""} near ${locationLabel} ` +
      `who can help with ${needsLabel}. ${previewText}. ` +
      "I would start with the best fit, confirm the schedule, and keep the family updated here.";

  return {
    available: true,
    widened: opts.widened,
    total: caregivers.length,
    locationLabel,
    needsLabel,
    items,
    message,
  };
}

function toPreviewItem(caregiver: RawCaregiver): z.infer<typeof caregiverPreviewItemSchema> {
  const name = stringValue(caregiver.name) || "Caregiver";
  const experience = stringValue(caregiver.yearsExperience) || stringValue(caregiver.experience);
  const strongestFit =
    firstString(caregiver.specialties) ||
    firstServiceName(caregiver.primaryServices) ||
    firstString(caregiver.skills) ||
    firstString(caregiver.services);
  return {
    name,
    ...(experience ? { yearsExperience: experience } : {}),
    ...(strongestFit ? { strongestFit } : {}),
  };
}

function joinCaregiverPreview(items: string[]): string {
  if (items.length === 0) return "I have a few options to review";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join("; ")}; and ${items[items.length - 1]}`;
}

function stringValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

function firstString(value: unknown): string {
  return Array.isArray(value) ? stringValue(value[0]) : "";
}

function firstServiceName(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const first = value[0];
  if (!first || typeof first !== "object") return "";
  return stringValue((first as Record<string, unknown>).name);
}

async function emptyQuerySnapshot(): Promise<{ empty: true; docs: []; size: 0 }> {
  return { empty: true, docs: [], size: 0 };
}
