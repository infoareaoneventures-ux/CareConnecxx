import * as crypto from "crypto";

export type TokenTask =
  | "payment"
  | "identity"
  | "photo_upload"
  | "doc_upload"
  | "background_check"
  | "stripe_connect"
  | "quick_confirm"
  | "interview_confirm"
  | "booking_confirm";

export interface TokenPayload {
  phone:        string;
  userId?:      string;
  caregiverId?: string;
  task:         TokenTask;
  taskId?:      string;
  exp:          number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET env var not set");
  return s;
}

export function generateToken(
  payload: Omit<TokenPayload, "exp">,
  ttlSeconds = 7200
): string {
  const full: TokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body   = b64url(Buffer.from(JSON.stringify(full)));
  const sig    = b64url(crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = b64url(crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest());
    if (sig !== expected) return null;
    const payload = JSON.parse(b64urlDecode(body).toString()) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
