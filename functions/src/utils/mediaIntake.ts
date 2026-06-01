/**
 * Inbound image / document support.
 *
 * Caregivers (and clients) on iMessage/RCS naturally snap a photo of their CNA
 * card or take a headshot and text it straight into the thread — far easier than
 * leaving the conversation for a web upload link. Linq delivers those as non-text
 * parts on the inbound webhook. Until now Cara read ONLY `type:"text"` parts and
 * dropped everything else into a generic "Got your message!" reply, which broke
 * the natural flow at exactly the photo/document onboarding steps.
 *
 * This module mirrors voiceTranscription.ts / locationShare.ts:
 *
 *   1. Detects an image or document part (tolerant of several shapes — Linq's
 *      inbound media schema isn't strictly documented).
 *   2. Downloads the bytes (direct signed URL, falling back to authenticated
 *      fetch, or resolving an attachment_id via the Attachments API).
 *   3. Stores the file in Firebase Storage on the SAME paths the web upload page
 *      uses (`profile_photos/…`, `caregiver_docs/…`) and returns a long-lived
 *      read URL, so the rest of Cara treats a texted photo identically to a
 *      web-uploaded one.
 *
 * Audio (voice memos), location pins, stickers, and plain text are deliberately
 * NOT matched here — each has its own dedicated path in the webhook.
 */

import axios from "axios";
import * as admin from "firebase-admin";

export type InboundMediaKind = "image" | "document";

export interface InboundMediaPart {
  kind:          InboundMediaKind;
  url?:          string;
  attachment_id?: string;
  content_type?: string;
  filename?:     string;
}

const IMAGE_EXT = ["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tiff", "bmp"];
const DOC_EXT   = ["pdf", "doc", "docx", "txt", "rtf", "csv"];

function extOf(filename?: string): string {
  if (!filename) return "";
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
  return m ? m[1] : "";
}

function isImageContentType(ct: string): boolean {
  return ct.startsWith("image/");
}

function isDocContentType(ct: string): boolean {
  return (
    ct === "application/pdf" ||
    ct.startsWith("application/msword") ||
    ct.includes("officedocument") ||
    ct === "text/plain" ||
    ct === "text/rtf" ||
    ct === "application/rtf" ||
    ct === "text/csv"
  );
}

/**
 * Pull the first image / document part out of an inbound webhook's parts array.
 * Returns null if none found.
 *
 * Tolerant of several shapes since Linq's inbound media field names aren't tightly
 * specified:
 *   - `type: "image" | "photo"` or `type: "media"` with an image content_type / ext
 *   - `type: "document" | "file"` or `type: "media"` with a document content_type / ext
 *   - url under `url` / `media_url` / nested `attachment.url`, or an `attachment_id`
 *
 * Audio parts, location parts, stickers, and bare text are skipped — they have
 * their own handlers (voiceTranscription, locationShare, the sticker fast-reply).
 */
export function extractMediaPart(
  parts: Array<Record<string, unknown>>
): InboundMediaPart | null {
  for (const p of parts ?? []) {
    const type = String(p?.type ?? "").toLowerCase();

    // Never claim parts owned by another handler.
    if (type === "text" || type === "sticker" || type === "location" ||
        type === "location_share" || type === "geo" || type === "voice_memo" ||
        type === "voicememo" || type === "audio") continue;

    const nested = (p?.attachment ?? p?.media ?? {}) as Record<string, unknown>;
    const contentType = String(
      p?.content_type ?? p?.mime_type ?? nested?.content_type ?? nested?.mime_type ?? ""
    ).toLowerCase();
    const filename =
      (p?.filename as string | undefined) ??
      (p?.name     as string | undefined) ??
      (nested?.filename as string | undefined);
    const ext = extOf(filename) || extOf(p?.url as string | undefined);

    // Audio that slipped through as type:"media" — leave it for the voice path.
    if (contentType.startsWith("audio/")) continue;

    const isImage =
      type === "image" || type === "photo" ||
      isImageContentType(contentType) || IMAGE_EXT.includes(ext);
    const isDocument =
      type === "document" || type === "file" ||
      isDocContentType(contentType) || DOC_EXT.includes(ext);

    if (!isImage && !isDocument) continue;

    const url =
      (p?.url        as string | undefined) ??
      (p?.media_url  as string | undefined) ??
      (nested?.url   as string | undefined);
    const attachment_id =
      (p?.attachment_id as string | undefined) ??
      (nested?.id       as string | undefined);

    if (!url && !attachment_id) continue;

    return {
      kind:          isImage ? "image" : "document",
      url,
      attachment_id,
      content_type:  contentType || undefined,
      filename,
    };
  }
  return null;
}

