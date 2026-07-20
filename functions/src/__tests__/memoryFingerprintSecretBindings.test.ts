import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const srcRoot = join(__dirname, "..");

function expectFingerprintSecretBinding(file: string, exportName: string): void {
  const source = readFileSync(join(srcRoot, file), "utf8");
  const declaration = source.slice(source.indexOf(`export const ${exportName}`));

  expect(declaration).toContain(".runWith({");
  expect(declaration).toContain("MEMORY_FINGERPRINT_KEY_SECRET?.name ?? MEMORY_FINGERPRINT_KEY_NAME");
}

describe("memory fingerprint secret bindings", () => {
  it("binds the key to the web chat callable", () => {
    expectFingerprintSecretBinding("index.ts", "chatWithCara");
  });

  it("binds the key to the Linq webhook", () => {
    expectFingerprintSecretBinding("linq/webhooks.ts", "linqWebhook");
  });
});
