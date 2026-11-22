import { describe, it, expect } from "vitest";
import { promptsAllowedOn } from "./promptRoutes";

describe("promptsAllowedOn", () => {
  it("allows the banners on signed-in app pages", () => {
    expect(promptsAllowedOn("/client/dashboard")).toBe(true);
    expect(promptsAllowedOn("/care-provider/bookings")).toBe(true);
  });
  it("never shows them on the public site, sign-up, consent, upload or payment pages", () => {
    for (const p of ["/", "/login", "/start", "/bgcheck", "/upload/photo", "/client/signup", "/care-provider/signup", "/client/membership", "/payment/success", "/stripe/callback", "/client/connect"]) {
      expect(promptsAllowedOn(p)).toBe(false);
    }
  });
});
