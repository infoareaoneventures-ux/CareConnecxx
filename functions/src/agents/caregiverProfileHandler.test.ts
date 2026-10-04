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

  return { updateMock, docGetMock, collectionMock, sendMessage, parseWithClaude, quickComplete, generateCaraMessage, generateToken };
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

const { updateMock, sendMessage, parseWithClaude, docGetMock } = hoisted;

import { handleCaregiverProfileUpdate, profileFieldFromIntent } from "./caregiverProfileHandler";

const CG_ID = "cg-1";
const PHONE = "+15555550100";
const CHAT  = "chat-1";

describe("caregiverProfileHandler", () => {
  beforeEach(() => {
    updateMock.mockClear();
    sendMessage.mockClear();
    parseWithClaude.mockReset();
    hoisted.quickComplete.mockReset();
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
      expect(proposed).toEqual(["Dementia / Memory Care", "Medication Reminders", "Companionship"]); // existing kept, menu order, nothing raw
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain('"hospice" isn\'t one of the services on the list');
      expect(text).toContain("Your services will be: Dementia / Memory Care, Medication Reminders Only, Companionship");
      expect(text).toContain("Reply YES");
    });

    it("confirm YES writes the one list to services + skills — the page's write, nothing more", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")   // isQuestionOrOther
        .mockResolvedValueOnce("YES");
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "yes", { profileUpdateStep: "confirm", profileUpdateValue: JSON.stringify(["Companionship", "Personal Care"]) }, CHAT, "skills");
      expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
        services: ["Personal Care", "Companionship"], skills: ["Personal Care", "Companionship"],
      }));
      const write = updateMock.mock.calls.find(c => c[0].services)?.[0];
      expect(Object.keys(write).sort()).toEqual(["services", "skills"]);
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

    it("adding Transportation without the three documents does not save — the page's rule", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"add","skills":["transportation"]}');
      await handleCaregiverProfileUpdate(CG_ID, PHONE, "add transportation", {}, CHAT, "skills");
      expect(updateMock).not.toHaveBeenCalledWith(expect.objectContaining({ profileUpdateStep: "confirm" }));
      const text = sendMessage.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain("Upload your driver's license, vehicle insurance, and registration to offer transportation");
    });

    it("collect step — remove action", async () => {
      parseWithClaude
        .mockResolvedValueOnce("NO")
        .mockResolvedValueOnce('{"action":"remove","skills":["companionship"]}');

      await handleCaregiverProfileUpdate(CG_ID, PHONE, "remove companionship", {}, CHAT, "skills");

      const proposedJson = updateMock.mock.calls.find(c => c[0].profileUpdateValue)?.[0].profileUpdateValue;
      const proposed = JSON.parse(proposedJson);
      expect(proposed).toEqual([]);
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

    it("confirm YES writes pausedUntil to caregiver doc", async () => {
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
