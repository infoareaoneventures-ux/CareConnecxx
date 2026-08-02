// U13 static telemetry/template privacy gate (plan 2026-07-22-002, R57 / AE17).
//
// The "no child PII in telemetry or templates" source scan. Consolidates the
// U9 template-scan idea into a single U13 gate over BOTH the outbound-template
// registries (U9 notificationPolicy, interview/calendar strings) AND the U13
// telemetry emitters (childcareMetrics, childcareCanaryWatch). It also scans
// childcare log call sites for interpolated child-field identifiers.
//
// This is a SOURCE scan (fs.readFileSync), not a runtime check — it catches a
// developer wiring a child field into a template/metric/log before it can ever
// execute.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  assertChildcareTelemetryPayloadSafe,
  scanChildcareTelemetryPayload,
} from "./childcareTelemetryScan";

const CHILDCARE_DIR = path.resolve(__dirname);
const FUNCTIONS_SRC = path.resolve(__dirname, "..");

// Child-FIELD identifiers that must never be interpolated into a template, a
// metric payload, or a log line. (Field names — NOT the safe abstractions
// ageBand/areaLabel/careVertical, and NOT the prohibited-KEY string constants
// that privacyAssertions.ts legitimately declares.)
const BANNED_CHILD_FIELDS = [
  "childName", "childNames", "dateOfBirth", "birthDate", "streetAddress",
  "homeAddress", "addressLine1", "custodyNotes", "pickupNotes", "authorizedPickup",
  "healthNotes", "medicalNotes", "allergiesNote", "emergencyContact",
  "screeningNarrative", "identityImage", "displayLabel", "recipientLabel",
];

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(FUNCTIONS_SRC, rel), "utf8");
}

/** Strip comment lines so a prohibited-KEY declaration (a legit string) is ignored. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("U13 static telemetry/template privacy gate", () => {
  it("the telemetry EMITTERS never reference a child-field identifier in code", () => {
    for (const rel of ["childcare/childcareMetrics.ts", "childcare/childcareCanaryWatch.ts"]) {
      const src = codeOnly(readSrc(rel));
      for (const field of BANNED_CHILD_FIELDS) {
        expect(src, `${rel} must not reference "${field}"`).not.toContain(field);
      }
    }
  });

  it("the childSafe notification registry never interpolates a child field", () => {
    const src = codeOnly(readSrc("childcare/notificationPolicy.ts"));
    for (const field of BANNED_CHILD_FIELDS) {
      expect(src, `notificationPolicy.ts must not reference "${field}"`).not.toContain(field);
    }
    // No template interpolation slots at all (static strings only).
    const templatesBlock = src.slice(src.indexOf("CHILDCARE_NOTIFICATION_TEMPLATES"), src.indexOf("as const satisfies"));
    expect(templatesBlock).not.toContain("${");
  });

  it("interview/calendar childcare strings stay generic (name-free)", () => {
    const src = readSrc("triggers/interviewLinkTrigger.ts");
    // The childcare branch uses the static generic title, never a party name.
    expect(src).toContain('"Evia Care Interview"');
  });

  it("childcare LOG call sites do not interpolate a child-field identifier", () => {
    const files = fs.readdirSync(CHILDCARE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const offenders: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(CHILDCARE_DIR, f), "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/console\.(log|info|warn|error|debug)/.test(line)) continue;
        for (const field of BANNED_CHILD_FIELDS) {
          // Ignore the prohibited-key string declarations (they live in arrays/sets,
          // not console calls — this line already matched console.*).
          if (line.includes(field)) offenders.push(`${f}:${i + 1} → ${field}`);
        }
      }
    }
    expect(offenders, `child-field identifiers in childcare log sites:\n${offenders.join("\n")}`).toHaveLength(0);
  });

  it("the metric registry exemplar shapes carry only safe keys (belt-and-braces vs the runtime test)", () => {
    const src = codeOnly(readSrc("childcare/childcareMetrics.ts"));
    // No child field appears anywhere in the shapes source.
    for (const field of BANNED_CHILD_FIELDS) {
      expect(src).not.toContain(field);
    }
  });

  it("the child self-repeat path uses typed quality telemetry before the senior-only raw diagnostic", () => {
    const src = readSrc("agents/qaAgent.ts");
    const start = src.indexOf('console.warn("qaAgent: child agent self-repeat detected"');
    const end = src.indexOf("await saveConversationTurn(phone, text, reply", start);
    const block = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('recordChildQuality("conversation_repair"');
    expect(block).toContain("} else {");
    expect(block.indexOf("} else {")).toBeLessThan(
      block.indexOf('db.collection("agent_uncertainty_log").add'),
    );
  });
});

describe("childcare telemetry runtime scanner", () => {
  it("accepts the typed pseudonymous quality-event shape", () => {
    expect(scanChildcareTelemetryPayload({
      schemaVersion: "childcare-quality-v1",
      careVertical: "child",
      eventCode: "conversation_repair",
      principalHash: "a".repeat(32),
      correlationHash: "b".repeat(32),
      metadata: { reasonCodes: ["ambiguous_reference"], rewriteApplied: true },
    })).toEqual({ safe: true, violations: [] });
  });

  it.each([
    [{ phone: "5551234567" }, "phone:forbidden_key"],
    [{ metadata: { reply: "raw model output" } }, "metadata.reply:forbidden_key"],
    [{ metadata: { contact: "person@example.com" } }, "metadata.contact:email_like"],
  ])("rejects child identifiers and raw text: %j", (payload, violation) => {
    const result = scanChildcareTelemetryPayload(payload);
    expect(result.safe).toBe(false);
    expect(result.violations).toContain(violation);
    expect(() => assertChildcareTelemetryPayloadSafe(payload)).toThrow(/unsafe childcare telemetry/);
  });

  it("treats SDK value objects as terminal values", () => {
    class TimestampLike {
      constructor(public readonly internalMessage = "not persisted user text") {}
    }
    expect(scanChildcareTelemetryPayload({
      schemaVersion: "childcare-quality-v1",
      ttl: new TimestampLike(),
    })).toEqual({ safe: true, violations: [] });
  });
});