export interface DownloadedMedia {
  buffer:       Buffer;
  content_type: string;
  ext:          string;
}

/**
 * Resolve a downloadable URL and fetch the bytes. Mirrors the voice-memo
 * download: try the signed URL directly, fall back to an authenticated fetch if
 * it's gated, and resolve an `attachment_id` via the Attachments API when no
 * direct URL was provided. Throws on any failure (callers fall back gracefully).
 */
export async function downloadMedia(part: InboundMediaPart): Promise<DownloadedMedia> {
  let downloadUrl  = part.url;
  let contentType  = part.content_type ?? "";

  if (!downloadUrl && part.attachment_id) {
    const { getAttachment } = await import("../linq/attachments");
    const attachment = await getAttachment(part.attachment_id);
    downloadUrl = attachment.url;
    contentType = contentType || attachment.content_type;
  }

  if (!downloadUrl) throw new Error("mediaIntake: no downloadable URL");

  const { buffer, headerType } = await fetchBytes(downloadUrl);
  const resolvedType = contentType || headerType ||
    (part.kind === "image" ? "image/jpeg" : "application/octet-stream");

  return {
    buffer,
    content_type: resolvedType,
    ext:          guessExt(resolvedType, part.filename),
  };
}

async function fetchBytes(url: string): Promise<{ buffer: Buffer; headerType: string }> {
  const MAX = 25 * 1024 * 1024; // 25 MB ceiling for an inbound photo/document
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType:     "arraybuffer",
      timeout:          20_000,
      maxContentLength: MAX,
    });
    return {
      buffer:     Buffer.from(res.data),
      headerType: String(res.headers?.["content-type"] ?? ""),
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const apiKey = process.env.LINQ_API_KEY ?? "";
    if ((status === 401 || status === 403) && apiKey) {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType:     "arraybuffer",
        timeout:          20_000,
        maxContentLength: MAX,
        headers:          { Authorization: `Bearer ${apiKey}` },
      });
      return {
        buffer:     Buffer.from(res.data),
        headerType: String(res.headers?.["content-type"] ?? ""),
      };
    }
    throw err;
  }
}

function guessExt(contentType: string, filename?: string): string {
  const fromName = extOf(filename);
  if (fromName) return fromName;
  const ct = contentType.toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("png"))  return "png";
  if (ct.includes("heic")) return "heic";
  if (ct.includes("heif")) return "heif";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif"))  return "gif";
  if (ct.includes("pdf"))  return "pdf";
  if (ct.includes("msword")) return "doc";
  if (ct.includes("officedocument")) return "docx";
  if (ct.includes("csv"))  return "csv";
  if (ct.includes("rtf"))  return "rtf";
  if (ct.includes("plain")) return "txt";
  return contentType.startsWith("image/") ? "jpg" : "bin";
}

/**
 * Store inbound media in Firebase Storage on the SAME path convention the web
 * upload page uses (`profile_photos/…` for headshots, `caregiver_docs/…` for
 * documents) and return a long-lived signed read URL — matching the existing
 * signed-URL pattern in invoicing.ts / voiceSummary.ts.
 */
export async function storeInboundMedia(params: {
  phone:        string;
  kind:         InboundMediaKind;
  buffer:       Buffer;
  content_type: string;
  ext:          string;
}): Promise<string> {
  const folder    = params.kind === "image" ? "profile_photos" : "caregiver_docs";
  const safePhone = params.phone.replace(/[^0-9]/g, "");
  const path      = `${folder}/${safePhone}_${Date.now()}.${params.ext}`;

  const bucket = admin.storage().bucket();
  const file   = bucket.file(path);
  await file.save(params.buffer, {
    contentType: params.content_type,
    resumable:   false,
  });

  const [url] = await file.getSignedUrl({ action: "read", expires: "01-01-2100" });
  return url;
}
