import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Account Settings page, texted (caregiverSettings.ts): the page's
// reads (merged profile, blocked users, pause), its sections word for word, and
// the keywords = its buttons. Documents section retired 2026-10-06 (MVR only).

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  sent: [] as string[],
  resend: vi.fn(async () => ({ sentTo: "hamse143@gmail.com" })),
  linkResult: { success: true, linkType: "caregiver_photo", sent: true } as any,
  pause: vi.fn(async () => {}),
  reactivate: vi.fn(async () => {}),
  updates: [] as Array<{ path: string; data: any }>,
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({ doc: (id: string) => ({
      get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
      update: vi.fn(async (data: any) => { hoisted.updates.push({ path: `${name}/${id}`, data }); }),
    }) }),
  }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
// The SETTINGS page goes out as a text part flagged keepPii (her own recovery email stays whole) — capture its text either way.
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string | { parts?: Array<{ value?: string }> }) => { hoisted.sent.push(typeof m === "string" ? m : (m?.parts ?? []).map((p) => p.value ?? "").join("\n")); return { message_id: "m" }; }) }));
vi.mock("../../accountRecovery", () => ({
  isEmailVerified: (d: any) => d?.emailVerified === true && !!d?.email && String(d.emailVerifiedFor ?? "").toLowerCase() === String(d.email).toLowerCase(),
  resendEmailConfirmation: (...a: any[]) => (hoisted.resend as any)(...a),
  maskEmail: (e: string) => e.replace(/^(..).*@/, "$1***@"),
}));
vi.mock("../actions/sendOnboardingLinkAction", () => ({ runSendOnboardingLinkAction: vi.fn(async () => hoisted.linkResult) }));
vi.mock("../pauseAccount", () => ({ pauseCaregiver: (...a: any[]) => (hoisted.pause as any)(...a), reactivateCaregiver: (...a: any[]) => (hoisted.reactivate as any)(...a) }));

import { loadSettingsPage, settingsPageText, handleSettingsKeyword, GENDER_OPTIONS } from "../caregiverSettings";
import { DRIVER_CARD_TEXT } from "../caregiverMembership";

beforeEach(() => {
  hoisted.docs.clear(); hoisted.sent.length = 0; hoisted.resend.mockClear(); hoisted.pause.mockClear(); hoisted.reactivate.mockClear();
  hoisted.linkResult = { success: true, linkType: "caregiver_photo", sent: true };
  hoisted.docs.set("users/cg1", { email: "old@x.com", blockedUsers: ["u9"], blockedUserProfiles: { u9: { name: "Pat Lee" } } });
  hoisted.docs.set("caregivers/cg1", {
    name: "Mahad", createdAt: "2026-09-26T18:00:00.000Z", email: "hamse143@gmail.com", emailVerified: false, phone: "+14088745451",
    street: "20 Descanso dr", zipCode: "95134", city: "san jose", state: "CA", skills: ["Companionship"],
  });
});

