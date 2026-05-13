import * as admin from "firebase-admin";

// ── FaceTime Link ──────────────────────────────────────────────────────────────

export async function generateFaceTimeLink(): Promise<string> {
  const res = await fetch("https://facetime.apple.com/api/v1/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`FaceTime API error: ${res.status}`);
  const data = await res.json() as { url?: string };
  if (!data.url) throw new Error("FaceTime API returned no URL");
  return data.url;
}

// ── Google Meet Link ───────────────────────────────────────────────────────────

export async function generateGoogleMeetLink(params: {
  startTime: string;
  durationMinutes: number;
  title: string;
}): Promise<string> {
  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  const calendar = google.calendar({ version: "v3", auth });
  const endTime  = new Date(
    new Date(params.startTime).getTime() + params.durationMinutes * 60000
  ).toISOString();

  const event = await calendar.events.insert({
    calendarId:              "primary",
    conferenceDataVersion:   1,
    requestBody: {
      summary: params.title,
      start:   { dateTime: params.startTime },
      end:     { dateTime: endTime },
      conferenceData: {
        createRequest: { requestId: `cara-${Date.now()}` },
      },
    },
  });

  const meetUrl = event.data.conferenceData?.entryPoints?.[0]?.uri ?? "";
  if (!meetUrl) throw new Error("Google Meet link generation failed");
  return meetUrl;
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
    "PRODID:-//Cara//Care Interview//EN",
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

// ── Upload .ics to Firebase Storage ───────────────────────────────────────────

export async function uploadICSToStorage(content: string, path: string): Promise<string> {
  const bucket = admin.storage().bucket();
  const file   = bucket.file(path);
  await file.save(Buffer.from(content, "utf-8"), {
    metadata: { contentType: "text/calendar" },
  });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${path}`;
}

// ── Pick best call link (FaceTime for iMessage, Meet otherwise) ───────────────

export async function generateCallLink(params: {
  isIMessage: boolean;
  startTime: string;
  durationMinutes: number;
  title: string;
}): Promise<string> {
  if (params.isIMessage) {
    try {
      return await generateFaceTimeLink();
    } catch (err) {
      console.warn("FaceTime link failed, falling back to Google Meet:", err);
    }
  }
  return generateGoogleMeetLink({
    startTime:       params.startTime,
    durationMinutes: params.durationMinutes,
    title:           params.title,
  });
}
