// Launch-scenario coverage for U6 (R5/R6/R7). These tests lock the safety
// invariants that the propose→confirm→execute healthcare layer must hold,
// independent of the higher-level handler wiring:
//
//   1. Provider/insurance discovery is READ-ONLY (never gated, never commits).
//   2. Appointment booking is gated on the EXACT approved slot.
//   3. Pharmacy refill is high-risk → routes to the account holder.
//   4. A new-prescription request never produces medical advice / clinical text.
//   6. A failed portal action surfaces as a truthful failure (no "success",
//      no "booked"/"done"), so the approval layer ledgers it + alerts admins.
//
// (Scenario 5 — emergency → 911 + admin safety alert — is covered in
// linq/__tests__/handleInbound.routing.test.ts and safety/crisisDetector.test.ts.)

import { describe, it, expect, vi, beforeEach } from "vitest";

// pendingActions.ts calls admin.firestore() at module load — stub it. These
// tests exercise pure predicates (isHighRisk/buildActionPreview) and the
// browser actions, neither of which touch Firestore directly.
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: () => ({}) }) },
  firestore: () => ({ collection: () => ({}) }),
}));

// ── Fake browser session (Stagehand + Playwright page) ───────────────────────
const act = vi.fn(async () => {});
const extract = vi.fn();
const fill = vi.fn(async () => {});
const goto = vi.fn(async () => {});
const fakeSession = {
  sessionId: "sess1",
  stagehand: { act: (...a: unknown[]) => act(...a), extract: (...a: unknown[]) => extract(...a) },
  page: {
    goto: (...a: unknown[]) => goto(...a),
    waitForTimeout: vi.fn(async () => {}),
    fill: (...a: unknown[]) => fill(...a),
    setDefaultTimeout: vi.fn(),
  },
};
const searchWeb = vi.fn();
const fetchPage = vi.fn();

vi.mock("../browser/browserbaseClient", () => ({
  createBrowserSession: vi.fn(async () => fakeSession),
  closeBrowserSession: vi.fn(async () => {}),
  withSessionTimeout: (_s: unknown, work: () => Promise<unknown>) => work(),
  searchWeb: (...a: unknown[]) => searchWeb(...a),
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  logBrowserSession: vi.fn(async () => {}),
}));
vi.mock("../browser/credentialVault", () => ({
  getCredential: vi.fn(async () => ({ username: "user@x.com", password: "s3cret-PW", portalUrl: "https://cvs.com" })),
  markCredentialUsed: vi.fn(async () => {}),
  insurerToServiceKey: (s: string) => s,
}));

import {
  searchHealthcareProvider,
  requestPharmacyRefill,
  bookAppointmentSlot,
} from "../browser/careWebActions";
import { isHighRisk, buildActionPreview } from "./pendingActions";

beforeEach(() => {
  act.mockClear(); extract.mockReset(); fill.mockClear(); goto.mockClear();
  searchWeb.mockReset(); fetchPage.mockReset();
});

