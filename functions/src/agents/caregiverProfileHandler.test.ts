import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updateMock = vi.fn().mockResolvedValue(undefined);
  const docGetMock = vi.fn().mockResolvedValue({ exists: true, data: () => ({ skills: ["Companionship"], services: ["Companionship"], specialties: ["Companionship"] }) });

  const docFn = vi.fn(() => ({ update: updateMock, get: docGetMock }));
  const collectionMock = vi.fn(() => ({ doc: docFn }));

  const sendMessage         = vi.fn().mockResolvedValue({ message_id: "x" });
  const parseWithClaude     = vi.fn();
  const quickComplete       = vi.fn();
  const generateCaraMessage = vi.fn().mockResolvedValue("ack");
  const generateToken       = vi.fn((..._args: unknown[]) => "token-abc");
  const backOut             = vi.fn(async (..._a: unknown[]) => false);

  return { updateMock, docGetMock, collectionMock, sendMessage, parseWithClaude, quickComplete, generateCaraMessage, generateToken, backOut };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { delete: vi.fn(() => "__DELETE__") },
  }),
}));

vi.mock("../linq/client", () => ({
  sendMessage: (...args: unknown[]) => hoisted.sendMessage(...args),
}));

vi.mock("../utils/parseWithClaude", () => ({
  parseWithClaude: (...args: unknown[]) => hoisted.parseWithClaude(...args),
}));

vi.mock("../utils/openaiClient", () => ({
  quickComplete: (...args: unknown[]) => hoisted.quickComplete(...args),
}));

vi.mock("../utils/caraMessage", () => ({
  generateCaraMessage: (...args: unknown[]) => hoisted.generateCaraMessage(...args),
}));

vi.mock("./tokenService", () => ({
  generateToken: (...args: unknown[]) => hoisted.generateToken(...args),
}));

// The shared back-out classifier is its own seam so the existing parse sequences stay put.
vi.mock("./stepHandler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stepHandler")>()),
  isBackOutRequest: (...args: unknown[]) => hoisted.backOut(...args),
}));

const { updateMock, sendMessage, parseWithClaude, docGetMock } = hoisted;

import { handleCaregiverProfileUpdate, profileFieldFromIntent, PROFILE_BACKED_OUT, RATES_Q, BIO_Q } from "./caregiverProfileHandler";

const CG_ID = "cg-1";
const PHONE = "+15555550100";
const CHAT  = "chat-1";

