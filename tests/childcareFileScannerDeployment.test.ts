// @vitest-environment node

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const deploy = fs.readFileSync(
  path.join(ROOT, "scripts", "deploy-childcare-file-scanner.mjs"),
  "utf8",
);
const dockerfile = fs.readFileSync(
  path.join(ROOT, "infra", "childcare-file-scanner", "Dockerfile"),
  "utf8",
);
const cloudbuild = fs.readFileSync(
  path.join(ROOT, "infra", "childcare-file-scanner", "cloudbuild.yaml"),
  "utf8",
);

describe("childcare file scanner deployment posture", () => {
  it("pins the base and deployed scanner images by digest with source attestation", () => {
    expect(dockerfile).toMatch(/^FROM\s+\S+@sha256:[a-f0-9]{64}$/m);
    expect(dockerfile).toContain("org.opencontainers.image.revision");
    expect(dockerfile).toContain("careconnex.dependency-lock-sha256");
    expect(cloudbuild).toContain("CARECONNEX_GIT_SHA=${_GIT_SHA}");
    expect(cloudbuild).toContain("CARECONNEX_LOCK_SHA256=${_LOCK_SHA256}");
    expect(deploy).toMatch(/immutableImage/);
    expect(deploy).toMatch(/@\$\{imageDigest\}/);
    expect(deploy).toContain("clean, fully tracked Git checkout");
  });

  it("grants the scanner only quarantine read, result publish, and secret access", () => {
    expect(deploy).toContain("roles/storage.objectViewer");
    expect(deploy).toContain("resource.name.startsWith");
    expect(deploy).toContain("/objects/childcare/");
    expect(deploy).toContain("roles/pubsub.publisher");
    expect(deploy).toContain("roles/secretmanager.secretAccessor");
    expect(deploy).toContain("/datastore|firebase|owner|editor/i");
    expect(deploy).not.toMatch(/"roles\/datastore[^"]*"/);
    expect(deploy).not.toMatch(/"roles\/firebase[^"]*"/);
  });

  it("keeps Cloud Run private and binds authenticated PubSub push", () => {
    expect(deploy).toContain("--no-allow-unauthenticated");
    expect(deploy).toContain("--ingress");
    expect(deploy).toContain("--push-auth-service-account");
    expect(deploy).toContain("--push-auth-token-audience");
    expect(deploy).toContain("roles/run.invoker");
  });

  it("fails deployment on region, budget, secret, or signature-proof gaps", () => {
    expect(deploy).toContain("Bucket location");
    expect(deploy).toContain("--budget-id is required");
    expect(deploy).toContain("--billing-account is required");
    expect(deploy).toContain("must be created through the approved secret process");
    expect(deploy).toContain("CHILD_FILE_SCANNER_IMAGE_DIGEST");
  });
});