// ── Scenario 1: provider/insurance discovery is READ-ONLY ─────────────────────
describe("scenario 1 — discovery is read-only (R5)", () => {
  it("searchHealthcareProvider uses web search only — no portal login, no browser commit", async () => {
    searchWeb.mockResolvedValue([{ title: "Dr. Lee", url: "https://example.com/lee" }]);
    fetchPage.mockResolvedValue({ statusCode: 200, content: "Dr. Lee — cardiologist, accepts most insurance plans." });
    const r = await searchHealthcareProvider({ userId: "u1", phone: "+1", query: "cardiologist", city: "Atlanta" });
    expect(r.found).toBe(true);
    // No Stagehand act() (no portal navigation / submit) and no field-fill login happened.
    expect(act).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it("read-only discovery (no chosenSlot) and insurance_check are NOT gated", () => {
    expect(isHighRisk("perform_web_action", { loginAction: "schedule_appointment" })).toBe(false);
    expect(isHighRisk("perform_web_action", { loginAction: "insurance_check" })).toBe(false);
  });
});

// ── Scenario 2: appointment booking requires the EXACT approved slot (AE6) ─────
describe("scenario 2 — booking gated on the exact approved slot (R5/AE6)", () => {
  it("only the commit carrying chosenSlot is high-risk", () => {
    expect(isHighRisk("perform_web_action", { loginAction: "schedule_appointment" })).toBe(false);
    expect(isHighRisk("perform_web_action", {
      loginAction: "schedule_appointment",
      chosenSlot: { provider: "Dr. Lee", datetime: "2026-06-23T14:30" },
    })).toBe(true);
  });

  it("the approval preview names the specific slot being approved", () => {
    const preview = buildActionPreview("perform_web_action", {
      loginAction: "schedule_appointment",
      chosenSlot: { provider: "Dr. Lee", datetime: "2026-06-23T14:30", location: "Northside" },
    });
    expect(preview).toContain("Dr. Lee");
    expect(preview).toContain("2026-06-23T14:30");
    expect(preview).toContain("Northside");
  });

  it("commit refuses to book when the approved slot no longer matches exactly", async () => {
    extract.mockResolvedValueOnce({ matchCount: 0 }); // slot gone since approval
    const r = await bookAppointmentSlot({
      userId: "u1", phone: "+1",
      chosenSlot: { provider: "Dr. Lee", datetime: "2026-06-23T14:30" },
    });
    expect(r.status).toBe("slot_unavailable");
    // The booking-commit step ("Confirm and submit the appointment") never ran.
    // (The login form submit is a separate, expected act and is excluded.)
    const actArgs = act.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(actArgs.some((a) => a.includes("confirm and submit the appointment"))).toBe(false);
    expect(actArgs.some((a) => a.includes("select the slot"))).toBe(false);
  });
});

// ── Scenario 3: pharmacy refill requires account-holder confirmation ──────────
describe("scenario 3 — pharmacy refill is high-risk (R5)", () => {
  it("refill is always gated regardless of args", () => {
    expect(isHighRisk("perform_web_action", { loginAction: "pharmacy_refill" })).toBe(true);
    expect(isHighRisk("perform_web_action", { loginAction: "pharmacy_refill", medicationName: "Lisinopril" })).toBe(true);
  });
});

// ── Scenario 4: new prescription avoids medical advice (R7) ───────────────────
describe("scenario 4 — new-prescription previews carry no clinical advice (R7)", () => {
  it("a refill/appointment preview states the logistical action, not dosing or diagnosis", () => {
    const refill = buildActionPreview("perform_web_action", {
      loginAction: "pharmacy_refill", medicationName: "Lisinopril", pharmacyService: "cvs",
    }).toLowerCase();
    // It says WHAT will be requested WHERE — never how much to take.
    expect(refill).toContain("refill");
    expect(refill).not.toMatch(/\b(take|dose|dosage|mg|increase|decrease|start taking|stop taking)\b/);
  });
});

// ── Scenario 6: failed portal action is truthful (R6) ─────────────────────────
describe("scenario 6 — failed portal action does NOT claim success (R6)", () => {
  it("a thrown portal error returns success:false with a non-success message", async () => {
    act.mockImplementationOnce(async () => { throw new Error("portal 500"); });
    const r = await requestPharmacyRefill({ userId: "u1", phone: "+1", pharmacyService: "cvs", medicationName: "Lisinopril" });
    expect(r.success).toBe(false);
    expect(r.result.toLowerCase()).not.toContain("refill requested");
    expect(r.result.toLowerCase()).not.toMatch(/\b(done|booked|confirmed|success)\b/);
  });

  it("a submitted-but-unconfirmed booking is reported as 'awaiting', never 'booked'", async () => {
    extract.mockResolvedValueOnce({ matchCount: 1 }).mockResolvedValueOnce({}); // no confirmation read-back
    const r = await bookAppointmentSlot({
      userId: "u1", phone: "+1",
      chosenSlot: { provider: "Dr. Lee", datetime: "2026-06-23T14:30" },
    });
    expect(r.status).toBe("unverified"); // not "verified_success"
    expect(r.result.toLowerCase()).toContain("awaiting");
    expect(r.result.toLowerCase()).not.toMatch(/\bbooked\b/);
  });
});
