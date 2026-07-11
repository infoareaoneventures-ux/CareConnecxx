/**
 * Wire-level tests for the Checkr Candidate MCP client: OAuth token exchange +
 * caching, the initialize handshake (Mcp-Session-Id capture), tools/call
 * result extraction for both plain-JSON and SSE response bodies, and the
 * session-expired (404) signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initializeCheckrSession,
  callCheckrTool,
  isCheckrMcpConfigured,
  resetCheckrMcpCachesForTests,
  CheckrMcpError,
} from "../checkrMcpClient";

const TOKEN_URL  = "https://oauth.checkr-staging.com/oauth/token";
const SERVER_URL = "https://mcp.checkr-staging.com/candidate-mcp/";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status:  init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function sseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
  const body = events.map(e => `event: message\ndata: ${JSON.stringify(e)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

const tokenResponse = () => jsonResponse({ access_token: "tok-1", expires_in: 3600 });

describe("checkrMcpClient", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetCheckrMcpCachesForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.CHECKR_MCP_CLIENT_ID     = "cid";
    process.env.CHECKR_MCP_CLIENT_SECRET = "csecret";
    process.env.CHECKR_MCP_TOKEN_URL     = TOKEN_URL;
    process.env.CHECKR_MCP_SERVER_URL    = SERVER_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CHECKR_MCP_CLIENT_ID;
    delete process.env.CHECKR_MCP_CLIENT_SECRET;
    delete process.env.CHECKR_MCP_TOKEN_URL;
    delete process.env.CHECKR_MCP_SERVER_URL;
  });

  it("isCheckrMcpConfigured requires id, secret, and token url (empty string = unconfigured)", () => {
    expect(isCheckrMcpConfigured()).toBe(true);
    process.env.CHECKR_MCP_CLIENT_SECRET = "   ";
    expect(isCheckrMcpConfigured()).toBe(false);
  });

  it("initialize exchanges the token, sends the handshake, and captures Mcp-Session-Id", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
        { headers: { "mcp-session-id": "sess-abc" } },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 202 })); // notifications/initialized

    const sessionId = await initializeCheckrSession();
    expect(sessionId).toBe("sess-abc");

    // token exchange was form-encoded client_credentials with candidate:read
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe(TOKEN_URL);
    expect(String(tokenInit.body)).toContain("grant_type=client_credentials");
    expect(String(tokenInit.body)).toContain("scope=candidate%3Aread");

    // initialize carried the bearer token; the follow-up notification carried the session id
    const [, initInit] = fetchMock.mock.calls[1];
    expect(initInit.headers["Authorization"]).toBe("Bearer tok-1");
    expect(JSON.parse(initInit.body).method).toBe("initialize");
    const [, notifInit] = fetchMock.mock.calls[2];
    expect(notifInit.headers["Mcp-Session-Id"]).toBe("sess-abc");
    expect(JSON.parse(notifInit.body).method).toBe("notifications/initialized");
  });

  it("caches the access token across calls", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }));

    await callCheckrTool("sess-abc", "get_report", {});
    await callCheckrTool("sess-abc", "get_report", {});
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });

  it("callCheckrTool extracts text and parses JSON payloads", async () => {
    const report = { status: "complete", result: "clear" };
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(report) }] },
      }));

    const r = await callCheckrTool("sess-abc", "get_report", {});
    expect(r.isError).toBe(false);
    expect(r.data).toEqual(report);

    const [, callInit] = fetchMock.mock.calls[1];
    const rpcBody = JSON.parse(callInit.body);
    expect(rpcBody.method).toBe("tools/call");
    expect(rpcBody.params).toEqual({ name: "get_report", arguments: {} });
    expect(callInit.headers["Mcp-Session-Id"]).toBe("sess-abc");
  });

  it("parses SSE (text/event-stream) response bodies", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(sseResponse([
        { jsonrpc: "2.0", method: "notifications/progress", params: {} }, // ignored
        { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "code sent" }], isError: false } },
      ]));

    const r = await callCheckrTool("sess-abc", "request_candidate_verification", { email: "cg@example.com" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("code sent");
  });

  it("surfaces tool-level errors via isError without throwing", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        jsonrpc: "2.0", id: 1,
        result: { isError: true, content: [{ type: "text", text: "Invalid code. 2 attempts remaining." }] },
      }));

    const r = await callCheckrTool("sess-abc", "verify_candidate_otp", { email: "cg@example.com", code: "000000" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invalid code");
  });

  it("marks a 404 on an existing session as sessionExpired", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("session not found", { status: 404 }));

    await expect(callCheckrTool("sess-old", "get_report", {})).rejects.toSatisfy(
      (e: unknown) => e instanceof CheckrMcpError && e.sessionExpired,
    );
  });

  it("throws when credentials are not configured", async () => {
    delete process.env.CHECKR_MCP_CLIENT_ID;
    await expect(initializeCheckrSession()).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
