import { describe, expect, it } from "vitest";

import {
  buildCareSituation,
  situationHealth,
  type CareSituationActor,
  type DomainLoader,
} from "./careSituation";

const actor: CareSituationActor = {
  phone: "+14085550100",
  userId: "user-1",
  seniorId: "senior-1",
  role: "client",
  channel: "linq",
};

const loader = <T>(value: T, over?: Partial<DomainLoader<T>>): DomainLoader<T> => ({
  load: () => value,
  source: { type: "firestore", ref: "senior_profiles/senior-1" },
  authority: "canonical",
  ...over,
});

describe("buildCareSituation (U2/R3/R11)", () => {
  it("loads domains with full provenance metadata", async () => {
    const s = await buildCareSituation(actor, {
      seniorProfile: loader<Record<string, unknown> | null>({ name: "Rosie" }, { untrusted: true }),
      nextAppointment: loader<Record<string, unknown> | null>({ date: "2026-07-25", status: "confirmed" }, {
        source: { type: "firestore", ref: "appointments" },
      }),
      recentJournal: loader<Array<Record<string, unknown>>>([{ timestamp: "2026-07-20" }]),
    });

    expect(s.domains.seniorProfile.status).toBe("loaded");
    const fact = s.domains.seniorProfile.fact!;
    expect(fact.value).toEqual({ name: "Rosie" });
    expect(fact.source).toEqual({ type: "firestore", ref: "senior_profiles/senior-1" });
    expect(fact.authority).toBe("canonical");
    expect(fact.untrusted).toBe(true);
    expect(Date.parse(fact.retrievedAt)).not.toBeNaN();
    expect(s.domains.nextAppointment.status).toBe("loaded");
    expect(s.domains.recentJournal.status).toBe("loaded");
  });

  it("distinguishes genuinely-empty (none) from missing loader (skipped)", async () => {
    const s = await buildCareSituation(actor, {
      seniorProfile: loader<Record<string, unknown> | null>(null),
      recentJournal: loader<Array<Record<string, unknown>>>([]),
      // nextAppointment loader absent entirely
    });
    expect(s.domains.seniorProfile.status).toBe("none");
    expect(s.domains.recentJournal.status).toBe("none");
    expect(s.domains.nextAppointment.status).toBe("skipped");
    expect(s.domains.nextAppointment.reason).toBe("no_loader");
  });

  it("isolates a throwing loader: siblings still load (R11)", async () => {
    const s = await buildCareSituation(actor, {
      seniorProfile: loader<Record<string, unknown> | null>(null, {
        load: () => { throw new Error("firestore exploded with PII: +14085550100"); },
      }),
      recentJournal: loader<Array<Record<string, unknown>>>([{ timestamp: "2026-07-20" }]),
    });
    expect(s.domains.seniorProfile.status).toBe("unavailable");
    // Reason is a short token, never the raw error (which could carry PII).
    expect(s.domains.seniorProfile.reason).toBe("load_error");
    expect(JSON.stringify(s.domains.seniorProfile)).not.toContain("4085550100");
    expect(s.domains.recentJournal.status).toBe("loaded");
  });

  it("times out a hung loader without hanging the turn (R55)", async () => {
    const s = await buildCareSituation(actor, {
      seniorProfile: loader<Record<string, unknown> | null>(null, {
        load: () => new Promise(() => { /* never resolves */ }),
      }),
      recentJournal: loader<Array<Record<string, unknown>>>([{ timestamp: "2026-07-20" }]),
    }, { loaderTimeoutMs: 30 });

    expect(s.domains.seniorProfile.status).toBe("unavailable");
    expect(s.domains.seniorProfile.reason).toBe("timeout");
    expect(s.domains.recentJournal.status).toBe("loaded");
    expect(s.totalLatencyMs).toBeLessThan(2_000);
  });

  it("honors a custom isEmpty", async () => {
    const s = await buildCareSituation(actor, {
      seniorProfile: loader<Record<string, unknown> | null>({}, {
        isEmpty: (v) => !v || Object.keys(v).length === 0,
      }),
    });
    expect(s.domains.seniorProfile.status).toBe("none");
  });

  it("situationHealth is a content-free status map", async () => {
    const s = await buildCareSituation(actor, {
      seniorProfile: loader<Record<string, unknown> | null>({ name: "Rosie", ssn: "000-00-0000" }),
    });
    const health = situationHealth(s);
    expect(health).toEqual({ seniorProfile: "loaded", nextAppointment: "skipped", recentJournal: "skipped" });
    expect(JSON.stringify(health)).not.toContain("Rosie");
    expect(JSON.stringify(health)).not.toContain("000-00");
  });
});
