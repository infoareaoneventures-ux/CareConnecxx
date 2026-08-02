import { createHash, createHmac } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { GoogleAuth, OAuth2Client } from "google-auth-library";

const MAX_BYTES = 10 * 1024 * 1024;
const SIGNATURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TOPIC = process.env.CHILD_FILE_SCAN_REQUEST_TOPIC || "childcare-file-scan-requests";
const RESULT_TOPIC = process.env.CHILD_FILE_SCAN_RESULT_TOPIC || "childcare-file-scan-results";

export interface ScanRequest {
  schemaVersion: 1;
  operationId: string;
  fileId: string;
  path: string;
  objectGeneration: string;
  sha256: string;
  contentType: string;
  size: number;
  attempt: number;
  deadlineAt: string;
}

export interface ScanResultPayload {
  schemaVersion: 1;
  operationId: string;
  fileId: string;
  path: string;
  objectGeneration: string;
  sha256: string;
  result: "clean" | "malicious" | "error";
  reasonCode: string;
  engineVersion: string;
  signatureVersion: string;
  signatureUpdatedAt: string;
  imageDigest: string;
  attempt: number;
  scannedAt: string;
}

export interface SignedScanResult extends ScanResultPayload {
  signature: string;
}

export interface ClamVersion {
  engineVersion: string;
  signatureVersion: string;
  signatureUpdatedAt: string;
}

export interface ScannerDependencies {
  download(request: ScanRequest): Promise<Buffer>;
  inspectClamVersion(): Promise<ClamVersion>;
  scan(bytes: Buffer): Promise<{ verdict: "clean" | "malicious" | "error"; reasonCode: string }>;
  publish(result: SignedScanResult): Promise<string>;
  now(): Date;
  imageDigest: string;
  hmacSecret: string;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validateScanRequest(value: unknown): ScanRequest {
  if (!value || typeof value !== "object") throw new Error("invalid_request_schema");
  const request = value as Partial<ScanRequest>;
  if (
    request.schemaVersion !== 1 ||
    !boundedString(request.operationId, 80) ||
    !boundedString(request.fileId, 64) ||
    !/^childcare\/[^/]+\/[^/]+\/(safety_document|care_document|photo)\/cf_[a-f0-9]{40}$/.test(
      String(request.path ?? ""),
    ) ||
    !boundedString(request.objectGeneration, 64) ||
    !/^[a-f0-9]{64}$/.test(String(request.sha256 ?? "")) ||
    !boundedString(request.contentType, 100) ||
    !Number.isInteger(request.size) ||
    Number(request.size) <= 0 ||
    Number(request.size) > MAX_BYTES ||
    !Number.isInteger(request.attempt) ||
    Number(request.attempt) < 1 ||
    Number(request.attempt) > 3 ||
    !boundedString(request.deadlineAt, 40)
  ) {
    throw new Error("invalid_request_schema");
  }
  return request as ScanRequest;
}

export function canonicalResultPayload(result: ScanResultPayload): string {
  return JSON.stringify({
    schemaVersion: result.schemaVersion,
    operationId: result.operationId,
    fileId: result.fileId,
    path: result.path,
    objectGeneration: result.objectGeneration,
    sha256: result.sha256,
    result: result.result,
    reasonCode: result.reasonCode,
    engineVersion: result.engineVersion,
    signatureVersion: result.signatureVersion,
    signatureUpdatedAt: result.signatureUpdatedAt,
    imageDigest: result.imageDigest,
    attempt: result.attempt,
    scannedAt: result.scannedAt,
  });
}

export function signResult(result: ScanResultPayload, secret: string): string {
  if (!secret) throw new Error("scan_result_secret_unavailable");
  return createHmac("sha256", secret).update(canonicalResultPayload(result)).digest("hex");
}

export function parseClamVersion(raw: string): ClamVersion {
  const line = String(raw ?? "").trim().split(/\r?\n/)[0];
  const match = /^ClamAV\s+([^/]+)\/([^/]+)\/(.+)$/.exec(line);
  if (!match) throw new Error("clamav_version_unparseable");
  const signatureDate = new Date(match[3]);
  if (!Number.isFinite(signatureDate.getTime())) throw new Error("clamav_signature_date_invalid");
  return {
    engineVersion: `ClamAV ${match[1]}`.slice(0, 80),
    signatureVersion: match[2].slice(0, 120),
    signatureUpdatedAt: signatureDate.toISOString(),
  };
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk).slice(0, 4096);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 4096);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: Number(code ?? 2), stdout, stderr }));
  });
}

