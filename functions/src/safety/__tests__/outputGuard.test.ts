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

  it("passes a context-request shape ALONE — no briefing/transcript/role reference (pins the && conjunction)", () => {
    // A regression from `&&` to `||` in the meta_response rule would reject
    // this legitimate copy: one signal (a) with no signal (b) must pass.
    expect(guardModelOutput("I need more information before I can help with that."))
      .toEqual({ ok: true });
  });

  // Imperative-ask meta shapes ("please provide/share/let me know" + an
  // info-seeking object) count as the ask-for-context signal (a). The
  // conjunction rule is unchanged: they only block alongside a
  // briefing/transcript reference or role question.
  it("rejects an imperative ask for names/details combined with a briefing reference", () => {
    const res = guardModelOutput(
      "Please provide the caregiver's name and the shift details from the briefing so I can write this message.",
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("meta_response");
  });

  it("rejects a 'share … details' imperative combined with a transcript reference", () => {
    const res = guardModelOutput("Share the shift details from the transcript and I'll draft the text.");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("meta_response");
  });

  it("passes an ordinary imperative in real copy ('please let me know if 2pm works')", () => {
    expect(guardModelOutput("Please let me know if 2pm works for you."))
      .toEqual({ ok: true });
  });

  it("passes an imperative ask ALONE — no briefing/transcript/role reference (conjunction rule)", () => {
    expect(guardModelOutput("Please provide your name when you arrive at the front desk."))
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

  // Email addresses are not composed links — the platform email appears in
  // legitimate copy and must never trip the URL check.
  it("passes an email address (support@eviacares.com)", () => {
    expect(guardModelOutput("You can reach us at support@eviacares.com"))
      .toEqual({ ok: true });
  });

  // Short ambiguous TLDs (.me/.us/.co) require a URL-ish shape — a
  // missing-space typo like "text.me later" is prose, not a link.
  it("passes a missing-space typo with an ambiguous TLD ('text.me later today')", () => {
    expect(guardModelOutput("text.me later today"))
      .toEqual({ ok: true });
  });

  it("still rejects an ambiguous-TLD domain in a URL-ish shape (www.text.me)", () => {
    const res = guardModelOutput("check www.text.me");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("url");
  });

  it("still rejects an ambiguous-TLD domain with a path (evia.us/join)", () => {
    const res = guardModelOutput("go to evia.us/join to finish up");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("url");
  });

  it("still rejects an ambiguous-TLD domain with 2+ labels (portal.evia.me)", () => {
    const res = guardModelOutput("sign in at portal.evia.me today");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("url");
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
