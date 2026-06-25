import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// client.ts's import chain calls admin.firestore() at module load — stub it so
// the dynamic import doesn't need an initialized Firebase app.
vi.mock("firebase-admin", () => {
  const fakeColl = () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }), set: async () => {}, update: async () => {} }) });
  const firestore = Object.assign(() => ({ collection: fakeColl }), { FieldValue: { delete: () => ({}), serverTimestamp: () => ({}) } });
  return { __esModule: true, default: { firestore }, firestore };
});

// client.ts → supervisor.ts → claudeClient.ts → langsmith/wrappers/anthropic.
// That chain tries to initialize the Anthropic client (slow/hangs in tests).
// Stub supervisor with a transparent pass-through so sendMessage still works.
// NOTE: path must be relative from THIS file (__tests__/) to src/safety/, so
// two levels up: "../../safety/supervisor".
vi.mock("../../safety/supervisor", () => ({
  supervise: async (_ctx: unknown, content: string) => content,
}));

// U11 — proves the outbound seam is REAL: every message to Linq crosses the one
// chokepoint (normalizeParts in client.ts), so voice cleanup + PII redaction
// can't be bypassed by a scripted send.

describe("outbound seam — static guard", () => {
  it("only client.ts posts to Linq chat/message endpoints", () => {
    const srcDir = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "__tests__" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        if (full.endsWith(path.join("linq", "client.ts"))) continue; // the seam itself
        const txt = fs.readFileSync(full, "utf8");
        // A Linq send is an axios call against a /chats... endpoint. Flag any
        // module that constructs one directly instead of going through client.ts.
        if (/axios[\s\S]{0,40}\/chats/.test(txt)) offenders.push(path.relative(srcDir, full));
      }
    };
    walk(srcDir);
    expect(offenders, "Linq sends must go through linq/client.ts, not direct axios").toEqual([]);
  });
});

describe("outbound seam — behavioral", () => {
  const posts: Array<{ url: string; body: any }> = [];

  beforeEach(() => {
    posts.length = 0;
    process.env.LINQ_API_KEY = "test";
    process.env.LINQ_BASE_URL = "https://linq.test/v3";
    vi.resetModules();
    // Re-register the heavy-chain mocks so they survive resetModules().
    vi.doMock("firebase-admin", () => {
      const fakeColl = () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }), set: async () => {}, update: async () => {} }) });
      const firestore = Object.assign(() => ({ collection: fakeColl }), { FieldValue: { delete: () => ({}), serverTimestamp: () => ({}) } });
      return { __esModule: true, default: { firestore }, firestore };
    });
    vi.doMock("../../safety/supervisor", () => ({
      supervise: async (_ctx: unknown, content: string) => content,
    }));
  });

  it("sendMessage scrubs banned voice + PII before the bytes leave", async () => {
    vi.doMock("axios", () => {
      const post = vi.fn(async (url: string, body: any) => {
        posts.push({ url, body });
        return { data: { message_id: "m1" }, status: 200 };
      });
      const get = vi.fn(async () => ({ data: {}, status: 200 }));
      return { __esModule: true, default: { post, get }, post, get };
    });

    const { sendMessage } = await import("../client");
    // Em-dash (voice) + an SSN (PII) that must both be gone on the wire.
    await sendMessage("chat-1", "I cannot help — her SSN is 123-45-6789, rest assured.").catch(() => {});

    const sent = JSON.stringify(posts);
    expect(posts.length, "a message should have been posted").toBeGreaterThan(0);
    expect(sent).not.toContain("123-45-6789"); // PII redacted at the chokepoint
    expect(sent).not.toContain("—");            // em-dash stripped by voice cleanup
  });
});
