import { describe, it, expect, vi, beforeEach } from "vitest";

// routeClient pulls a large dependency graph; stub the heavy collaborators so we
// can unit-test the contact extraction in isolation.
vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({ collection: () => ({}) }) }, firestore: Object.assign(() => ({ collection: () => ({}) }), { FieldValue: {} }) }));
const quickComplete = vi.fn();
vi.mock("../utils/openaiClient", () => ({ quickComplete: (...a: any[]) => quickComplete(...a) }));
vi.mock("./client", () => ({ sendMessage: vi.fn(), startTyping: vi.fn(), stopTyping: vi.fn() }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async () => "") }));
vi.mock("../agents/jobPostingFlow", () => ({ handleJobPostingStep: vi.fn() }));
vi.mock("../agents/refundHandler", () => ({ handleRefundRequest: vi.fn() }));
vi.mock("../agents/timesheetHandler", () => ({ handleTimesheetApproval: vi.fn() }));
vi.mock("../agents/availabilityHandler", () => ({ handleAvailabilityUpdate: vi.fn() }));
vi.mock("../agents/clientSwapRequestHandler", () => ({ handleClientSwapRequest: vi.fn() }));

import { extractContactNameAndPhone } from "./routeClient";

beforeEach(() => quickComplete.mockReset());

describe("extractContactNameAndPhone", () => {
  it("uses the LLM to separate name from phone (not a regex split)", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({ name: "Jane Smith", phone: "555-123-4567" }));
    const r = await extractContactNameAndPhone("it's my sister Jane Smith, 555-123-4567");
    expect(r.name).toBe("Jane Smith");
    expect(r.phone).toBe("5551234567");
  });

  it("returns null phone when the extracted number is too short", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({ name: "Bob", phone: "123" }));
    const r = await extractContactNameAndPhone("Bob 123");
    expect(r.name).toBe("Bob");
    expect(r.phone).toBeNull();
  });

  it("falls back to a bare phone number when the LLM output is unparseable", async () => {
    quickComplete.mockResolvedValue("not json");
    const r = await extractContactNameAndPhone("+1 (555) 222-3333");
    expect(r.phone).toBe("+15552223333");
    expect(r.name).toBeNull();
  });

  it("returns nulls for prose with no contact", async () => {
    quickComplete.mockResolvedValue(JSON.stringify({ name: null, phone: null }));
    const r = await extractContactNameAndPhone("I'm not sure who to add");
    expect(r).toEqual({ name: null, phone: null });
  });
});
