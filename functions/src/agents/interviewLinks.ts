import * as admin from "firebase-admin";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";

// ── Google Meet link (Meet REST API) ───────────────────────────────────────────
//
// Spaces are created with accessType OPEN so both participants can join from a
// phone browser with no Google account and no host present to admit them. The
// Calendar API offers no accessType control — its links leave accountless
// guests knocking into a hostless meeting. Requires the meetings.space.created
// OAuth scope on GOOGLE_REFRESH_TOKEN and the Meet REST API enabled on the
// GCP project.
//
// SECURITY: never log callUrl/icsUrl values — an OPEN link is joinable by
// anyone who holds it. Log interview doc IDs only.

export async function generateMeetLink(): Promise<string> {
  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  const meet = google.meet({ version: "v2", auth });
  const res  = await meet.spaces.create({
    requestBody: { config: { accessType: "OPEN" } },
  });

  const uri = res.data.meetingUri ?? "";
  if (!uri) throw new Error("Meet API returned no meetingUri");
  return uri;
}

// ── .ics Calendar File ─────────────────────────────────────────────────────────

export function generateICSFile(params: {
  title: string;
  startTime: string;
  durationMinutes: number;
  description: string;
  callUrl: string;
  uid?: string;
}): string {
  const uid   = params.uid ?? `cara-${Date.now()}@cara.com`;
  const start = toICSDate(params.startTime);
  const end   = toICSDate(
    new Date(new Date(params.startTime).getTime() + params.durationMinutes * 60000).toISOString()
  );
  const safeDesc = params.description.replace(/\n/g, "\\n");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Evia//Care Interview//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${params.title}`,
    `DESCRIPTION:${safeDesc}\\n\\nJoin: ${params.callUrl}`,
    `URL:${params.callUrl}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Interview starting in 30 minutes",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function toICSDate(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "").replace("Z", "Z");
}

// ── Upload .ics to Firebase Storage (signed URL, not public) ──────────────────
//
// The .ics body embeds the OPEN Meet link, so the object must not be
// world-readable forever (the old makePublic() left it public with no TTL).
// Signed read URL expires 24h after the interview starts — same pattern as
// invoicing.ts / mediaIntake.ts.

export async function uploadICSToStorage(
  content: string,
  path: string,
  interviewStartMs: number
): Promise<string> {
  const bucket = admin.storage().bucket();
  const file   = bucket.file(path);
  await file.save(Buffer.from(content, "utf-8"), {
    metadata: { contentType: "text/calendar" },
  });
  const expires = Math.max(interviewStartMs, Date.now()) + 24 * 60 * 60 * 1000;
  const [url] = await file.getSignedUrl({ action: "read", expires });
  return url;
}

// ── Shared interview call-asset builder ────────────────────────────────────────
//
// Single entry point for every scheduling path (SMS agent, MCP tools, the
// video_interviews link trigger). Link failure raises an ops alert before
// rethrowing (R7: never a silent link-less interview); .ics failure degrades
// gracefully — the link still ships without a calendar attachment.

export async function createInterviewCallAssets(params: {
  title: string;
  startTime: string;        // timezone-aware ISO
  durationMinutes: number;
  interviewId: string;
  icsStoragePrefix?: string; // default "interviews"
}): Promise<{ callUrl: string; icsUrl: string }> {
  let callUrl: string;
  try {
    callUrl = await generateMeetLink();
  } catch (err) {
    console.error(`Interview link generation failed for ${params.interviewId}:`, err);
    await createCaraOpsAlert({
      type:     "interview_link_generation_failed",
      severity: "high",
      source:   "interviewLinks",
      reason:   `Meet link generation failed for interview ${params.interviewId}: ${(err as Error)?.message ?? "unknown"}`,
    }).catch(() => {});
    throw err;
  }

  let icsUrl = "";
  try {
    const icsContent = generateICSFile({
      title:           params.title,
      startTime:       params.startTime,
      durationMinutes: params.durationMinutes,
      description:     `Google Meet interview — ${params.title}`,
      callUrl,
      uid:             `cara-${params.interviewId}@cara.com`,
    });
    icsUrl = await uploadICSToStorage(
      icsContent,
      `${params.icsStoragePrefix ?? "interviews"}/${params.interviewId}.ics`,
      new Date(params.startTime).getTime()
    );
  } catch (err) {
    // Degrade: link without calendar attachment. Never log the URL itself.
    console.error(`ICS generation/upload failed for ${params.interviewId}:`, err);
  }

  return { callUrl, icsUrl };
}
