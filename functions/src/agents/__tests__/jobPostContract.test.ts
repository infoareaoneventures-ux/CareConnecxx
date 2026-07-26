import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  buildWebJobPostDoc,
  assertLegacyJobMirrorAllowed,
  LegacyJobMirrorError,
} from "../jobPostContract";

// The caregiver Job Board renders the web wizard's JobPost shape. Every
// server-side job_posts write goes through buildWebJobPostDoc — these tests
// pin the contract so a writer can't drift back to the pre-2026-07-10 shape
// (location OBJECT → JSX crash, summary-instead-of-title → blank card,
// Timestamp createdAt → invisible to the string-compared daily match sweep).
describe("buildWebJobPostDoc — web JobPost contract", () => {
  const base = {
    clientId: "client-uid",
    source:   "cara",
    title:    "Care for Margaret",
    careTypes: ["Dementia / Memory Care", "Companionship"],
    startDate: "2026-08-01",
    frequency: "part_time",
    daysPerWeek: 3,
    timeOfDay: ["morning"],
    hourlyRate: 28,
    paymentMethod: "card",
    city: "San Jose",
    zipCode: "95110",
    lat: 37.33,
    lng: -121.89,
    clientName: "Hamse",
    phone: "+14085550100",
  };

  it("emits the fields the Job Board card actually renders", () => {
    const doc = buildWebJobPostDoc(base);
    expect(doc.title).toBe("Care for Margaret");
    expect(doc.location).toBe("San Jose, 95110");     // STRING, never an object
    expect(typeof doc.location).toBe("string");
    expect(doc.rate).toBe(28);
    expect(doc.rateFlexible).toBe(false);
    expect(doc.date).toBe("2026-08-01");              // legacy mirror of startDate
    expect(doc.lat).toBe(37.33);                       // top-level for distance math
    expect(doc.lng).toBe(-121.89);
    expect(doc.clientName).toBe("Hamse");
    expect(doc.requirements).toEqual(base.careTypes);  // careTypes mirror
    expect(doc.status).toBe("open");
    expect(doc.applicantCount).toBe(0);
  });

  it("maps Evia enums to web enums", () => {
    const doc = buildWebJobPostDoc(base);
    expect(doc.paymentMethod).toBe("credit");          // "card" → web enum
    expect(doc.jobFrequency).toBe("part-time");        // underscores → hyphens
  });

  it("createdAt is an ISO STRING (board sort + daily sweep string comparison)", () => {
    const doc = buildWebJobPostDoc(base);
    expect(typeof doc.createdAt).toBe("string");
    expect(() => new Date(doc.createdAt as string).toISOString()).not.toThrow();
  });

  it("flexible rate → rate 0 + rateFlexible true (web wizard convention)", () => {
    const doc = buildWebJobPostDoc({ ...base, hourlyRate: "flexible" });
    expect(doc.rate).toBe(0);
    expect(doc.rateFlexible).toBe(true);
    expect(doc.hourlyRate).toBe("flexible");           // extra kept for SMS readers
  });

  it("fills a description and defaults startDate to ASAP when missing", () => {
    const doc = buildWebJobPostDoc({ clientId: "c", source: "cara", title: "Care needed", careTypes: ["Companionship"] });
    expect(String(doc.description)).toContain("Companionship");
    expect(doc.startDate).toBe("ASAP");
    expect(doc.date).toBe("ASAP");
    expect(doc.rateFlexible).toBe(true);
  });

  it("keeps the server-side extras the SMS notifiers read", () => {
    const doc = buildWebJobPostDoc(base) as any;
    expect(doc.careTypes).toEqual(base.careTypes);     // notifyAreaCaregivers fit-gate
    expect(doc.schedule.daysPerWeek).toBe(3);
    expect(doc.notifiedCount).toBe(0);
    expect(doc.summary).toContain("Dementia");
    expect(doc.phone).toBe("+14085550100");
  });
});

// ── R32 legacy-mirror guard (childcare plan 2026-07-22-002, U6) ──────────────
//
// Childcare jobs are auto-ID job_posts docs and NEVER write the legacy
// singleton job_postings/{clientUid} mirror. The guard is structural: every
// mirror writer calls assertLegacyJobMirrorAllowed with its vertical-bearing
// context before the mirror write.

describe("assertLegacyJobMirrorAllowed (R32)", () => {
  it("passes senior and legacy (vertical-absent) contexts", () => {
    expect(() => assertLegacyJobMirrorAllowed({})).not.toThrow();
    expect(() => assertLegacyJobMirrorAllowed({ careVertical: "senior" })).not.toThrow();
    expect(() => assertLegacyJobMirrorAllowed(null, undefined, { seniorName: "M" })).not.toThrow();
  });

  it("throws for a childcare-vertical context in ANY position", () => {
    expect(() => assertLegacyJobMirrorAllowed({ careVertical: "child" })).toThrow(LegacyJobMirrorError);
    expect(() => assertLegacyJobMirrorAllowed({}, { careVertical: "child" })).toThrow(/job_postings/);
  });

  it("buildAndSaveJobPost calls the guard BEFORE its job_postings mirror write (structural)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../buildJobPost.ts"),
      "utf8",
    );
    const guardIdx = source.indexOf("assertLegacyJobMirrorAllowed(onboardingData, jobData)");
    const mirrorIdx = source.indexOf('collection("job_postings")');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(mirrorIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mirrorIdx);
  });

  it("the MCP edit_job_post mirror writer carries its own childcare rejection (structural)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../mcp/server.ts"),
      "utf8",
    );
    const guardIdx = source.indexOf('jp.careVertical === "child"');
    const mirrorIdx = source.indexOf('collection("job_postings")');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(mirrorIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mirrorIdx);
  });
});
