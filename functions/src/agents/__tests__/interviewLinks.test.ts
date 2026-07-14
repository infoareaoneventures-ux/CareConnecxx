import { describe, it, expect, vi, beforeEach } from "vitest";

const { spacesCreate, fileSave, getSignedUrl, opsAlert } = vi.hoisted(() => ({
  spacesCreate: vi.fn(),
  fileSave:     vi.fn(),
  getSignedUrl: vi.fn(),
  opsAlert:     vi.fn().mockResolvedValue(true),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: class { setCredentials(): void { /* noop */ } } },
    meet: vi.fn(() => ({ spaces: { create: spacesCreate } })),
  },
}));

vi.mock("firebase-admin", () => ({
  storage: () => ({
    bucket: () => ({
      name: "test-bucket",
      file: (path: string) => ({
        save: (...args: unknown[]) => fileSave(path, ...args),
        getSignedUrl,
      }),
    }),
  }),
  firestore: Object.assign(() => ({ collection: vi.fn() }), { FieldValue: {} }),
}));

vi.mock("../../observability/caraOpsAlerts", () => ({
  createCaraOpsAlert: opsAlert,
}));

import * as interviewLinks from "../interviewLinks";

const FUTURE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_CLIENT_ID     = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "csec";
  process.env.GOOGLE_REFRESH_TOKEN = "rtok";
  spacesCreate.mockResolvedValue({ data: { meetingUri: "https://meet.google.com/abc-defg-hij" } });
  fileSave.mockResolvedValue(undefined);
  getSignedUrl.mockResolvedValue(["https://storage.example/signed.ics?sig=x"]);
});

describe("generateMeetLink", () => {
  it("creates a Meet space with accessType OPEN and returns the meetingUri", async () => {
    const url = await interviewLinks.generateMeetLink();
    expect(url).toBe("https://meet.google.com/abc-defg-hij");
    expect(spacesCreate).toHaveBeenCalledWith({
      requestBody: { config: { accessType: "OPEN" } },
    });
  });

  it("throws when the Meet API returns no meetingUri", async () => {
    spacesCreate.mockResolvedValue({ data: {} });
    await expect(interviewLinks.generateMeetLink()).rejects.toThrow("no meetingUri");
  });
});

describe("generateICSFile", () => {
  it("embeds the call URL and a 30-minute alarm", () => {
    const ics = interviewLinks.generateICSFile({
      title: "Care Interview — Maria",
      startTime: "2026-07-10T14:00:00Z",
      durationMinutes: 30,
      description: "Google Meet interview — Maria",
      callUrl: "https://meet.google.com/abc-defg-hij",
      uid: "cara-iv1@cara.com",
    });
    expect(ics).toContain("URL:https://meet.google.com/abc-defg-hij");
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("UID:cara-iv1@cara.com");
    expect(ics).toContain("DTSTART:20260710T140000Z");
  });
});

describe("uploadICSToStorage", () => {
  it("uploads text/calendar and returns a signed URL, never a public one", async () => {
    const url = await interviewLinks.uploadICSToStorage("ICSDATA", "interviews/iv1.ics", Date.parse(FUTURE));
    expect(url).toBe("https://storage.example/signed.ics?sig=x");
    expect(fileSave).toHaveBeenCalledWith(
      "interviews/iv1.ics",
      Buffer.from("ICSDATA", "utf-8"),
      { metadata: { contentType: "text/calendar" } }
    );
    const [{ action, expires }] = getSignedUrl.mock.calls[0] as [{ action: string; expires: number }];
    expect(action).toBe("read");
    // Expires ~24h after interview start
    expect(expires).toBeGreaterThan(Date.parse(FUTURE));
  });
});

describe("createInterviewCallAssets", () => {
  it("returns callUrl and icsUrl on the happy path", async () => {
    const assets = await interviewLinks.createInterviewCallAssets({
      title: "Care Interview — Maria",
      startTime: FUTURE,
      durationMinutes: 30,
      interviewId: "iv1",
    });
    expect(assets.callUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(assets.icsUrl).toBe("https://storage.example/signed.ics?sig=x");
    expect(fileSave.mock.calls[0][0]).toBe("interviews/iv1.ics");
    expect(opsAlert).not.toHaveBeenCalled();
  });

  it("raises an ops alert and rethrows when Meet link generation fails", async () => {
    spacesCreate.mockRejectedValue(new Error("invalid_grant"));
    await expect(
      interviewLinks.createInterviewCallAssets({
        title: "t", startTime: FUTURE, durationMinutes: 30, interviewId: "iv2",
      })
    ).rejects.toThrow("invalid_grant");
    expect(opsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "interview_link_generation_failed", severity: "high" })
    );
  });

  it("degrades gracefully when the .ics upload fails: link ships, icsUrl empty", async () => {
    fileSave.mockRejectedValue(new Error("storage down"));
    const assets = await interviewLinks.createInterviewCallAssets({
      title: "t", startTime: FUTURE, durationMinutes: 30, interviewId: "iv3",
    });
    expect(assets.callUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(assets.icsUrl).toBe("");
    expect(opsAlert).not.toHaveBeenCalled();
  });

  it("has no FaceTime code path (R2)", () => {
    expect((interviewLinks as Record<string, unknown>).generateFaceTimeLink).toBeUndefined();
    expect((interviewLinks as Record<string, unknown>).generateCallLink).toBeUndefined();
  });
});
