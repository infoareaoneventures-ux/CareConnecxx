// U1 — model-output guard (hallucination hardening).
//
// Pure module, no mocks. Locks in:
//   - the exact leaked incident text is rejected as a meta_response
//   - normal copy, bare "briefing"/"transcript" mentions, and "debriefing"
//     (word-boundary — the 2026-07-06 substring regression) never trip
//   - composed URLs in any shape (https://, www., bare domain) are rejected
//   - the guard never logs the message text itself

import { describe, it, expect, vi, afterEach } from "vitest";
import { guardModelOutput } from "../outputGuard";

const INCIDENT_TEXT =
  "Got it, but I need the briefing context to write this message, " +
  "who's the caregiver, what shift/client situation are we talking about...";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guardModelOutput — meta_response", () => {
  it("rejects the exact leaked incident text", () => {
    const res = guardModelOutput(INCIDENT_TEXT);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("meta_response");
  });

  it("rejects a role question combined with a briefing reference", () => {
    const res = guardModelOutput("Who is the client in this briefing?");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("meta_response");
  });

  it("passes normal delivery copy", () => {
    expect(guardModelOutput("Your check cleared — you're all set to apply for jobs!"))
      .toEqual({ ok: true });
  });

  it("does not match 'briefing' inside 'debriefing' (word boundary)", () => {
    expect(guardModelOutput("Great work today — quick debriefing session with the team at 4."))
      .toEqual({ ok: true });
  });

  it("passes a bare 'briefing' mention without the ask-for-context shape (conjunction rule)", () => {
    expect(guardModelOutput("I'll include that in tomorrow's morning briefing."))
      .toEqual({ ok: true });
  });

  it("passes a bare 'transcript' mention (credential replies are legitimate)", () => {
    expect(guardModelOutput("you can send a photo of your certificate or transcript"))
      .toEqual({ ok: true });
  });

  it("passes a non-question role mention ('Maria, who is your caregiver, will arrive')", () => {
    expect(guardModelOutput("Maria, who is your caregiver, will arrive at 2pm today."))
      .toEqual({ ok: true });
  });
});

describe("guardModelOutput — url", () => {
  it("rejects an https URL", () => {
    const res = guardModelOutput("Tap here: https://eviacares.com/pay");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("url");
  });

  it("rejects a www. URL", () => {
    const res = guardModelOutput("visit www.eviacares.com");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("url");
  });

  it("rejects a bare domain", () => {
    const res = guardModelOutput("check eviacares.com for details");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("url");
  });

  it("does not treat times or ordinary punctuation as domains", () => {
    expect(guardModelOutput("See you at 2 p.m. on Friday — it'll be great."))
      .toEqual({ ok: true });
  });
});

describe("guardModelOutput — logging and fail-open", () => {
  it("never logs the message text itself (counts/reasons only)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    guardModelOutput(INCIDENT_TEXT);
    guardModelOutput("Tap here: https://eviacares.com/pay");
    for (const call of warn.mock.calls) {
      const logged = call.map((a) => JSON.stringify(a)).join(" ");
      expect(logged).not.toContain("briefing context to write");
      expect(logged).not.toContain("eviacares.com/pay");
    }
  });

  it("passes empty text", () => {
    expect(guardModelOutput("")).toEqual({ ok: true });
  });
});
