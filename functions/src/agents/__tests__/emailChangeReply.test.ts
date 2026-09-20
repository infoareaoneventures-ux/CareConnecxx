import { describe, it, expect, vi } from "vitest";

// "Reply APPROVE to use this phone as your proof, or NO" after a recovery-email
// change request — the text-side twin of the site's "Text me a code" fallback.

vi.mock("firebase-admin", () => {
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => ({}), { FieldValue: { delete: () => "DEL" } }) };
  return { __esModule: true, default: stub, ...stub };
});
vi.mock("../../utils/openaiClient", () => ({ quickComplete: vi.fn(async () => "other") }));
vi.mock("../../accountRecovery", () => ({ EMAIL_CHANGE_ANCHOR_TTL_MS: 30 * 60 * 1000, maskEmail: (e: string) => e.replace(/^(.{2}).*(@.*)$/, "$1***$2") }));

import { freshEmailChangeToken, classifyEmailChangeReply, handleEmailChangeReply, type EmailChangeReplyDeps } from "../emailChangeReply";

const NOW = Date.parse("2026-09-20T22:00:00Z");
const session = (over: Record<string, unknown> = {}) => ({ pendingEmailChangeToken: "tok1", pendingEmailChangeSetAt: "2026-09-20T21:50:00Z", ...over });

function deps(over: Partial<EmailChangeReplyDeps> = {}): EmailChangeReplyDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    approve: vi.fn(async () => ({ sentTo: "new@example.com" })),
    cancel: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (_c: string, t: string) => { sent.push(t); }),
    classify: vi.fn(async () => ({ kind: "other" as const })),
    clearAnchor: vi.fn(async () => undefined),
    ...over,
  };
}

describe("freshEmailChangeToken", () => {
  it("is the token while fresh, null after 30 minutes or with no anchor", () => {
    expect(freshEmailChangeToken(session(), NOW)).toBe("tok1");
    expect(freshEmailChangeToken(session({ pendingEmailChangeSetAt: "2026-09-20T21:00:00Z" }), NOW)).toBeNull();
    expect(freshEmailChangeToken({}, NOW)).toBeNull();
  });
});

describe("classifyEmailChangeReply", () => {
  it("maps the model's one word onto approve / cancel / other", async () => {
    expect(await classifyEmailChangeReply("approve", async () => "approve")).toEqual({ kind: "approve" });
    expect(await classifyEmailChangeReply("no that wasn't me", async () => "cancel")).toEqual({ kind: "cancel" });
    expect(await classifyEmailChangeReply("what time is my visit", async () => "other")).toEqual({ kind: "other" });
    expect(await classifyEmailChangeReply("x", async () => { throw new Error("down"); })).toEqual({ kind: "other" });
  });
});

describe("handleEmailChangeReply", () => {
  it("no fresh anchor → not ours", async () => {
    const d = deps();
    expect(await handleEmailChangeReply({ phone: "+1", chatId: "c", text: "approve", session: {}, nowMs: NOW }, d)).toBe(false);
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("APPROVE from the phone on file completes the old-address step and points at the new inbox", async () => {
    const d = deps({ classify: vi.fn(async () => ({ kind: "approve" as const })) });
    expect(await handleEmailChangeReply({ phone: "+1", chatId: "c", text: "APPROVE", session: session(), nowMs: NOW }, d)).toBe(true);
    expect(d.approve).toHaveBeenCalledWith("tok1");
    expect(d.sent[0]).toContain("confirmation link to ne***@example.com");
  });

  it("NO cancels, clears the anchor, and says nothing changed", async () => {
    const d = deps({ classify: vi.fn(async () => ({ kind: "cancel" as const })) });
    expect(await handleEmailChangeReply({ phone: "+1", chatId: "c", text: "no", session: session(), nowMs: NOW }, d)).toBe(true);
    expect(d.cancel).toHaveBeenCalledWith("tok1");
    expect(d.clearAnchor).toHaveBeenCalledWith("+1");
    expect(d.sent[0]).toContain("stays exactly as it is");
  });

  it("an unrelated message while the anchor is fresh routes on as normal", async () => {
    const d = deps();
    expect(await handleEmailChangeReply({ phone: "+1", chatId: "c", text: "can you move Tuesday?", session: session(), nowMs: NOW }, d)).toBe(false);
    expect(d.sent).toHaveLength(0);
  });

  it("an expired/consumed token on APPROVE clears the anchor and asks them to start again", async () => {
    const d = deps({ classify: vi.fn(async () => ({ kind: "approve" as const })), approve: vi.fn(async () => { throw new Error("This link is invalid or has expired."); }) });
    expect(await handleEmailChangeReply({ phone: "+1", chatId: "c", text: "approve", session: session(), nowMs: NOW }, d)).toBe(true);
    expect(d.clearAnchor).toHaveBeenCalled();
    expect(d.sent[0]).toContain("expired");
  });
});
