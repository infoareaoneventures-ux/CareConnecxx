#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--apply") {
    args.set("apply", "true");
  } else if (arg.startsWith("--") && process.argv[i + 1]) {
    args.set(arg.slice(2), process.argv[++i]);
  }
}

const project = args.get("project") || "";
const region = args.get("region") || "";
const bucket = args.get("bucket") || "";
const budgetId = args.get("budget-id") || "";
const billingAccount = args.get("billing-account") || "";
const apply = args.get("apply") === "true";
const expectedProject = "careconnex-d4c8b";
if (project !== expectedProject) throw new Error(`--project must be ${expectedProject}`);
if (!/^[a-z]+-[a-z0-9]+[0-9]$/.test(region)) throw new Error("--region is required");
if (!/^[a-z0-9][a-z0-9._-]{2,222}$/.test(bucket)) throw new Error("--bucket is required");
if (!budgetId) throw new Error("--budget-id is required so scanner cost alerting can be verified");
if (!billingAccount) throw new Error("--billing-account is required so scanner cost alerting can be verified");

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  }).trim();
}

function capture(command, commandArgs) {
  return run(command, commandArgs, { capture: true });
}

function exists(command, commandArgs) {
  try {
    capture(command, commandArgs);
    return true;
  } catch {
    return false;
  }
}

const sha = capture("git", ["rev-parse", "HEAD"]);
const dirty = capture("git", ["status", "--porcelain", "--untracked-files=all"]);
if (dirty) throw new Error("Scanner deployment requires a clean, fully tracked Git checkout");

const dockerfile = readFileSync(
  resolve(ROOT, "infra/childcare-file-scanner/Dockerfile"),
  "utf8",
);
const lock = readFileSync(
  resolve(ROOT, "infra/childcare-file-scanner/package-lock.json"),
);
if (!/^FROM\s+\S+@sha256:[a-f0-9]{64}$/m.test(dockerfile)) {
  throw new Error("Scanner base image must be pinned by digest");
}
const lockSha256 = createHash("sha256").update(lock).digest("hex");

const bucketInfo = JSON.parse(
  capture("gcloud.cmd", [
    "storage",
    "buckets",
    "describe",
    `gs://${bucket}`,
    "--project",
    project,
    "--format=json",
  ]),
);
const bucketRegion = String(bucketInfo.location || "").toLowerCase();
if (!bucketRegion || bucketRegion !== region.toLowerCase()) {
  throw new Error(`Bucket location ${bucketRegion || "unknown"} is incompatible with scanner region ${region}`);
}

if (
  !exists("gcloud.cmd", [
    "billing",
    "budgets",
    "describe",
    budgetId,
    "--billing-account",
    billingAccount,
    "--format=value(name)",
  ])
) {
  throw new Error("The required scanner budget alert could not be verified");
}

const names = {
  repository: "careconnex-security",
  service: "childcare-file-scanner",
  scannerSa: `childcare-file-scanner@${project}.iam.gserviceaccount.com`,
  pushSa: `childcare-file-scan-push@${project}.iam.gserviceaccount.com`,
  dispatcherSa: `childcare-file-dispatcher@${project}.iam.gserviceaccount.com`,
  requestTopic: "childcare-file-scan-requests",
  resultTopic: "childcare-file-scan-results",
  subscription: "childcare-file-scan-requests-cloud-run",
  secret: "CHILD_FILE_SCAN_RESULT_HMAC_SECRET",
};

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      project,
      region,
      bucket,
      gitSha: sha,
      dependencyLockSha256: lockSha256,
      ...names,
    },
    null,
    2,
  ),
);
if (!apply) process.exit(0);

for (const [accountId, displayName] of [
  ["childcare-file-scanner", "Restricted childcare malware scanner"],
  ["childcare-file-scan-push", "PubSub push identity for childcare scanner"],
  ["childcare-file-dispatcher", "Storage finalize childcare scan dispatcher"],
]) {
  if (!exists("gcloud.cmd", ["iam", "service-accounts", "describe", `${accountId}@${project}.iam.gserviceaccount.com`, "--project", project])) {
    run("gcloud.cmd", [
      "iam",
      "service-accounts",
      "create",
      accountId,
      "--display-name",
      displayName,
      "--project",
      project,
    ]);
  }
}

for (const topic of [names.requestTopic, names.resultTopic]) {
  if (!exists("gcloud.cmd", ["pubsub", "topics", "describe", topic, "--project", project])) {
    run("gcloud.cmd", ["pubsub", "topics", "create", topic, "--project", project]);
  }
}
if (!exists("gcloud.cmd", ["secrets", "describe", names.secret, "--project", project])) {
  throw new Error(`Secret ${names.secret} must be created through the approved secret process before deploy`);
}
if (!exists("gcloud.cmd", ["artifacts", "repositories", "describe", names.repository, "--location", region, "--project", project])) {
  run("gcloud.cmd", [
    "artifacts",
    "repositories",
    "create",
    names.repository,
    "--repository-format=docker",
    "--location",
    region,
    "--project",
    project,
  ]);
}