async function scanWithClam(bytes: Buffer): Promise<{
  verdict: "clean" | "malicious" | "error";
  reasonCode: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "careconnex-child-scan-"));
  const path = join(dir, "object.bin");
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    const result = await run("clamdscan", ["--fdpass", "--no-summary", path]);
    if (result.code === 0) return { verdict: "clean", reasonCode: "clamav_clean" };
    if (result.code === 1) return { verdict: "malicious", reasonCode: "malware_detected" };
    return { verdict: "error", reasonCode: "scanner_engine_error" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function processScanRequest(
  input: unknown,
  deps: ScannerDependencies,
): Promise<SignedScanResult> {
  const request = validateScanRequest(input);
  const now = deps.now();
  if (Date.parse(request.deadlineAt) < now.getTime()) throw new Error("scan_request_expired");
  if (!/^sha256:[a-f0-9]{64}$/.test(deps.imageDigest)) throw new Error("scanner_image_digest_invalid");

  const [bytes, clam] = await Promise.all([
    deps.download(request),
    deps.inspectClamVersion(),
  ]);
  if (bytes.length !== request.size || bytes.length > MAX_BYTES) throw new Error("object_size_mismatch");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== request.sha256) throw new Error("object_checksum_mismatch");
  const signatureTime = Date.parse(clam.signatureUpdatedAt);
  if (
    !Number.isFinite(signatureTime) ||
    signatureTime > now.getTime() + 5 * 60 * 1000 ||
    now.getTime() - signatureTime > SIGNATURE_MAX_AGE_MS
  ) {
    throw new Error("stale_clamav_signatures");
  }

  const verdict = await deps.scan(bytes);
  const payload: ScanResultPayload = {
    schemaVersion: 1,
    operationId: request.operationId,
    fileId: request.fileId,
    path: request.path,
    objectGeneration: request.objectGeneration,
    sha256: request.sha256,
    result: verdict.verdict,
    reasonCode: verdict.reasonCode.slice(0, 80),
    engineVersion: clam.engineVersion.slice(0, 80),
    signatureVersion: clam.signatureVersion.slice(0, 120),
    signatureUpdatedAt: clam.signatureUpdatedAt,
    imageDigest: deps.imageDigest,
    attempt: request.attempt,
    scannedAt: now.toISOString(),
  };
  const signed: SignedScanResult = {
    ...payload,
    signature: signResult(payload, deps.hmacSecret),
  };
  await deps.publish(signed);
  return signed;
}

function decodePubSubEnvelope(body: unknown): unknown {
  if (!body || typeof body !== "object") throw new Error("invalid_pubsub_envelope");
  const message = (body as { message?: { data?: string } }).message;
  if (!message?.data) throw new Error("invalid_pubsub_envelope");
  return JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function verifyInvocation(
  authorization: string | undefined,
  audience: string,
  expectedServiceAccount: string,
  client = new OAuth2Client(),
): Promise<void> {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
  if (!match || !audience || !expectedServiceAccount) throw new Error("unauthorized_invocation");
  const ticket = await client.verifyIdToken({ idToken: match[1], audience });
  const payload = ticket.getPayload();
  if (!payload || payload.email !== expectedServiceAccount || payload.email_verified !== true) {
    throw new Error("unauthorized_invocation");
  }
}

function defaultDependencies(): ScannerDependencies {
  const bucketName = process.env.CHILD_FILE_QUARANTINE_BUCKET || "";
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || "";
  const hmacSecret = process.env.CHILD_FILE_SCAN_RESULT_HMAC_SECRET || "";
  const imageDigest = process.env.CHILD_FILE_SCANNER_IMAGE_DIGEST || "";
  if (!bucketName) throw new Error("quarantine_bucket_unavailable");
  if (!projectId) throw new Error("google_cloud_project_unavailable");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return {
    async download(request) {
      const client = await auth.getClient();
      const objectName = encodeURIComponent(request.path);
      const response = await client.request<ArrayBuffer>({
        url: `https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(bucketName)}/o/${objectName}`,
        method: "GET",
        params: {
          alt: "media",
          generation: request.objectGeneration,
        },
        responseType: "arraybuffer",
      });
      return Buffer.from(response.data);
    },
    async inspectClamVersion() {
      const result = await run("clamdscan", ["--version"]);
      if (result.code !== 0) throw new Error("clamav_unavailable");
      return parseClamVersion(result.stdout);
    },
    scan: scanWithClam,
    async publish(result) {
      const client = await auth.getClient();
      const response = await client.request<{ messageIds?: string[] }>({
        url: `https://pubsub.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(RESULT_TOPIC)}:publish`,
        method: "POST",
        data: {
          messages: [{
            data: Buffer.from(JSON.stringify(result)).toString("base64"),
          }],
        },
      });
      const messageId = response.data.messageIds?.[0];
      if (!messageId) throw new Error("scan_result_publish_failed");
      return messageId;
    },
    now: () => new Date(),
    imageDigest,
    hmacSecret,
  };
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  depsFactory: () => ScannerDependencies = defaultDependencies,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    try {
      const deps = depsFactory();
      const clam = await deps.inspectClamVersion();
      const age = deps.now().getTime() - Date.parse(clam.signatureUpdatedAt);
      if (age < 0 || age > SIGNATURE_MAX_AGE_MS) throw new Error("stale_clamav_signatures");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, engineVersion: clam.engineVersion, signatureUpdatedAt: clam.signatureUpdatedAt }));
    } catch {
      res.writeHead(503, { "cache-control": "no-store" });
      res.end();
    }
    return;
  }
  if (req.method !== "POST" || req.url !== "/") {
    res.writeHead(404);
    res.end();
    return;
  }

  try {
    await verifyInvocation(
      req.headers.authorization,
      process.env.SCANNER_AUDIENCE || "",
      process.env.PUBSUB_PUSH_SERVICE_ACCOUNT || "",
    );
    const body = await readJson(req);
    const request = decodePubSubEnvelope(body);
    await processScanRequest(request, depsFactory());
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
  } catch (err) {
    console.error("[childcare-file-scanner] request failed:", err instanceof Error ? err.message : "Error");
    res.writeHead(
      err instanceof Error && err.message === "unauthorized_invocation" ? 401 : 500,
      { "cache-control": "no-store" },
    );
    res.end();
  }
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createServer((req, res) => {
    void handleRequest(req, res);
  }).listen(port);
  console.info(`[childcare-file-scanner] listening on ${port}; request topic ${REQUEST_TOPIC}`);
}
