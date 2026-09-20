// Account Settings as data — the page's rows, fallbacks, and the Evia tool behind each Edit.
import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({}) }) }) }), auth: () => ({}) }));
vi.mock("../membershipPage", () => ({ readMembershipPage: vi.fn() }));

import { shapeAccountSettingsPage } from "../accountSettingsPage";

const noMembership: any = { hasMembership: false, isActive: false, cancelScheduled: false, periodEnd: null, plan: { name: "Standard Plan", price: "$29.95/month" }, actions: ["select_plan"], summary: "" };
const activeMembership: any = { ...noMembership, hasMembership: true, isActive: true, periodEnd: "2026-10-17", actions: ["cancel", "manage"] };

describe("shapeAccountSettingsPage", () => {
  it("phone-OTP family: name and email come from the users doc when Auth has none (the page's 'Not set' bug, fixed 2026-09-19)", () => {
    const page = shapeAccountSettingsPage({
      uid: "u1",
      auth: { displayName: null, email: null, creationTime: "Sun, 06 Sep 2026 10:00:00 GMT", photoURL: null, googleEmail: null },
      doc: { firstName: "Hamse", lastName: "M", email: "hamse143@gmail.com", emailVerified: true, emailVerifiedFor: "hamse143@gmail.com", phone: "+14088745451", street: "4746 Campbell Ave", city: "San Jose", state: "CA", zipCode: "95130", identityCheckStatus: "verified" },
      membership: noMembership,
    });
    expect(page.name).toBe("Hamse M");
    expect(page.joined).toBe("09/06/2026");
    expect(page.recoveryEmail).toBe("hamse143@gmail.com");
    expect(page.phone).toBe("+14088745451");
    expect(page.location?.label).toBe("4746 Campbell Ave, San Jose, CA 95130");
    expect(page.identity).toEqual({ status: "verified", label: "Identity Verified" });
    expect(page.membership.label).toBe("None");
    expect(page.actions.map((a) => a.id)).toEqual(["upload_photo", "add_plan", "edit_email", "edit_phone", "edit_location", "delete_account"]);
    expect(page.actions.find((a) => a.id === "edit_phone")?.note).toContain("secure link goes to the recovery email");
    expect(page.recoveryEmailVerified).toBe(true);
    expect(page.summary).toContain("Recovery email: hamse143@gmail.com (confirmed).");
  });

  it("Auth wins for name and email; active membership shows renews date + Manage; unverified identity offers the check; blocked users listed with Unblock", () => {
    const page = shapeAccountSettingsPage({
      uid: "u2",
      auth: { displayName: "Ana Lopez", email: "ana@example.com", creationTime: null, photoURL: "https://x/y.jpg", googleEmail: "ana@example.com" },
      doc: { firstName: "Old", email: "old@example.com", careLocation: { address: "1 Main St", city: "Fremont", state: "CA", zip: "94536" }, blockedUsers: ["cg9", "cg8"], blockedUserProfiles: { cg9: { name: "Sam K", photo: "" } } },
      membership: activeMembership,
    });
    expect(page.name).toBe("Ana Lopez");
    expect(page.recoveryEmail).toBe("ana@example.com");
    expect(page.googleEmail).toBe("ana@example.com");
    expect(page.photoURL).toBe("https://x/y.jpg");
    expect(page.location?.label).toBe("1 Main St, Fremont, CA 94536");
    expect(page.membership.label).toBe("Standard Plan · renews 2026-10-17");
    expect(page.identity.label).toBe("Complete an identity check");
    expect(page.blockedUsers).toEqual([{ id: "cg9", name: "Sam K" }, { id: "cg8", name: "Blocked User" }]);
    const ids = page.actions.map((a) => a.id);
    expect(ids).toContain("manage_membership");
    expect(ids).toContain("identity_check");
    expect(ids).toContain("unblock");
    expect(ids).not.toContain("add_plan");
  });

  it("no recovery email → the phone edit is blocked with the page's own message", () => {
    const page = shapeAccountSettingsPage({ uid: "u3", auth: null, doc: { firstName: "Bo" }, membership: noMembership });
    expect(page.recoveryEmail).toBeNull();
    expect(page.actions.find((a) => a.id === "edit_phone")?.note).toContain("set a recovery email first");
    expect(page.location).toBeNull();
    expect(page.summary).toContain("Location: Not set.");
  });
});

describe("shapeAccountSettingsPage — recovery email confirmation (2026-09-20)", () => {
  it("an unconfirmed address shows as such, offers Resend, and blocks the phone edit the way the page does", () => {
    const page = shapeAccountSettingsPage({
      uid: "u1",
      auth: null,
      doc: { firstName: "Hamse", email: "hamse@icloud.com", phone: "+14088745451" },
      membership: noMembership,
    });
    expect(page.recoveryEmailVerified).toBe(false);
    expect(page.summary).toContain("Recovery email: hamse@icloud.com (NOT confirmed yet).");
    expect(page.actions.find((a) => a.id === "resend_email_confirmation")).toMatchObject({ tool: "request_email_change" });
    expect(page.actions.find((a) => a.id === "edit_phone")?.note).toContain("not confirmed yet");
    expect(page.actions.find((a) => a.id === "edit_email")?.note).toContain("confirmation link to the NEW address");
  });
  it("a confirmed address: no Resend row, and a change is approved from the current address first", () => {
    const page = shapeAccountSettingsPage({
      uid: "u1",
      auth: null,
      doc: { firstName: "Hamse", email: "hamse@icloud.com", emailVerified: true, emailVerifiedFor: "Hamse@icloud.com", phone: "+14088745451" },
      membership: noMembership,
    });
    expect(page.recoveryEmailVerified).toBe(true);
    expect(page.actions.find((a) => a.id === "resend_email_confirmation")).toBeUndefined();
    expect(page.actions.find((a) => a.id === "edit_email")?.note).toContain("CURRENT confirmed address approves first");
    expect(page.actions.find((a) => a.id === "edit_phone")?.note).toContain("secure link goes to the recovery email");
  });
});
