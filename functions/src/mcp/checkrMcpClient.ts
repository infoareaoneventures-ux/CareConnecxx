// Checkr Candidate MCP client — the ONE place that speaks MCP to Checkr.
//
// Checkr's Candidate MCP Server (docs.checkr.com/mcp) is candidate-scoped: the
// agent verifies a candidate by emailing them a one-time code, then may pull
// that candidate's latest (PII-redacted) background-check report. Sessions are
// stateful on Checkr's side (Mcp-Session-Id header), last 1 hour, allow 3 OTP
// send/verify attempts, and lock to ONE candidate. Evia's turns run in separate
// function invocations, so the session id is persisted by the caller
// (mcp/server.ts → checkr_mcp_sessions) — this module is stateless apart from
// the cached OAuth access token.
//
// Auth: OAuth 2.0 client-credentials (CHECKR_MCP_CLIENT_ID / _SECRET exchanged
// at CHECKR_MCP_TOKEN_URL, scope candidate:read). Tokens live ~1h; cached at
// module level with a 60s safety margin.
//
// Kept dependency-light (raw JSON-RPC over fetchWithTimeout, same idiom as
// checkrApi.ts) — the @modelcontextprotocol/sdk Client assumes one in-memory
// long-lived session, which doesn't fit the per-invocation Functions model.

import { fetchWithTimeout } from "../utils/httpTimeout";

export class CheckrMcpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** true when Checkr no longer knows the Mcp-Session-Id (expired/evicted) —
     *  the caller must restart verification, not retry. */
    public readonly sessionExpired = false,
  ) {
    super(message);
    this.name = "CheckrMcpError";
  }
}

// 2025-03-26 revision: the MCP-Protocol-Version header is optional (assumed
// when absent), so a persisted session survives across invocations without us
// having to store the negotiated version alongside it.
const PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_SERVER_URL = "https://mcp.checkr.com/candidate-mcp/";
const CALL_TIMEOUT_MS = 20_000;

function serverUrl(): string {
  return (process.env.CHECKR_MCP_SERVER_URL || DEFAULT_SERVER_URL).trim();
}

export function isCheckrMcpConfigured(): boolean {
  return !!(
    (process.env.CHECKR_MCP_CLIENT_ID || "").trim() &&
    (process.env.CHECKR_MCP_CLIENT_SECRET || "").trim() &&
    (process.env.CHECKR_MCP_TOKEN_URL || "").trim()
  );
}

// ── OAuth client-credentials token (module-cached) ───────────────────────────

let _token: { value: string; expiresAtMs: number } | null = null;

export function resetCheckrMcpCachesForTests(): void {
  _token = null;
}

async function getAccessToken(): Promise<string> {
  if (_token && _token.expiresAtMs > Date.now()) return _token.value;

  const clientId     = (process.env.CHECKR_MCP_CLIENT_ID || "").trim();
  const clientSecret = (process.env.CHECKR_MCP_CLIENT_SECRET || "").trim();
  const tokenUrl     = (process.env.CHECKR_MCP_TOKEN_URL || "").trim();
  if (!clientId || !clientSecret || !tokenUrl) {
    throw new CheckrMcpError("Checkr MCP credentials not configured.");
  }

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         "candidate:read",
  });
  const res = await fetchWithTimeout(tokenUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Checkr MCP token exchange failed: ${res.status} ${errBody.slice(0, 300)}`);
    throw new CheckrMcpError("Checkr MCP token exchange failed.", res.status);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new CheckrMcpError("Checkr MCP token response had no access_token.");
  }
  const ttlSec = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  _token = { value: json.access_token, expiresAtMs: Date.now() + (ttlSec - 60) * 1000 };
  return _token.value;
}

// ── JSON-RPC over streamable HTTP ─────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Streamable-HTTP responses come back as plain JSON or as an SSE stream —
 *  parse either and return the message answering `expectId`. */
async function parseRpcResponse(res: Response, expectId: number): Promise<JsonRpcMessage> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const raw = await res.text();
    const messages: JsonRpcMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { messages.push(JSON.parse(payload) as JsonRpcMessage); } catch { /* non-JSON keepalive */ }
    }
    const match = messages.find(m => m.id === expectId && ("result" in m || "error" in m));
    if (!match) throw new CheckrMcpError("Checkr MCP stream ended without a response.");
    return match;
  }
  return (await res.json()) as JsonRpcMessage;
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  opts: { sessionId?: string; notification?: boolean } = {},
): Promise<JsonRpcMessage & { httpSessionId?: string }> {
  const token = await getAccessToken();
  const id = opts.notification ? undefined : 1;
  const headers: Record<string, string> = {
    "Authorization":        `Bearer ${token}`,
    "Content-Type":         "application/json",
    "Accept":               "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };
  if (opts.sessionId) headers["Mcp-Session-Id"] = opts.sessionId;

  const res = await fetchWithTimeout(serverUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
  }, CALL_TIMEOUT_MS);

  if (res.status === 401) {
    _token = null; // token revoked/expired early — force re-exchange on retry
    throw new CheckrMcpError("Checkr MCP rejected the access token.", 401);
  }
  if (res.status === 404 && opts.sessionId) {
    throw new CheckrMcpError("Checkr MCP session expired.", 404, true);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Checkr MCP ${method} failed: ${res.status} ${errBody.slice(0, 300)}`);
    throw new CheckrMcpError("Checkr MCP request failed.", res.status);
  }
  if (opts.notification) return { jsonrpc: "2.0" };

  const message = await parseRpcResponse(res, id as number);
  if (message.error) {
    throw new CheckrMcpError(`Checkr MCP ${method} error: ${message.error.message}`, undefined);
  }
  return { ...message, httpSessionId: res.headers.get("mcp-session-id") ?? undefined };
}

// ── Public surface ────────────────────────────────────────────────────────────

/** Open a fresh Checkr MCP session (initialize handshake) and return its
 *  Mcp-Session-Id. The caller persists it — sessions are 1h, one candidate. */
export async function initializeCheckrSession(): Promise<string> {
  const init = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities:    {},
    clientInfo:      { name: "evia-agent", version: "1.0.0" },
  });
  const sessionId = init.httpSessionId;
  if (!sessionId) {
    throw new CheckrMcpError("Checkr MCP initialize returned no Mcp-Session-Id header.");
  }
  await rpc("notifications/initialized", {}, { sessionId, notification: true });
  return sessionId;
}

export interface CheckrToolResult {
  isError: boolean;
  /** Concatenated text content from the MCP tool result. */
  text: string;
  /** `text` parsed as JSON when it is JSON, else null. */
  data: unknown | null;
}

/** Call one of the Candidate MCP tools (request_candidate_verification,
 *  verify_candidate_otp, get_report) on an existing session. */
export async function callCheckrTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CheckrToolResult> {
  const message = await rpc("tools/call", { name, arguments: args }, { sessionId });
  const result = (message.result ?? {}) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (result.content ?? [])
    .filter(c => c?.type === "text" && typeof c.text === "string")
    .map(c => c.text as string)
    .join("\n")
    .trim();
  let data: unknown | null = null;
  if (text.startsWith("{") || text.startsWith("[")) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { isError: !!result.isError, text, data };
}