describe("loadSettingsPage — the page's reads", () => {
  it("merges users + care providers with the care provider doc winning; member since in the page's numeric format; confirmed-email rule; blocked names", async () => {
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
});

describe("settingsPageText — the sections word for word", () => {
  it("account basics, the Membership & verification section (moved from Payments, 2026-10-04), no documents section without Transportation, blocked names, the pause card, the delete line", async () => {
    const t = settingsPageText(await loadSettingsPage("cg1"));
    expect(t).toBe([
      "Account Settings", "",
      "Account Basics · Member since 9/26/2026",
      "First name: Mahad", "Last name: not set", "Date of birth: not set",
      `Gender: not set (tell me to set it: ${GENDER_OPTIONS.join(", ")})`,
      "Recovery email: hamse143@gmail.com (Not confirmed yet, reply RESEND EMAIL LINK)",
      "Phone number: +14088745451 (to change it, tell me, and a secure link goes to your recovery email)",
      "Address: 20 Descanso dr, san jose, CA, 95134 (tell me a new address to update it)",
      "",
      "Membership & verification",
      // this fixture has no membershipStatus → the section's not-active state
      "No active membership",
      "Activate your membership to start accepting bookings and applying for jobs.",
      "Say activate and I'll send your membership link ($69.99/year).",
      "",
      "Background check: Starts right after your membership is active, it's included in the annual fee.",
      "",
      DRIVER_CARD_TEXT.offer,
      "",
      "Blocked Users: Pat Lee (tell me to unblock someone)",
      "",
      "Pause your account: taking a break? Stop showing up for new matches without deleting your profile. Reversible anytime. Reply PAUSE, or PAUSE 2026-11-01 to resume on a date.",
      "",
      "Deleting your account is permanent and cannot be undone. To delete it, tell me and I'll confirm with you first.",
    ].join("\n"));
  });
  it("Transportation offered → NO documents section (MVR only, 2026-10-06); legacy documents data is ignored; confirmed email; paused states", async () => {
    hoisted.docs.set("caregivers/cg1", {
      name: "Mahad Ali", createdAt: "2026-09-26T18:00:00.000Z", email: "a@b.com", emailVerified: true, emailVerifiedFor: "A@B.com", skills: ["Transportation"],
      documents: { driversLicense: { url: "u", status: "approved", expirationDate: "2027-03-03" }, insurance: { url: "u", status: "pending" } },
      pausedUntil: "2026-11-01",
    });
    hoisted.docs.set("users/cg1", {});
    const t = settingsPageText(await loadSettingsPage("cg1"));
    expect(t).toContain("First name: Mahad\nLast name: Ali");
    expect(t).toContain("Recovery email: a@b.com (Confirmed)");
    expect(t).toContain("Membership & verification");
    expect(t).not.toMatch(/document|DOCUMENTS|upload|Expires/i);
    expect(t).toContain("Blocked Users: You haven't blocked anyone.");
    expect(t).toContain("Your account is paused. You'll automatically become active again on 2026-11-01. Reactivate sooner anytime. Reply REACTIVATE.");
    hoisted.docs.set("caregivers/cg1", { pausedUntil: "2099-12-31" });
    expect(settingsPageText(await loadSettingsPage("cg1"))).toContain("Your account is paused. You won't show up for new matches until you reactivate. Fully reversible anytime. Reply REACTIVATE.");
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
  it("PAUSE never writes on the keyword alone (A6, 2026-10-11): bare PAUSE asks until when, PAUSE <date> asks YES/NO — the same parked pause flow as the tool path; a past date is refused; REACTIVATE = the page's button; other words pass through", async () => {
    hoisted.updates.length = 0;
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "pause")).toBe("handled");
    expect(hoisted.pause).not.toHaveBeenCalled();
    expect(hoisted.updates.at(-1)).toMatchObject({ path: "agent_sessions/+1", data: { profileUpdateStep: "collect", profileUpdateField: "pause" } });
    expect(typeof hoisted.updates.at(-1)!.data.stateExpiresAt).toBe("string");
    expect(hoisted.sent.at(-1)).toBe("When would you like to pause until? (e.g. \"until July 12\", \"for two weeks\", \"indefinitely\")");
    await handleSettingsKeyword("+1", "chat", "cg1", "PAUSE 2099-01-15");
    expect(hoisted.pause).not.toHaveBeenCalled();
    expect(hoisted.updates.at(-1)).toMatchObject({ path: "agent_sessions/+1", data: { profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: "2099-01-15" } });
    expect(hoisted.sent.at(-1)).toBe("Pause your account until 2099-01-15? You won't receive job matches during this time. Reply YES to pause, or NO to cancel.");
    await handleSettingsKeyword("+1", "chat", "cg1", "pause 2020-01-01");
    expect(hoisted.sent.at(-1)).toContain("That date has already passed");
    expect(hoisted.pause).not.toHaveBeenCalled();
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "REACTIVATE")).toBe("handled");
    expect(hoisted.reactivate).toHaveBeenCalledWith("cg1", { phone: "+1" }); // this door texts its own line → the write stamps the session (B7)
    expect(hoisted.sent.at(-1)).toBe("You're active again — you'll start showing up for new matches.");
    expect(await handleSettingsKeyword("+1", "chat", "cg1", "what's my rate")).toBe("passthrough");
  });
});
