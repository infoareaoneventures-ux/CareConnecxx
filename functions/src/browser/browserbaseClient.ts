import * as admin from "firebase-admin";
import { Browserbase } from "@browserbasehq/sdk";
import { Stagehand } from "@browserbasehq/stagehand";

const db = admin.firestore();

// ── Singleton client ──────────────────────────────────────────────────────────

let _bb: Browserbase | null = null;

export function getBrowserbase(): Browserbase {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY not set");
  if (!_bb) _bb = new Browserbase({ apiKey });
  return _bb;
}

// ── Session management ────────────────────────────────────────────────────────

export interface BrowserSession {
  sessionId: string;
  stagehand: Stagehand;
  page: ReturnType<Stagehand["context"]["pages"]>[number];
}

export async function createBrowserSession(params: {
  proxies?: boolean;
  solveCaptchas?: boolean;
}): Promise<BrowserSession> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY not set");
  if (!projectId) throw new Error("BROWSERBASE_PROJECT_ID not set");

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey,
    projectId,
    model: "claude-sonnet-4-6",
    verbose: 0,
    disablePino: true,
    browserbaseSessionCreateParams: {
      projectId,
      browserSettings: {
        solveCaptchas: params.solveCaptchas ?? true,
      },
      proxies: params.proxies ? [{ type: "browserbase" }] : undefined,
    },
  });

  await stagehand.init();

  const page = stagehand.context.pages()[0];

  return {
    sessionId: stagehand.browserbaseSessionID ?? "unknown",
    stagehand,
    page,
  };
}

export async function closeBrowserSession(session: BrowserSession): Promise<void> {
  try {
    await session.stagehand.close();
  } catch (err) {
    console.error("[closeBrowserSession] error:", err);
  }
}

// Bound a session's work with a hard wall-clock cap (H-U6). On timeout the
// session is force-closed (so it can't hang an invocation) and the work rejects
// with `browser_session_timeout` — callers surface that as a failure, never a
// silent success. Uses Promise.race + Playwright's per-op default timeout, NOT
// fetchWithTimeout (which can't attach to Stagehand act/extract over CDP).
export async function withSessionTimeout<T>(
  session: BrowserSession,
  work: () => Promise<T>,
  timeoutMs = 90_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      closeBrowserSession(session).catch(() => {});
      reject(new Error("browser_session_timeout"));
    }, timeoutMs);
  });
  try {
    (session.page as { setDefaultTimeout?: (ms: number) => void }).setDefaultTimeout?.(30_000);
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Search API ────────────────────────────────────────────────────────────────
// Fast web search — up to 25 results. Use before spinning up a browser session.

export async function searchWeb(
  query: string,
  numResults: number = 5
): Promise<Array<{ title: string; url: string; publishedDate?: string }>> {
  const bb = getBrowserbase();

  const response = await bb.search.web({
    query,
    numResults: Math.min(numResults, 25),
  } as Parameters<typeof bb.search.web>[0]);

  // SDK returns results on the response object
  const raw = (response as unknown as { results?: Array<{ title?: string; url?: string; publishedDate?: string }> }).results ?? [];

  return raw.map(r => ({
    title: r.title ?? "",
    url: r.url ?? "",
    publishedDate: r.publishedDate,
  }));
}

// ── Fetch API ─────────────────────────────────────────────────────────────────
// Lightweight page retrieval — no JS execution. Use for static content.

export async function fetchPage(
  url: string,
  useProxy: boolean = false
): Promise<{ content: string; statusCode: number }> {
  const bb = getBrowserbase();

  const response = await bb.fetchAPI.create({
    url,
    proxies: useProxy,
  } as Parameters<typeof bb.fetchAPI.create>[0]);

  const raw = response as unknown as { content?: string; statusCode?: number };

  return {
    content: raw.content ?? "",
    statusCode: raw.statusCode ?? 200,
  };
}

// ── Audit logging ─────────────────────────────────────────────────────────────

export async function logBrowserSession(params: {
  userId: string;
  phone: string;
  sessionId: string;
  action: string;
  success: boolean;
  result?: string;
  error?: string;
  durationMs?: number;
}): Promise<void> {
  try {
    await db.collection("browser_sessions").add({
      ...params,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[logBrowserSession] failed to write audit log:", err);
  }
}
