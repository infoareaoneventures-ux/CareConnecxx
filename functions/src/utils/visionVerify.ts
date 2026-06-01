/**
 * gpt-4o vision verification for inbound photos / documents.
 *
 * When a caregiver texts a headshot or a certification, we run it through gpt-4o
 * (the user explicitly chose gpt-4o here, not the gpt-4o-mini fast path — image
 * quality/credential judgement benefits from the stronger model) to:
 *   - gate the profile photo (clear, single human face) and re-ask if it's not;
 *   - confirm a document is a legible caregiving credential and read its type/
 *     expiry;
 *   - classify any mid-conversation media so Cara can smart-route it.
 *
 * gpt-4o vision accepts IMAGES only. PDFs/Office docs are NOT sent to vision —
 * callers accept those without a visual gate. Every function FAILS OPEN: a
 * transient OpenAI error must never trap a caregiver mid-onboarding, so on any
 * error we return a permissive result and log it.
 */

import { getOpenAIClient } from "./openaiClient";

const VISION_MODEL = "gpt-4o";

/** gpt-4o vision only handles raster images — never PDFs/Office docs. */
export function isVisionSupported(contentType?: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  // HEIC/HEIF aren't reliably decoded by the vision endpoint; treat as unsupported.
  if (ct.includes("heic") || ct.includes("heif")) return false;
  return ct.startsWith("image/");
}

function dataUrl(buffer: Buffer, contentType: string): string {
  const ct = contentType.startsWith("image/") ? contentType : "image/jpeg";
  return `data:${ct};base64,${buffer.toString("base64")}`;
}

async function askVision<T>(
  systemPrompt: string,
  buffer: Buffer,
  contentType: string,
  fallback: T,
  maxTokens = 250
): Promise<T> {
  try {
    const res = await getOpenAIClient().chat.completions.create({
      model:           VISION_MODEL,
      max_tokens:      maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze the attached image and respond with the required JSON only." },
            { type: "image_url", image_url: { url: dataUrl(buffer, contentType), detail: "low" } },
          ],
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch (err) {
    console.warn("visionVerify: vision call failed, failing open", {
      err: (err as Error)?.message,
    });
    return fallback;
  }
}

export interface PhotoVerdict {
  ok:     boolean;
  reason: string;
}

/**
 * Gate a profile headshot: must be a clear, well-lit photo of a single real
 * human face. Fails open (ok:true) on any vision error.
 */
export async function verifyProfilePhoto(
  buffer: Buffer,
  contentType: string
): Promise<PhotoVerdict> {
  if (!isVisionSupported(contentType)) return { ok: true, reason: "" };
  return askVision<PhotoVerdict>(
    'You are screening a profile photo for a caregiver marketplace. Return JSON ' +
      '{"ok": boolean, "reason": string}. Set ok=true ONLY if the image is a clear, ' +
      'reasonably well-lit photo showing ONE real human person\'s face (a headshot or ' +
      'upper-body shot is fine). Set ok=false if it is blurry/dark, shows no recognizable ' +
      'face, shows multiple people, is a screenshot, a document, an object, a cartoon, or ' +
      'otherwise unsuitable as a profile picture. When ok=false, "reason" is a short, warm, ' +
      'specific note about what to fix (e.g. "a bit blurry" or "I couldn\'t see a face").',
    buffer,
    contentType,
    { ok: true, reason: "" }
  );
}

export interface DocumentVerdict {
  ok:       boolean;
  docType:  string;   // e.g. "CNA license", "CPR card", "unknown"
  expiry:   string;   // ISO-ish date if visible, else ""
  reason:   string;
}

/**
 * Confirm a texted document is a legible caregiving credential and read its type
 * / expiry. Fails open (ok:true, docType:"document") on any vision error.
 */
export async function verifyDocument(
  buffer: Buffer,
  contentType: string
): Promise<DocumentVerdict> {
  if (!isVisionSupported(contentType)) {
    return { ok: true, docType: "document", expiry: "", reason: "" };
  }
  return askVision<DocumentVerdict>(
    'You are reviewing a document a caregiver uploaded as a credential (e.g. CNA ' +
      'license, CPR/BLS card, home health aide cert, nursing license, first-aid cert). ' +
      'Return JSON {"ok": boolean, "docType": string, "expiry": string, "reason": string}. ' +
      'Set ok=true if the image is legible AND plausibly a caregiving-related certification, ' +
      'license, or ID-style credential. Set docType to a short human label (e.g. "CPR card"; ' +
      '"unknown" if unclear). Set expiry to the expiration date as YYYY-MM-DD if one is ' +
      'clearly visible, else "". Set ok=false only if it is unreadable/blurry or clearly NOT ' +
      'a credential (a random photo, a selfie, an unrelated object). When ok=false, "reason" ' +
      'is a short warm note on what to resend.',
    buffer,
    contentType,
    { ok: true, docType: "document", expiry: "", reason: "" }
  );
}

export type MediaCategory = "headshot" | "credential" | "id_document" | "receipt" | "other";

export interface MediaClassification {
  category:    MediaCategory;
  description: string;
  details:     string;
}

/**
 * Classify mid-conversation media (completed users) so Cara can smart-route it:
 * a new credential → caregiver profile, an ID → identity, a receipt → expense,
 * else hand to the QA agent with a description. Fails open to "other".
 */
export async function classifyMedia(
  buffer: Buffer,
  contentType: string
): Promise<MediaClassification> {
  if (!isVisionSupported(contentType)) {
    return { category: "other", description: "a document", details: "" };
  }
  return askVision<MediaClassification>(
    'You are triaging an image a user texted to a caregiving assistant. Return JSON ' +
      '{"category": one of "headshot"|"credential"|"id_document"|"receipt"|"other", ' +
      '"description": string, "details": string}. "headshot" = a photo of a person\'s face; ' +
      '"credential" = a caregiving certification/license (CNA, CPR, etc.); "id_document" = a ' +
      'government ID/driver\'s license/passport; "receipt" = a receipt or invoice; "other" = ' +
      'anything else. "description" is one short human sentence describing the image. "details" ' +
      'holds any useful extracted text (names, dates, amounts), else "".',
    buffer,
    contentType,
    { category: "other", description: "an image", details: "" }
  );
}