describe("caregiverProfileHandler", () => {
  beforeEach(() => {
    updateMock.mockClear();
    sendMessage.mockClear();
    parseWithClaude.mockReset();
    hoisted.quickComplete.mockReset();
    hoisted.backOut.mockReset();
    hoisted.backOut.mockResolvedValue(false);
    docGetMock.mockResolvedValue({ exists: true, data: () => ({ skills: ["Companionship"], services: ["Companionship"], specialties: ["Companionship"] }) });
  });

  describe("profileFieldFromIntent", () => {
    it("maps each profile-update intent to a field", () => {
      expect(profileFieldFromIntent("UPDATE_RATE")).toBe("rates"); // the page's Rates › Edit (2026-10-04)
      expect(profileFieldFromIntent("UPDATE_SKILLS")).toBe("skills");
      expect(profileFieldFromIntent("UPDATE_BIO")).toBe("bio");
      expect(profileFieldFromIntent("UPDATE_PHOTO")).toBe("photo");
      expect(profileFieldFromIntent("PAUSE_ACCOUNT")).toBe("pause");
      expect(profileFieldFromIntent("REACTIVATE")).toBe("reactivate");
      expect(profileFieldFromIntent("SOMETHING_ELSE")).toBeUndefined();
    });
  });

  // The page's Rates › Edit (CaregiverProfile.tsx): six fields saved together.
  describe("back-out (2026-10-17): \"never mind\" closes whichever editor is open, at collect or confirm", () => {
    it("collect step (rates) — flow cleared, nothing written, the router's own CANCEL line", async () => {
      hoisted.backOut.mockResolvedValueOnce(true);
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "never mind, leave my rate", { profileUpdateStep: "collect", profileUpdateField: "rates" }, CHAT);
      expect(hoisted.backOut).toHaveBeenCalledWith("never mind, leave my rate", RATES_Q);
      expect(sendMessage.mock.calls).toEqual([[CHAT, PROFILE_BACKED_OUT]]);
      expect(updateMock.mock.calls.at(-1)?.[0]).toMatchObject({ profileUpdateStep: "__DELETE__", profileUpdateField: "__DELETE__", profileUpdateValue: "__DELETE__" });
      expect(parseWithClaude).not.toHaveBeenCalled(); // checked before the editor re-asks
    });
    it("confirm step (bio) — same exit; the proposed bio is dropped, not saved", async () => {
      hoisted.backOut.mockResolvedValueOnce(true);
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "actually forget it", { profileUpdateStep: "confirm", profileUpdateField: "bio", profileUpdateValue: "A new bio." }, CHAT);
      expect(hoisted.backOut).toHaveBeenCalledWith("actually forget it", expect.stringMatching(/Reply YES to save this change/));
      expect(sendMessage.mock.calls).toEqual([[CHAT, PROFILE_BACKED_OUT]]);
      expect(updateMock.mock.calls.every((c) => !("bio" in c[0]))).toBe(true);
    });
    it("the entry text is never a back-out — no parked step, no classifier call", async () => {
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce('{"hourlyRate":28}');
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "change my rate to $28", {}, CHAT, "rates");
      expect(hoisted.backOut).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/Reply YES to save/);
    });
    it("a bio answer is not a back-out — collect proceeds to the confirm", async () => {
      parseWithClaude.mockResolvedValueOnce("NO");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "I have ten years of experience with seniors and love what I do.", { profileUpdateStep: "collect", profileUpdateField: "bio" }, CHAT);
      expect(hoisted.backOut).toHaveBeenCalledWith(expect.any(String), BIO_Q);
      expect(updateMock.mock.calls.find((c) => c[0].profileUpdateStep === "confirm")?.[0].profileUpdateField).toBe("bio");
    });
  });

  describe("RATES flow", () => {
    it("collect step — a one-person rate lands on the draft; the whole section is read back; confirm parked", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")                      // isQuestionOrOther
        .mockResolvedValueOnce('{"hourlyRate":28}');      // the change

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "change my rate to $28", {}, CHAT, "rates");

      const parked = updateMock.mock.calls.find(c => c[0].profileUpdateStep === "confirm")?.[0];
      expect(parked.profileUpdateField).toBe("rates");
      expect(JSON.parse(parked.profileUpdateValue)).toMatchObject({ hourlyRate: 28, maxClients: "1" });
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain("1 Person: $28/hr");
      expect(text).toContain("Up to 1 client at once");
      expect(text).toMatch(/Reply YES to save/);
    });

    it("collect step — only zero is refused (the rate is theirs — no floor, no ceiling, 2026-10-04)", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"hourlyRate":0}');

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "make it zero", {}, CHAT, "rates");

      expect(sendMessage.mock.calls[0][1]).toMatch(/more than \$0/);
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm" }));
    });

    it("confirm step — another change updates the draft (2 people + experience) and re-reads the section", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")        // isQuestionOrOther
        .mockResolvedValueOnce("CHANGE")    // decision
        .mockResolvedValueOnce('{"rateFor2":32,"experience":"3-5 years"}');
      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "and 32 for two people, I have 4 years",
        { profileUpdateStep: "confirm", profileUpdateField: "rates", profileUpdateValue: JSON.stringify({ hourlyRate: 28 }) },
        CHAT, "rates",
      );
      const parked = updateMock.mock.calls.find(c => c[0].profileUpdateStep === "confirm")?.[0];
      expect(JSON.parse(parked.profileUpdateValue)).toMatchObject({ hourlyRate: 28, rateFor2: 32, experience: "3-5 years" });
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain("2 People: $32/hr");
      expect(text).toContain("3-5 years experience");
    });

    it("confirm step YES writes the page's six fields together", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES"); // decision

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "yes save it",
        { profileUpdateStep: "confirm", profileUpdateField: "rates", profileUpdateValue: JSON.stringify({ hourlyRate: 28, rateFor2: 32, rateFor3: 0, experience: "3-5 years", maxClients: "2" }) },
        CHAT, "rates",
      );

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        hourlyRate: 28, rateFor2Seniors: 32, rateFor3PlusSeniors: 0, yearsExperience: "3-5 years", experience: "3-5 years", maxClients: "2",
      }));
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "__DELETE__" }));
      expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("1 Person: $28/hr");
    });

    it("confirm step NO does NOT save", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce("NO"); // decision

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "never mind",
        { profileUpdateStep: "confirm", profileUpdateField: "rates", profileUpdateValue: JSON.stringify({ hourlyRate: 28 }) },
        CHAT, "rates",
      );

      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: 28 }));
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/weren't changed/);
    });

    it("a legacy session parked as 'rate' continues in the rates flow", async () => {
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateField: "rate", profileUpdateValue: JSON.stringify({ hourlyRate: 30 }) }, CHAT);
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: 30 }));
    });
  });

  // About › Edit — the page's six language pills.
  describe("LANGUAGES flow", () => {
    it("collect: names from the list are kept, off-list ones are left off and said so; YES writes languages", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"set","languages":["English","Spanish"],"other":["Klingon"]}');
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "English, Spanish and Klingon", {}, CHAT, "languages");
      const parked = updateMock.mock.calls.find(c => c[0].profileUpdateStep === "confirm")?.[0];
      expect(JSON.parse(parked.profileUpdateValue)).toEqual(["English", "Spanish"]);
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain('"Klingon" isn\'t one of the options');
      expect(text).toContain("Your languages will be: English, Spanish");

      parseWithClaude.mockReset();
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateField: "languages", profileUpdateValue: JSON.stringify(["English", "Spanish"]) }, CHAT);
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ languages: ["English", "Spanish"] }));
    });
  });

  // Weekly Availability › Looking for — one of the three pills, jobTypes: [id].
  describe("LOOKING FOR flow", () => {
    it("picks one job type and writes the page's one-element array on YES", async () => {
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("part-time");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "part time please", {}, CHAT, "jobtype");
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm", profileUpdateField: "jobtype", profileUpdateValue: "part-time" }));
      expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Looking for: Part-time");

      parseWithClaude.mockReset();
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateField: "jobtype", profileUpdateValue: "part-time" }, CHAT);
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ jobTypes: ["part-time"] }));
    });
  });

  // Location & Travel › Edit — 5 / 10 / 15 / 25 / 50 miles.
  describe("TRAVEL flow", () => {
    it("snaps to the page's options and writes serviceRadius on YES", async () => {
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("20");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "about 20 miles", {}, CHAT, "travel");
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm", profileUpdateField: "travel", profileUpdateValue: "15" }));

      parseWithClaude.mockReset();
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateField: "travel", profileUpdateValue: "15" }, CHAT);
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ serviceRadius: 15 }));
    });
  });

  // Child care (2026-10-18): the editor asks what care she provides; a child-list service widens it.
  describe("SKILLS flow — child care (careKinds derived from the services since 2026-10-19; no care-type line)", () => {
    it("\"add child care\" with child-list services parks services + derived careKinds, and YES writes careKinds too", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce('{"action":"add","skills":["supervision","homework help"],"careKinds":"child"}'); // direct hits → no mapper call
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "add child care — supervision and homework help", {}, CHAT, "skills");
      const parkedJson = updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue;
      const parked = JSON.parse(parkedJson);
      expect(parked.services).toEqual(["Companionship", "Supervision", "School & Homework"]); // existing senior service kept, menu order
      expect(parked.careKinds).toEqual(["senior", "child"]); // derived: Companionship (senior) + Supervision (child)
      expect(String(sendMessage.mock.calls.at(-1)?.[1])).not.toContain("You'd provide");

      parseWithClaude.mockReset();
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateField: "skills", profileUpdateValue: parkedJson }, CHAT);
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ services: parked.services, skills: parked.services, careKinds: ["senior", "child"] }));
    });

    it("\"remove child care\" unticks the child list's own services (Transportation stays — on both lists); careKinds follows (live 2026-10-19: it said nothing to change)", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ careKinds: ["senior", "child"], services: ["Companionship", "Transportation", "Bathing & Dressing"], skills: ["Companionship", "Transportation", "Bathing & Dressing"] }) });
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce('{"action":"remove","skills":[],"careKinds":"child"}');
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "Remove child care", {}, CHAT, "skills");
      const parkedJson = updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue;
      expect(parkedJson).toBeTruthy();
      const parked = JSON.parse(parkedJson);
      expect(parked.careKinds).toEqual(["senior"]);
      expect(parked.services).toEqual(["Companionship", "Transportation"]); // Bathing & Dressing (child list) dropped; Transportation stays (both lists)
      const sent = String(sendMessage.mock.calls.at(-1)?.[1]);
      expect(sent).toContain("Companionship, Transportation");
      expect(sent).not.toContain("senior care");
      expect(sent).not.toContain("nothing to change");
    });

    it("\"senior care only\" (replace) keeps only the senior list's services without naming one", async () => {
      docGetMock.mockResolvedValueOnce({ exists: true, data: () => ({ careKinds: ["senior", "child"], services: ["Companionship", "Bathing & Dressing"], skills: ["Companionship", "Bathing & Dressing"] }) });
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"replace","skills":[],"careKinds":"senior"}');
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "Can I change my account to senior care only", {}, CHAT, "skills");
      const parked = JSON.parse(updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue);
      expect(parked.careKinds).toEqual(["senior"]);
      expect(parked.services).toEqual(["Companionship"]);
    });

    it("\"add child care\" with no service named shows the child list and asks which — a kind is never saved on its own", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"add","skills":[],"careKinds":"child"}');
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "add child care", {}, CHAT, "skills");
      expect(updateMock.mock.calls.some(c => c[0].profileUpdateValue)).toBe(false);
      const sent = String(sendMessage.mock.calls.at(-1)?.[1]);
      expect(sent).toContain("Which of these would you like to add?\nSupervision\nBaby Care");
      expect(sent).not.toContain("Mobility Assistance");
    });

    it("an older parked array (pre-2026-10-18) still saves services, with careKinds derived from them", async () => {
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateField: "skills", profileUpdateValue: JSON.stringify(["Companionship"]) }, CHAT);
      const call = updateMock.mock.calls.find(c => c[0].services);
      expect(call?.[0]).toEqual({ services: ["Companionship"], skills: ["Companionship"], careKinds: ["senior"] });
    });
  });

  describe("SKILLS flow", () => {
    it("collect step — add: her words mapped onto the website's eight, off-list words left off and said so, read back by shown name", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")  // isQuestionOrOther
        .mockResolvedValueOnce('{"action":"add","skills":["dementia","hospice","pill reminders"]}')
        .mockResolvedValueOnce(JSON.stringify({ services: [], medical: [], unmapped: ["hospice"] })); // mapper (dementia + pill reminders are offline hits)

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "add dementia, hospice and pill reminders", {}, CHAT, "skills");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep:  "confirm",
        profileUpdateField: "skills",
      }));
      const proposedJson = updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue;
      const proposed = JSON.parse(proposedJson);
      expect(proposed.services).toEqual(["Dementia / Memory Care", "Medication Reminders", "Companionship"]); // existing kept, menu order, nothing raw (parked as {services, careKinds} since 2026-10-18)
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain('"hospice" isn\'t one of the services on the list');
      expect(text).toContain("Your services will be: Dementia / Memory Care, Medication Reminders Only, Companionship");
      expect(text).toContain("Reply YES");
    });

    it("confirm YES writes the one list to services + skills (+ careKinds derived from them, 2026-10-19) — the page's write, nothing more", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateValue: JSON.stringify(["Companionship", "Personal Care"]) }, CHAT, "skills");
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        services: ["Personal Care", "Companionship"], skills: ["Personal Care", "Companionship"],
      }));
      const write = updateMock.mock.calls.find(c => c[0].services)?.[0];
      expect(Object.keys(write).sort()).toEqual(["careKinds", "services", "skills"]);
      expect(write.careKinds).toEqual(["senior"]);
      expect(sendMessage.mock.calls.at(-1)?.[1]).toContain("Done — your services now read: Personal Care, Companionship");
    });

    it("medical care is never added — steered to Medication Reminders Only with the menu, nothing proposed", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"add","skills":["giving insulin shots"]}')
        .mockResolvedValueOnce(JSON.stringify({ services: [], medical: ["giving insulin shots"], unmapped: [] }));
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "add giving insulin shots", {}, CHAT, "skills");
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm" }));
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain("don't administer medication");
      expect(text).toContain("Medication Reminders Only");
      expect(text).toContain("Mobility Assistance\nDementia / Memory Care\nMedication Reminders Only");
    });

    it("adding Transportation saves like any other service — no documents gate (MVR only, 2026-10-06)", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"add","skills":["transportation"]}');
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "add transportation", {}, CHAT, "skills");
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm" }));
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).not.toMatch(/driver's license|upload|document/i);
    });

    it("collect step — remove action", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"remove","skills":["companionship"]}');

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "remove companionship", {}, CHAT, "skills");

      const proposedJson = updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue;
      const proposed = JSON.parse(proposedJson);
      expect(proposed.services).toEqual([]);
    });
  });

  describe("BIO flow", () => {
    it("collect step — accepts text >= 15 chars and advances to confirm", async () => {
      parseWithClaude.mockResolvedValueOnce("NO"); // isQuestionOrOther

      const newBio = "Compassionate CNA with 8 years of dementia experience.";
      await handleCaregiverProfileUpdate(CG_ID, PHONE, newBio, {}, CHAT, "bio");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep:  "confirm",
        profileUpdateField: "bio",
        profileUpdateValue: newBio,
      }));
    });

    it("collect step — a short bio is accepted (the page has no minimum); only an empty one re-asks", async () => {
      parseWithClaude.mockResolvedValueOnce("NO");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "hi", {}, CHAT, "bio");
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm", profileUpdateValue: "hi" }));
    });
  });

  describe("PAUSE flow", () => {
    it("collect step — parses until date and advances to confirm", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO") // isQuestionOrOther
        .mockResolvedValueOnce('{"until":"2026-07-12"}');

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "going on vacation until July 12", {}, CHAT, "pause");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        profileUpdateStep:  "confirm",
        profileUpdateField: "pause",
        profileUpdateValue: "2026-07-12",
      }));
      expect(sendMessage.mock.calls[0][1]).toMatch(/until 2026-07-12/);
    });

    it("confirm YES writes pausedUntil to care provider doc", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "yes",
        { profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: "2026-07-12" },
        CHAT, "pause",
      );

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pausedUntil: "2026-07-12",
      }));
    });

    it("indefinite pause writes a far-future date", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce("YES");

      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "yes",
        { profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: "indefinite" },
        CHAT, "pause",
      );

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pausedUntil: "2099-12-31",
      }));
    });
  });

  describe("REACTIVATE flow", () => {
    it("clears pausedUntil and acknowledges", async () => {
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "reactivate", {}, CHAT, "reactivate");

      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        pausedUntil: "__DELETE__",
      }));
    });
  });

  // Founder 2026-10-11: a mid-flow question is answered FROM what is on the screen (the step's question / recap) plus
  // the section's real facts — never a static sentence — and the step's question is re-asked. Nothing is written.
  describe("mid-flow questions are answered from the screen", () => {
    const briefing = () => String(hoisted.quickComplete.mock.calls.at(-1)?.[0]);
    it("pause confirm — 'will I lose bookings?' is briefed with the Settings page's facts (nothing cancelled, reversible), then re-asked", async () => {
      parseWithClaude.mockResolvedValueOnce("YES"); // isQuestionOrOther → a question
      hoisted.quickComplete.mockResolvedValueOnce("No — your existing bookings stay exactly as they are.");
      await handleCaregiverProfileUpdate(
        CG_ID, PHONE, "will I lose my bookings?",
        { profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: "2026-07-12" },
        CHAT, "pause",
      );
      expect(sendMessage.mock.calls.at(-1)?.[1]).toBe("No — your existing bookings stay exactly as they are.\n\nPause your account until 2026-07-12? Reply YES to pause, or NO to cancel.");
      expect(briefing()).toContain("Audience: care provider");
      expect(briefing()).toContain("Pause your account until 2026-07-12? Reply YES to pause, or NO to cancel.");
      expect(briefing()).toContain("It does NOT cancel anything that already exists");
      expect(briefing()).toContain("Fully reversible anytime: text REACTIVATE, or use the Reactivate button on the Account Settings page");
      expect(briefing()).toContain("Nothing is paused until the care provider replies YES");
      expect(briefing()).toContain("NEVER say you changed, updated, saved, fixed, cancelled, sent or removed anything");
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ pausedUntil: expect.anything() }));
    });
    it("rates — the rule is any amount above $0 ($25 only an example) and the section as it reads now", async () => {
      parseWithClaude.mockResolvedValueOnce("YES");
      hoisted.quickComplete.mockResolvedValueOnce("Any amount above $0 — it's your number.");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "is there a minimum rate?", {}, CHAT, "rates");
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/^Any amount above \$0 — it's your number\.\n\nWhat would you like to change — your rate for 1 person/);
      expect(briefing()).toContain("Your rate has to be more than $0 — any amount above $0 is fine, there is no floor and no ceiling; $25 is only an example.");
      expect(briefing()).toContain("The Rates section currently reads:\nNo rate set yet.\nUp to 1 client at once");
      expect(briefing()).toContain("YES saves the whole section together, like the page's Save");
    });
    it("bio confirm — this editor has no minimum (the signup questionnaire's 150 is named as such); the proposed bio is the screen", async () => {
      parseWithClaude.mockResolvedValueOnce("YES");
      hoisted.quickComplete.mockResolvedValueOnce("No minimum here — it's saved as written.");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "is it long enough?", { profileUpdateStep: "confirm", profileUpdateField: "bio", profileUpdateValue: "Warm and patient." }, CHAT, "bio");
      expect(sendMessage.mock.calls.at(-1)?.[1]).toBe("No minimum here — it's saved as written.\n\nSo — want me to save this bio?\n\n\"Warm and patient.\"");
      expect(briefing()).toContain("This editor has no minimum length (the signup questionnaire asked for at least 150 characters)");
      expect(briefing()).toContain("\"Warm and patient.\"");
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ bio: expect.anything() }));
    });
    it("services / languages / looking for / travel — each briefed with its own list and the save rule", async () => {
      parseWithClaude.mockResolvedValueOnce("YES"); hoisted.quickComplete.mockResolvedValueOnce("A.");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "can I add wound care?", {}, CHAT, "skills");
      expect(briefing()).toContain("senior care: Mobility Assistance"); // both lists are briefed since 2026-10-18
      expect(briefing()).toContain("child care: Supervision");
      expect(briefing()).toContain("Medication Reminders Only means reminding when it is time, never giving medication");
      parseWithClaude.mockResolvedValueOnce("YES"); hoisted.quickComplete.mockResolvedValueOnce("A.");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "is Somali on the list?", {}, CHAT, "languages");
      expect(briefing()).toContain("The languages are chosen from this list only:");
      expect(briefing()).toContain("at least one language stays on the profile");
      parseWithClaude.mockResolvedValueOnce("YES"); hoisted.quickComplete.mockResolvedValueOnce("A.");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "can I pick two?", {}, CHAT, "jobtype");
      expect(briefing()).toContain("Looking for is ONE choice from:");
      parseWithClaude.mockResolvedValueOnce("YES"); hoisted.quickComplete.mockResolvedValueOnce("A.");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "measured from where?", {}, CHAT, "travel");
      expect(briefing()).toContain("measured from the address in Account Settings");
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm" }));
    });
    it("a failed YES/NO parse at a confirm re-asks the recap — it never saves, pauses or clears the flow", async () => {
      // services
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("__parse_error__");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "mm", { profileUpdateStep: "confirm", profileUpdateField: "skills", profileUpdateValue: JSON.stringify(["Companionship"]) }, CHAT, "skills");
      expect(sendMessage.mock.calls.at(-1)?.[1]).toBe("So — save these services: Companionship? Reply YES or NO.");
      // pause
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("__parse_error__");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "mm", { profileUpdateStep: "confirm", profileUpdateField: "pause", profileUpdateValue: "indefinite" }, CHAT, "pause");
      expect(sendMessage.mock.calls.at(-1)?.[1]).toBe("Pause your account indefinitely? Reply YES to pause, or NO to cancel.");
      // bio
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("__parse_error__");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "mm", { profileUpdateStep: "confirm", profileUpdateField: "bio", profileUpdateValue: "Warm." }, CHAT, "bio");
      expect(sendMessage.mock.calls.at(-1)?.[1]).toBe("So — want me to save this bio?\n\n\"Warm.\"");
      // rates
      parseWithClaude.mockResolvedValueOnce("NO").mockResolvedValueOnce("__parse_error__");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "mm", { profileUpdateStep: "confirm", profileUpdateField: "rates", profileUpdateValue: JSON.stringify({ hourlyRate: 28 }) }, CHAT, "rates");
      expect(sendMessage.mock.calls.at(-1)?.[1]).toMatch(/^Your Rates section would read:\n1 Person: \$28\/hr/);
      expect(updateMock).not.toHaveBeenCalled(); // no write, no clear — the flow stays parked as it was
    });
  });

  describe("PHOTO flow", () => {
    it("sends a web upload link", async () => {
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "change my photo", {}, CHAT, "photo");

      // First call is the intro text, second is the link
      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
      const linkMsg = sendMessage.mock.calls.at(-1)?.[1];
      expect(linkMsg).toEqual(expect.objectContaining({
        parts: expect.arrayContaining([expect.objectContaining({ type: "link" })]),
      }));
    });
  });
});
