import { describe, it, expect } from "vitest";
import { pageTitleFor } from "./pageTitle";

describe("pageTitleFor", () => {
  it("names each page so open tabs can be told apart", () => {
    expect(pageTitleFor("/client/calendar")).toBe("Calendar · Evia");
    expect(pageTitleFor("/care-provider/payments")).toBe("Payments · Evia");
    expect(pageTitleFor("/client/bookings/")).toBe("My bookings · Evia");
    expect(pageTitleFor("/admin/audit")).toBe("Audit · Evia");
    expect(pageTitleFor("/admin")).toBe("Admin · Evia");
    expect(pageTitleFor("/login")).toBe("Log in · Evia");
  });
  it("matches profile pages by prefix and prefers the more specific route", () => {
    expect(pageTitleFor("/client/care-provider/abc123")).toBe("Care provider · Evia");
    expect(pageTitleFor("/p/abc123")).toBe("Care provider · Evia");
    expect(pageTitleFor("/care-provider/dashboard")).toBe("Dashboard · Evia");
  });
  it("leaves the home page's own title alone and falls back to the brand for unknown paths", () => {
    expect(pageTitleFor("/")).toBeNull();
    expect(pageTitleFor("/some/unknown/page")).toBe("Evia");
  });
});
