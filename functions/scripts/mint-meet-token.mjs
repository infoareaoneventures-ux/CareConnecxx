// One-time ops tool: mint GOOGLE_REFRESH_TOKEN with the Meet scope, then spike
// a real Meet space (accessType OPEN) to verify the whole chain.
//
// Usage (from functions/):
//   node scripts/mint-meet-token.mjs          # full flow: consent -> token -> spike
//   node scripts/mint-meet-token.mjs --spike  # skip consent, use token from .env
//
// Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (and for --spike,
// GOOGLE_REFRESH_TOKEN) from functions/.env. Prints the refresh token ONCE to
// this terminal — paste it into .env yourself; the script never writes .env.

import { google } from "googleapis";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(path.join(__dirname, "..", ".env"), "utf-8");
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in functions/.env — create the OAuth client first.");
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}`;

async function spike(auth) {
  const meet = google.meet({ version: "v2", auth });
  const res = await meet.spaces.create({ requestBody: { config: { accessType: "OPEN" } } });
  const uri = res.data.meetingUri;
  const access = res.data.config?.accessType;
  console.log("\n=== SPIKE RESULT ===");
  console.log("meetingUri:", uri);
  console.log("accessType:", access);
  console.log("\nNow: open that link on TWO phones (no Google account signed in).");
  console.log("PASS = both join directly, no 'ask to join' / waiting room.");
  if (access !== "OPEN") console.log("WARNING: accessType is not OPEN — admin policy may be constraining it.");
}

if (process.argv.includes("--spike")) {
  if (!env.GOOGLE_REFRESH_TOKEN) { console.error("GOOGLE_REFRESH_TOKEN missing in .env"); process.exit(1); }
  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  await spike(auth);
  process.exit(0);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",           // force a NEW refresh token
  scope: [SCOPE],
});

console.log("\n1. Open this URL in a browser on THIS machine.");
console.log("2. Sign in with the Google account that will OWN interview meetings.\n");
console.log(url + "\n");

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    const c = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    res.end(c ? "Token received — return to the terminal. You can close this tab." : `Error: ${err}`);
    server.close();
    c ? resolve(c) : reject(new Error(err ?? "no code"));
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`(waiting for redirect on ${REDIRECT} ...)`));
});

const { tokens } = await oauth2.getToken(code);
if (!tokens.refresh_token) {
  console.error("No refresh_token returned (account may have an existing grant). Revoke old grant at myaccount.google.com/permissions and rerun.");
  process.exit(1);
}
console.log("\n=== REFRESH TOKEN (paste into functions/.env as GOOGLE_REFRESH_TOKEN) ===\n");
console.log(tokens.refresh_token);
console.log("\nRunning spike with the fresh token...");
oauth2.setCredentials(tokens);
await spike(oauth2);
