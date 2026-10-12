import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep C12 (2026-10-11): a FIXED string (lifecycle notice, reminder,
// a page's own sentence) is the founder's words. The reviewer may block it,
// never rephrase it — and the linter never touches it either.

const hoisted = vi.hoisted(() => ({ messagesCreate: vi.fn(), addMock: vi.fn().mockResolvedValue({ id: "log-1" }) }));

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: () => ({ add: hoisted.addMock }) }) },
  firestore: () => ({ collection: () => ({ add: hoisted.addMock }) }),
}));
vi.mock("../../utils/claudeClient", () => ({ getSharedClient: () => ({ messages: { create: (...a: unknown[]) => hoisted.messagesCreate(...a) } }) }));

import { supervise, reviewFixedString } from "../supervisor";

const reply = (json: object) => hoisted.messagesCreate.mockResolvedValueOnce({ content: [{ text: JSON.stringify(json) }] });
// A sentence the linter would otherwise rewrite (em-dash → comma) and the model would "fix".
const NOTICE = "Your membership is active — next: authorize your background check. Reply MANAGE MEMBERSHIP for your Stripe billing link.";

beforeEach(() => { hoisted.messagesCreate.mockReset(); hoisted.addMock.mockClear(); });

describe("reviewFixedString", () => {
  it("no violation → may send, exactly as written (no rewrite returned, nothing logged)", async () => {
    reply({ violation: false, revised: NOTICE });
    expect(await reviewFixedString(NOTICE, { phone: "+1", role: "caregiver", fixedString: true })).toBe(true);
    expect(hoisted.addMock).not.toHaveBeenCalled();
    // The reviewer is told who the reader is.
    expect(String(hoisted.messagesCreate.mock.calls[0][0].system)).toContain("CARE PROVIDER");
  });

  it("a flagged violation BLOCKS (false) and is logged + alerted — the rewrite is never used", async () => {
    reply({ violation: true, revised: "I'm not able to confirm your membership. Please contact our care team." });
    expect(await reviewFixedString(NOTICE, { phone: "+1", role: "caregiver", fixedString: true })).toBe(false);
    const logged = hoisted.addMock.mock.calls.map((c) => c[0]);
    expect(logged.find((d) => d.action === "blocked")).toMatchObject({ original: NOTICE, revised: null, fixedString: true });
    expect(logged.find((d) => d.type === "fixed_string_blocked")).toBeTruthy();
  });

  it("a reviewer outage fails OPEN — a founder-worded notice is never lost to a model hiccup", async () => {
    hoisted.messagesCreate.mockRejectedValueOnce(new Error("haiku down"));
    expect(await reviewFixedString(NOTICE, { phone: "+1" })).toBe(true);
  });
});

describe("supervise() with the fixedString flag", () => {
  it("returns the message untouched — not even the linter's em-dash rewrite — and never calls the model", async () => {
    expect(await supervise(NOTICE, { phone: "+1", role: "caregiver", fixedString: true })).toBe(NOTICE);
    expect(hoisted.messagesCreate).not.toHaveBeenCalled();
  });
  it("model-generated text still goes through lint + the rewriting review (unchanged)", async () => {
    reply({ violation: false, revised: "hi" });
    const out = await supervise("I found two care providers — want intros?", { phone: "+1" });
    expect(out).toBe("I found two care providers, want intros?"); // the linter's em-dash rule, as before
  });
});
