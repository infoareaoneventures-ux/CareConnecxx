/**
 * Inbound image / document support.
 *
 * Caregivers (and clients) on iMessage/RCS naturally snap a photo of their CNA
 * card or take a headshot and text it straight into the thread — far easier than
 * leaving the conversation for a web upload link. Linq delivers those as non-text
 * parts on the inbound webhook. Until now Evia read ONLY `type:"text"` parts and
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
 *      uses (`profile_photos/…`, `caregiver_docs/…`) and returns a bounded
 *      signed read URL, so the rest of Evia treats a texted photo identically to a
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

// ── SSRF guard ───────────────────────────────────────────────────────────────
// part.url comes from the inbound webhook payload, which is attacker-influenced.
// Without a host allowlist, fetchBytes is an SSRF primitive (it would happily GET
// http://169.254.169.254/… metadata or internal services). We only fetch media
// from known Linq/attachment/storage CDNs over https, and never from raw IPs.
const DEFAULT_MEDIA_HOSTS = [
  "linqapp.com", "amazonaws.com", "googleapis.com",
  "twilio.com", "twiliocdn.com", "cloudfront.net",
];

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** True only for https URLs on an allowlisted media host (suffix match). */
export function isSafeMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || isIpLiteral(host)) return false;
    const envHosts = (process.env.MEDIA_ALLOWED_HOSTS ?? "")
      .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    const allowed = [...DEFAULT_MEDIA_HOSTS, ...envHosts];
    return allowed.some((suffix) => host === suffix || host.endsWith("." + suffix));
  } catch {
    return false;
  }
}

// ── Magic-byte sniffing ──────────────────────────────────────────────────────
// A filename/content_type is attacker-controlled metadata; the bytes are not.
// We sniff the leading bytes so a ".jpg" carrying an executable (or a PDF) is
// rejected before it's stored.
export type SniffedKind = "image" | "document" | "executable" | "text" | "unknown";

export function sniffBufferKind(buffer: Buffer): SniffedKind {
  if (!buffer || buffer.length < 4) return "unknown";
  const b = buffer;
  const ascii = (start: number, len: number) =>
    b.slice(start, start + len).toString("latin1");

  // Executables / shared objects — always rejected regardless of claimed kind.
  if (b[0] === 0x4d && b[1] === 0x5a) return "executable";                 // MZ (PE/EXE/DLL)
  if (b[0] === 0x7f && ascii(1, 3) === "ELF") return "executable";        // ELF
  if ((b.readUInt32BE(0) >>> 0) === 0xfeedface ||
      (b.readUInt32BE(0) >>> 0) === 0xcafebabe ||
      (b.readUInt32BE(0) >>> 0) === 0xcffaedfe) return "executable";      // Mach-O

  // Images
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";    // JPEG
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image";               // PNG
  if (ascii(0, 4) === "GIF8") return "image";                            // GIF
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image";  // WEBP
  if (ascii(0, 2) === "BM") return "image";                              // BMP
  if (ascii(0, 4) === "II\x2a\x00" || ascii(0, 4) === "MM\x00\x2a") return "image"; // TIFF
  if (ascii(4, 4) === "ftyp") return "image";                            // HEIC/HEIF (ISO-BMFF)

  // Documents
  if (ascii(0, 4) === "%PDF") return "document";                         // PDF
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07))
    return "document";                                                    // ZIP (docx/xlsx)
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)
    return "document";                                                    // OLE (legacy .doc/.xls)

  // Plausibly plain text (txt/csv/rtf) — high ratio of printable bytes.
  const sample = b.slice(0, Math.min(b.length, 512));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable++;
  }
  if (sample.length > 0 && printable / sample.length > 0.85) return "text";

  return "unknown";
}

/** Reject content whose bytes contradict the claimed kind, or are executable. */
function assertContentMatches(kind: InboundMediaKind, buffer: Buffer): void {
  const sniff = sniffBufferKind(buffer);
  if (sniff === "executable") {
    throw new Error("mediaIntake: rejected executable content");
  }
  if (kind === "image" && (sniff === "document" || sniff === "text")) {
    throw new Error(`mediaIntake: claimed image but content sniffed as ${sniff}`);
  }
  if (kind === "document" && sniff === "image") {
    throw new Error("mediaIntake: claimed document but content sniffed as image");
  }
}

/** Reject content_type/ext outside the image/document allowlist. */
function assertAllowedType(kind: InboundMediaKind, contentType: string, ext: string): void {
  const ct = (contentType ?? "").toLowerCase();
  const e  = (ext ?? "").toLowerCase();
  const ctOk = kind === "image" ? isImageContentType(ct) : isDocContentType(ct);
  const extOk = (kind === "image" ? IMAGE_EXT : DOC_EXT).includes(e);
  if (!ctOk && !extOk) {
    throw new Error(`mediaIntake: disallowed ${kind} type (content_type="${ct}", ext="${e}")`);
  }
}

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
  // SSRF guard: only fetch from allowlisted media hosts over https.
  if (!isSafeMediaUrl(url)) {
    throw new Error("mediaIntake: blocked non-allowlisted media URL (SSRF guard)");
  }
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
 * documents) and return a bounded signed read URL.
 */
export async function storeInboundMedia(params: {
  phone:        string;
  kind:         InboundMediaKind;
  buffer:       Buffer;
  content_type: string;
  ext:          string;
}): Promise<string> {
  // Validate type + bytes before persisting: a filename/content_type is
  // attacker-controlled metadata; reject disallowed types and any content whose
  // magic bytes contradict the claimed kind (or look executable).
  assertAllowedType(params.kind, params.content_type, params.ext);
  assertContentMatches(params.kind, params.buffer);

  const folder    = params.kind === "image" ? "profile_photos" : "caregiver_docs";
  const safePhone = params.phone.replace(/[^0-9]/g, "");
  const path      = `${folder}/${safePhone}_${Date.now()}.${params.ext}`;

  const bucket = admin.storage().bucket();
  const file   = bucket.file(path);
  await file.save(params.buffer, {
    contentType: params.content_type,
    resumable:   false,
  });

  const ttlDaysRaw = Number(process.env.MEDIA_SIGNED_URL_TTL_DAYS ?? "7");
  const ttlDays = Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0 && ttlDaysRaw <= 30 ? ttlDaysRaw : 7;
  const expires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const [url] = await file.getSignedUrl({ action: "read", expires });
  return url;
}
