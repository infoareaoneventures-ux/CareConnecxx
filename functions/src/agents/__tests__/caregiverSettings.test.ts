import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Account Settings page, texted (caregiverSettings.ts): the page's
// reads (merged profile, documents map with the page's status rule, blocked
// users, pause), its sections word for word, and the keywords = its buttons.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  sent: [] as string[],
  resend: vi.fn(async () => ({ sentTo: "hamse143@gmail.com" })),
  linkResult: { success: true, linkType: "caregiver_transport_docs", sent: true } as any,
  pause: vi.fn(async () => {}),
  reactivate: vi.fn(async () => {}),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({ doc: (id: string) => ({ get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })) }) }),
  }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../accountRecovery", () => ({
  isEmailVerified: (d: any) => d?.emailVerified === true && !!d?.email && String(d.emailVerifiedFor ?? "").toLowerCase() === String(d.email).toLowerCase(),
  resendEmailConfirmation: (...a: any[]) => (hoisted.resend as any)(...a),
  maskEmail: (e: string) => e.replace(/^(..).*@/, "$1***@"),
}));
vi.mock("../actions/sendOnboardingLinkAction", () => ({ runSendOnboardingLinkAction: vi.fn(async () => hoisted.linkResult) }));
vi.mock("../pauseAccount", () => ({ pauseCaregiver: (...a: any[]) => (hoisted.pause as any)(...a), reactivateCaregiver: (...a: any[]) => (hoisted.reactivate as any)(...a) }));

import { loadSettingsPage, settingsPageText, resolveDocStatus, handleSettingsKeyword, GENDER_OPTIONS } from "../caregiverSettings";
import { DRIVER_CARD_TEXT } from "../caregiverMembership";

beforeEach(() => {
  hoisted.docs.clear(); hoisted.sent.length = 0; hoisted.resend.mockClear(); hoisted.pause.mockClear(); hoisted.reactivate.mockClear();
  hoisted.linkResult = { success: true, linkType: "caregiver_transport_docs", sent: true };
  hoisted.docs.set("users/cg1", { email: "old@x.com", blockedUsers: ["u9"], blockedUserProfiles: { u9: { name: "Pat Lee" } } });
  hoisted.docs.set("caregivers/cg1", {
    name: "Mahad", createdAt: "2026-09-26T18:00:00.000Z", email: "hamse143@gmail.com", emailVerified: false, phone: "+14088745451",
    street: "20 Descanso dr", zipCode: "95134", city: "san jose", state: "CA", skills: ["Companionship"],
  });
});

describe("loadSettingsPage — the page's reads", () => {
  it("merges users + caregivers with the caregiver doc winning; member since in the page's numeric format; confirmed-email rule; blocked names", async () => {
    const p = await loadSettingsPage("cg1");
    expect(p.memberSince).toBe("9/26/2026");
    expect(p.firstName).toBe("Mahad"); expect(p.lastName).toBe("");
    expect(p.email).toBe("hamse143@gmail.com"); // caregiver doc wins over users.email
    expect(p.emailVerified).toBe(false);
    expect(p.address).toEqual({ street: "20 Descanso dr", zip: "95134", city: "san jose", state: "CA" });
    expect(p.hasTransportation).toBe(false);
    expect(p.blocked).toEqual(["Pat Lee"]);
    expect(p.isPaused).toBe(false);
  });
  it("resolveDocStatus = the page's rule: no url → idle; approved past expiry → expired; rejected; else under review", () => {
    expect(resolveDocStatus(undefined)).toBe("idle");
    expect(resolveDocStatus({ url: "u", status: "approved", expirationDate: "2020-01-01" })).toBe("expired");
    expect(resolveDocStatus({ url: "u", status: "approved", expirationDate: "2099-01-01" })).toBe("approved");
    expect(resolveDocStatus({ url: "u", status: "approved" })).toBe("approved");
    expect(resolveDocStatus({ url: "u", status: "rejected" })).toBe("rejected");
    expect(resolveDocStatus({ url: "u", status: "pending" })).toBe("done");
  });
});

