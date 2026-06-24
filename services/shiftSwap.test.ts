import { describe, it, expect } from "vitest";
import {
  isActiveSwap,
  mapSummaryDoc,
  type PendingSwap,
} from "./shiftSwap";

const docOf = (id: string, data: Record<string, any>) => ({ id, data: () => data });

describe("mapSummaryDoc", () => {
  it("normalizes a caregiver-initiated (swap_request) summary", () => {
    const out = mapSummaryDoc(
      docOf("req_s1", { source: "swap_request", status: "open", appointmentId: "appt1", expiresAt: "2026-07-01T00:00:00Z", date: "2026-06-30", time: "09:00" })
    );
    expect(out).toEqual({
      id: "req_s1",
      source: "swap_request",
      status: "open",
      appointmentId: "appt1",
      expiresAt: "2026-07-01T00:00:00Z",
      date: "2026-06-30",
      time: "09:00",
    });
  });

  it("normalizes a client-initiated (offer) summary", () => {
    const out = mapSummaryDoc(docOf("off_o1", { source: "offer", status: "pending", appointmentId: "apptA", expiresAt: "2026-07-02T00:00:00Z" }));
    expect(out.source).toBe("offer");
    expect(out.status).toBe("pending");
    expect(out.appointmentId).toBe("apptA");
  });

  it("defaults source to swap_request when the field is absent", () => {
    const out = mapSummaryDoc(docOf("x", { status: "open" }));
    expect(out.source).toBe("swap_request");
  });
});

describe("isActiveSwap", () => {
  const NOW = new Date("2026-06-24T12:00:00Z").getTime();
  const future = "2026-06-25T12:00:00Z";
  const past = "2026-06-23T12:00:00Z";

  it.each(["open", "accepted", "pending"])("keeps active status %s when not expired", (status) => {
    expect(isActiveSwap({ id: "x", source: "swap_request", status, expiresAt: future } as PendingSwap, NOW)).toBe(true);
  });

  it.each(["declined", "cancelled", "expired", "completed"])("drops terminal status %s", (status) => {
    expect(isActiveSwap({ id: "x", source: "swap_request", status, expiresAt: future } as PendingSwap, NOW)).toBe(false);
  });

  it("drops an otherwise-active swap whose expiresAt has passed", () => {
    expect(isActiveSwap({ id: "x", source: "swap_request", status: "open", expiresAt: past } as PendingSwap, NOW)).toBe(false);
  });

  it("keeps an active swap with no expiresAt", () => {
    expect(isActiveSwap({ id: "x", source: "offer", status: "pending" } as PendingSwap, NOW)).toBe(true);
  });
});