run("gcloud.cmd", [
  "storage",
  "buckets",
  "add-iam-policy-binding",
  `gs://${bucket}`,
  "--member",
  `serviceAccount:${names.scannerSa}`,
  "--role",
  "roles/storage.objectViewer",
  "--condition",
  `expression=resource.name.startsWith('projects/_/buckets/${bucket}/objects/childcare/'),title=childcare-quarantine-read,description=Read only restricted childcare quarantine objects`,
]);
run("gcloud.cmd", [
  "pubsub",
  "topics",
  "add-iam-policy-binding",
  names.resultTopic,
  "--member",
  `serviceAccount:${names.scannerSa}`,
  "--role",
  "roles/pubsub.publisher",
  "--project",
  project,
]);
run("gcloud.cmd", [
  "pubsub",
  "topics",
  "add-iam-policy-binding",
  names.requestTopic,
  "--member",
  `serviceAccount:${names.dispatcherSa}`,
  "--role",
  "roles/pubsub.publisher",
  "--project",
  project,
]);
run("gcloud.cmd", [
  "secrets",
  "add-iam-policy-binding",
  names.secret,
  "--member",
  `serviceAccount:${names.scannerSa}`,
  "--role",
  "roles/secretmanager.secretAccessor",
  "--project",
  project,
]);

const imageTag = `${region}-docker.pkg.dev/${project}/${names.repository}/${names.service}:${sha}`;
run("npm.cmd", ["run", "build"], {
  cwd: resolve(ROOT, "infra/childcare-file-scanner"),
});
run("gcloud.cmd", [
  "builds",
  "submit",
  "infra/childcare-file-scanner",
  "--config",
  "infra/childcare-file-scanner/cloudbuild.yaml",
  "--project",
  project,
  "--substitutions",
  `_IMAGE=${imageTag},_GIT_SHA=${sha},_LOCK_SHA256=${lockSha256}`,
]);
const imageDigest = capture("gcloud.cmd", [
  "artifacts",
  "docker",
  "images",
  "describe",
  imageTag,
  "--format=value(image_summary.digest)",
  "--project",
  project,
]);
if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error("Built scanner image digest is invalid");
const immutableImage = `${region}-docker.pkg.dev/${project}/${names.repository}/${names.service}@${imageDigest}`;

run("gcloud.cmd", [
  "run",
  "deploy",
  names.service,
  "--image",
  immutableImage,
  "--region",
  region,
  "--project",
  project,
  "--service-account",
  names.scannerSa,
  "--no-allow-unauthenticated",
  "--ingress",
  "internal",
  "--cpu",
  "1",
  "--memory",
  "1Gi",
  "--concurrency",
  "2",
  "--max-instances",
  "5",
  "--timeout",
  "300",
  "--set-env-vars",
  `GOOGLE_CLOUD_PROJECT=${project},CHILD_FILE_QUARANTINE_BUCKET=${bucket},CHILD_FILE_SCAN_RESULT_TOPIC=${names.resultTopic},CHILD_FILE_SCANNER_IMAGE_DIGEST=${imageDigest},PUBSUB_PUSH_SERVICE_ACCOUNT=${names.pushSa}`,
  "--set-secrets",
  `CHILD_FILE_SCAN_RESULT_HMAC_SECRET=${names.secret}:latest`,
  "--labels",
  `careconnex-git-sha=${sha.slice(0, 40)},dependency-lock-sha256=${lockSha256.slice(0, 63)}`,
]);
const serviceUrl = capture("gcloud.cmd", [
  "run",
  "services",
  "describe",
  names.service,
  "--region",
  region,
  "--project",
  project,
  "--format=value(status.url)",
]);
run("gcloud.cmd", [
  "run",
  "services",
  "update",
  names.service,
  "--region",
  region,
  "--project",
  project,
  "--update-env-vars",
  `SCANNER_AUDIENCE=${serviceUrl}`,
]);
run("gcloud.cmd", [
  "run",
  "services",
  "add-iam-policy-binding",
  names.service,
  "--region",
  region,
  "--project",
  project,
  "--member",
  `serviceAccount:${names.pushSa}`,
  "--role",
  "roles/run.invoker",
]);

if (exists("gcloud.cmd", ["pubsub", "subscriptions", "describe", names.subscription, "--project", project])) {
  run("gcloud.cmd", [
    "pubsub",
    "subscriptions",
    "update",
    names.subscription,
    "--push-endpoint",
    serviceUrl,
    "--push-auth-service-account",
    names.pushSa,
    "--push-auth-token-audience",
    serviceUrl,
    "--ack-deadline",
    "300",
    "--project",
    project,
  ]);
} else {
  run("gcloud.cmd", [
    "pubsub",
    "subscriptions",
    "create",
    names.subscription,
    "--topic",
    names.requestTopic,
    "--push-endpoint",
    serviceUrl,
    "--push-auth-service-account",
    names.pushSa,
    "--push-auth-token-audience",
    serviceUrl,
    "--ack-deadline",
    "300",
    "--message-retention-duration",
    "1d",
    "--project",
    project,
  ]);
}

const scannerRoles = JSON.parse(
  capture("gcloud.cmd", [
    "projects",
    "get-iam-policy",
    project,
    "--flatten=bindings[].members",
    "--filter",
    `bindings.members:serviceAccount:${names.scannerSa}`,
    "--format=json(bindings.role)",
  ]),
).map((entry) => entry.bindings?.role || entry.role);
if (scannerRoles.some((role) => /datastore|firebase|owner|editor/i.test(String(role)))) {
  throw new Error(`Scanner has prohibited project IAM: ${scannerRoles.join(", ")}`);
}

console.log(
  JSON.stringify(
    {
      deployed: true,
      serviceUrl,
      immutableImage,
      imageDigest,
      gitSha: sha,
      dependencyLockSha256: lockSha256,
      requiredFunctionsEnvironment: {
        CHILD_FILE_SCANNER_REGION: region,
        CHILD_FILE_DISPATCHER_SERVICE_ACCOUNT: names.dispatcherSa,
        CHILD_FILE_SCANNER_IMAGE_DIGEST: imageDigest,
      },
    },
    null,
    2,
  ),
);
