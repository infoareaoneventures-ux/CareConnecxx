/**
 * Inbound voice-memo support.
 *
 * Users (especially older clients) often can't type easily — they tap-and-hold
 * to send an iMessage voice memo instead. Linq delivers those as a non-text
 * part on the inbound webhook. This module:
 *
 *   1. Detects a voice-memo part on the webhook payload (tolerant of several
 *      shapes — Linq's inbound schema for media isn't strictly documented).
 *   2. Resolves a downloadable URL (direct or via attachment lookup).
 *   3. Downloads the audio bytes (falling back to authenticated fetch if the
 *      URL is gated).
 *   4. Transcribes via OpenAI Whisper so the rest of Cara can treat the
 *      result as if the user had typed it.
 *
 * Whisper handles every format Linq accepts for voice memos (mp3, m4a, aac,
 * caf, wav, aiff, amr), so there is no transcoding step.
 */

import { toFile } from "openai";
import axios from "axios";
import { getOpenAIClient } from "./openaiClient";

export interface VoiceMemoPart {
  url?:           string;
  attachment_id?: string;
  content_type?:  string;
  duration_ms?:   number;
}

/**
 * Pull the first voice-memo / audio part out of an inbound webhook's parts array.
 * Returns null if none found.
 *
 * Tolerant of several shapes since the inbound payload field names for media
 * aren't tightly specified in Linq's public docs:
 *   - `type: "voice_memo"` (most likely)
 *   - `type: "audio"`
 *   - `type: "media"` with `content_type` / `mime_type` starting with "audio/"
 *   - a nested `voice_memo` object (per the outbound response schema)
 */
export function extractVoiceMemoPart(
  parts: Array<Record<string, unknown>>
): VoiceMemoPart | null {
  for (const p of parts ?? []) {
    const type = String(p?.type ?? "").toLowerCase();
    const contentType = String(p?.content_type ?? p?.mime_type ?? "");

    const isVoiceType =
      type === "voice_memo" || type === "voicememo" || type === "audio";
    const isAudioMedia = type === "media" && contentType.startsWith("audio/");
    const hasVoiceField = !!(p?.voice_memo_url || p?.voice_memo);

    if (!isVoiceType && !isAudioMedia && !hasVoiceField) continue;

    const nested = (p?.voice_memo ?? {}) as Record<string, unknown>;
    const url =
      (p?.url as string | undefined) ??
      (p?.voice_memo_url as string | undefined) ??
      (p?.media_url as string | undefined) ??
      (nested?.url as string | undefined);
    const attachment_id =
      (p?.attachment_id as string | undefined) ??
      (nested?.id as string | undefined);
    const resolvedContentType =
      contentType || (nested?.mime_type as string | undefined) || undefined;
    const duration_ms =
      (p?.duration_ms as number | undefined) ??
      (nested?.duration_ms as number | undefined);

    if (url || attachment_id) {
      return { url, attachment_id, content_type: resolvedContentType, duration_ms };
    }
  }
  return null;
}

/**
 * Download the voice memo and transcribe via Whisper. Throws on any failure;
 * callers should catch and fall back to a generic "got your message" response.
 */
export async function transcribeVoiceMemo(part: VoiceMemoPart): Promise<string> {
  let downloadUrl = part.url;

  if (!downloadUrl && part.attachment_id) {
    const { getAttachment } = await import("../linq/attachments");
    const attachment = await getAttachment(part.attachment_id);
    downloadUrl = attachment.url;
  }

  if (!downloadUrl) throw new Error("voiceTranscription: no downloadable URL");

  const buffer = await downloadAudio(downloadUrl);

  const filename = guessFilename(part.content_type);
  const file = await toFile(buffer, filename, {
    type: part.content_type || "audio/m4a",
  });

  const result = await getOpenAIClient().audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "text",
  });

  const transcript =
    typeof result === "string"
      ? result
      : ((result as unknown as { text?: string })?.text ?? "");
  return transcript.trim();
}

async function downloadAudio(url: string): Promise<Buffer> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 15_000,
      maxContentLength: 15 * 1024 * 1024,
    });
    return Buffer.from(res.data);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const apiKey = process.env.LINQ_API_KEY ?? "";
    if ((status === 401 || status === 403) && apiKey) {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 15_000,
        maxContentLength: 15 * 1024 * 1024,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return Buffer.from(res.data);
    }
    throw err;
  }
}

function guessFilename(contentType?: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3"))   return "voicememo.mp3";
  if (ct.includes("wav"))                          return "voicememo.wav";
  if (ct.includes("aac"))                          return "voicememo.aac";
  if (ct.includes("amr"))                          return "voicememo.amr";
  if (ct.includes("aiff"))                         return "voicememo.aiff";
  if (ct.includes("caf"))                          return "voicememo.caf";
  return "voicememo.m4a";
}