describe("settingsPageText — the sections word for word", () => {
  it("account basics, the Membership & verification section (moved from Payments, 2026-10-04), no documents section without Transportation, blocked names, the pause card, the delete line", async () => {
    const t = settingsPageText(await loadSettingsPage("cg1"));
    expect(t).toBe([
      "Account Settings", "",
      "Account Basics · Member since 9/26/2026",
      "First name: Mahad", "Last name: —", "Date of birth: —",
      `Gender: — (tell me to set it: ${GENDER_OPTIONS.join(", ")})`,
      "Recovery email: hamse143@gmail.com — Not confirmed yet (reply RESEND EMAIL LINK)",
      "Phone number: +14088745451 (to change it, tell me — a secure link goes to your recovery email)",
      "Address: 20 Descanso dr, san jose, CA, 95134 (tell me a new address to update it)",
      "",
      "Membership & verification",
      // this fixture has no membershipStatus → the section's not-active state
      "No active membership",
      "Activate your membership to start accepting bookings and applying for jobs.",
      "Reply ACTIVATE for your membership link ($69.99/year).",
      "",
      "Background check: Starts right after your membership is active — it's included in the annual fee.",
      "",
      DRIVER_CARD_TEXT.offer,
      "",
      "Blocked Users: Pat Lee (tell me to unblock someone)",
      "",
      "Pause your account — Taking a break? Stop showing up for new matches without deleting your profile. Reversible anytime. Reply PAUSE, or PAUSE 2026-11-01 to resume on a date.",
      "",
      "Deleting your account is permanent and cannot be undone. To delete it, tell me and I'll confirm with you first.",
    ].join("\n"));
  });
  it("Transportation offered → the documents section with the page's statuses, Expires, the all-three note and the DOCUMENTS line; confirmed email; paused states", async () => {
    hoisted.docs.set("caregivers/cg1", {
      name: "Mahad Ali", createdAt: "2026-09-26T18:00:00.000Z", email: "a@b.com", emailVerified: true, emailVerifiedFor: "A@B.com", skills: ["Transportation"],
      documents: { driversLicense: { url: "u", status: "approved", expirationDate: "2027-03-03" }, insurance: { url: "u", status: "pending" } },
      pausedUntil: "2026-11-01",
    });
    hoisted.docs.set("users/cg1", {});
    const t = settingsPageText(await loadSettingsPage("cg1"));
    expect(t).toContain("First name: Mahad\nLast name: Ali");
    expect(t).toContain("Recovery email: a@b.com — Confirmed");
    expect(t).toContain("Transportation Documents — Required to offer Transportation. Keep these up to date.\nDriver's License: Approved · Expires 3/3/2027\nVehicle Insurance: Under Review\nVehicle Registration: Not uploaded\nAll three documents are required to activate the transportation badge.\nReply DOCUMENTS for your upload link.");
    expect(t).toContain("Blocked Users: You haven't blocked anyone.");
    expect(t).toContain("Your account is paused — You'll automatically become active again on 2026-11-01. Reactivate sooner anytime. Reply REACTIVATE.");
    hoisted.docs.set("caregivers/cg1", { pausedUntil: "2099-12-31" });
    expect(settingsPageText(await loadSettingsPage("cg1"))).toContain("Your account is paused — You won't show up for new matches until you reactivate. Fully reversible anytime. Reply REACTIVATE.");
  });
});

describe("keywords — the page's buttons through the same server paths", () => {
  it("SETTINGS texts the page; RESEND EMAIL LINK = the page's resend (masked address; already-confirmed message)", async () => {
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "settings")).toBe("handled");
    expect(hoisted.sent[0]).toContain("Account Settings");
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "RESEND EMAIL LINK")).toBe("handled");
    expect(hoisted.resend).toHaveBeenCalledWith("cg1");
    expect(hoisted.sent[1]).toBe("Confirmation link re-sent to ha***@gmail.com — tap it from that inbox (check Junk too).");
    hoisted.resend.mockResolvedValueOnce({ sentTo: null } as any);
    await handleSettingsKeyword("+1", "chat", "cg1", "resend email");
    expect(hoisted.sent[2]).toBe("Your recovery email is already confirmed — nothing to resend.");
  });
  it("DOCUMENTS sends the upload link only when Transportation is offered (the section's own rule)", async () => {
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "DOCUMENTS")).toBe("handled");
    expect(hoisted.sent[0]).toContain("only apply when Transportation is one of your services");
    hoisted.docs.set("caregivers/cg1", { skills: ["Transportation"] });
    const { runSendOnboardingLinkAction } = await import("../actions/sendOnboardingLinkAction");
    await handleSettingsKeyword("+1", "chat", "cg1", "upload documents");
    expect(runSendOnboardingLinkAction).toHaveBeenCalledWith({ phone: "+1", linkType: "caregiver_transport_docs" }, { caller: "sms_agent", role: "caregiver", phone: "+1" });
  });
  it("PAUSE / PAUSE <date> / REACTIVATE = the page's buttons, the page's toasts; a past date is refused; other words pass through", async () => {
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "pause")).toBe("handled");
    expect(hoisted.pause).toHaveBeenCalledWith("cg1", "indefinite");
    expect(hoisted.sent.at(-1)).toBe("Account paused — you won't be shown for new matches until you reactivate.");
    await handleSettingsKeyword("+1", "chat", "cg1", "PAUSE 2099-01-15");
    expect(hoisted.pause).toHaveBeenLastCalledWith("cg1", "2099-01-15");
    expect(hoisted.sent.at(-1)).toBe("Account paused — you'll automatically become active again on 2099-01-15.");
    await handleSettingsKeyword("+1", "chat", "cg1", "pause 2020-01-01");
    expect(hoisted.sent.at(-1)).toContain("That date has already passed");
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "REACTIVATE")).toBe("handled");
    expect(hoisted.reactivate).toHaveBeenCalledWith("cg1");
    expect(hoisted.sent.at(-1)).toBe("You're active again — you'll start showing up for new matches.");
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "what's my rate")).toBe("passthrough");
  });
});
