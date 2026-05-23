/**
 * Linq Attachments API
 *
 * Supports two sending strategies:
 *   - Direct URL  (≤ 10 MB): embed HTTPS URL in media part — no pre-upload needed
 *   - Pre-upload  (> 10 MB, up to 100 MB): get presigned URL → PUT binary → send attachment_id
 *
 * Uploaded attachments persist until explicitly deleted (default). Ephemeral 24h auto-delete
 * is available as an account-level setting via your Linq rep — recommended for PHI content.
 */

import axios, { AxiosError } from "axios";
import * as https from "https";
import * as http from "http";

const BASE_URL = process.env.LINQ_BASE_URL ?? "https://api.linqapp.com/api/partner/v3";

function headers() {
  return {
    Authorization: `Bearer ${process.env.LINQ_API_KEY ?? ""}`,
    "Content-Type": "application/json",
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinqAttachment {
  id:           string;
  filename:     string;
  content_type: string;
  size_bytes:   number;
  url:          string;
  created_at:   string;
}

export interface PresignedUploadResult {
  attachment_id: string;
  upload_url:    string;
}

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as AxiosError)?.response?.status;
      // Retry on transient server errors and network failures (no response object = connection error)
      const isRetryable = !status || status === 429 || status === 500 || status === 503 || status === 504;
      if (isRetryable && i < attempts - 1) {
        await new Promise<void>((r) => setTimeout(r, Math.pow(2, i) * 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── Core attachment operations ────────────────────────────────────────────────

/**
 * Step 1 of pre-upload flow: request a presigned upload URL.
 * Returns the permanent attachment_id and a 15-minute-valid upload_url.
 */
export async function requestUploadUrl(params: {
  filename:     string;
  content_type: string;
  size_bytes:   number;
}): Promise<PresignedUploadResult> {
  const res = await withRetry(() =>
    axios.post(
      `${BASE_URL}/attachments`,
      params,
      { headers: headers() }
    )
  );
  return {
    attachment_id: res.data.id ?? res.data.attachment_id,
    upload_url:    res.data.upload_url,
  };
}

/**
 * Step 2 of pre-upload flow: PUT the raw binary to the presigned URL.
 * The upload_url is signed and does not require the Linq API key.
 */
export async function uploadBinary(
  uploadUrl: string,
  data:      Buffer,
  contentType: string
): Promise<void> {
  await withRetry(() =>
    axios.put(uploadUrl, data, {
      headers: {
        "Content-Type":   contentType,
        "Content-Length": String(data.length),
      },
      maxBodyLength: 110 * 1024 * 1024, // 110 MB ceiling (Linq max is 100 MB)
    })
  );
}

/**
 * Convenience: request presigned URL, fetch remote file, upload it.
 * Use when you have a publicly accessible URL but need permanent storage or >10 MB.
 */
export async function uploadFromUrl(params: {
  remoteUrl:    string;
  filename:     string;
  content_type: string;
}): Promise<{ attachment_id: string }> {
  const fileBuffer = await fetchRemoteBuffer(params.remoteUrl);

  const { attachment_id, upload_url } = await requestUploadUrl({
    filename:     params.filename,
    content_type: params.content_type,
    size_bytes:   fileBuffer.length,
  });

  await uploadBinary(upload_url, fileBuffer, params.content_type);
  return { attachment_id };
}

/**
 * Retrieve an attachment by ID (also refreshes signed CDN URL if expired).
 */
export async function getAttachment(attachmentId: string): Promise<LinqAttachment> {
  const res = await withRetry(() =>
    axios.get(`${BASE_URL}/attachments/${attachmentId}`, { headers: headers() })
  );
  return res.data as LinqAttachment;
}

/**
 * Permanently delete an attachment (irreversible).
 * Returns true on success (204), false if not found.
 */
export async function deleteAttachment(attachmentId: string): Promise<boolean> {
  try {
    await withRetry(() =>
      axios.delete(`${BASE_URL}/attachments/${attachmentId}`, { headers: headers() })
    );
    return true;
  } catch (err) {
    const status = (err as AxiosError)?.response?.status;
    if (status === 404) return false;
    throw err;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function fetchRemoteBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    protocol.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}
