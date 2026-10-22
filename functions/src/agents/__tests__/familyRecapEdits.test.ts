import { describe, it, expect, vi } from "vitest";
import { applyRecapEdit, applyPendingPersonEdit, resolvePerson, readRecapEdit } from "../familyRecapEdits";
import { dataFromRoster, rosterFromData, type FamilyIntakeDeps } from "../familyIntakeScript";

function deps(parseReplies: string[] = []): FamilyIntakeDeps {
  return {
    parseWithClaude: vi.fn(async () => parseReplies.shift() ?? "{}"),
    isQuestionOrOther: vi.fn(async () => false),
    answerQuestionMidFlow: vi.fn(async () => ""),
    canonicalizeCareNeeds: vi.fn(async (terms: unknown) => {
      const map: Record<string, string> = { companionship: "Companionship", "meal prep": "Meal Preparation", "meal preparation": "Meal Preparation", supervision: "Supervision", "personal care": "Personal Care", insulin: "" , gardening: "" };
      const careNeeds: string[] = [], medical: string[] = [], unmapped: string[] = [];
      for (const w of (Array.isArray(terms) ? terms : [terms]).map((x) => String(x).toLowerCase())) { if (w === "insulin") medical.push(w); else if (map[w]) careNeeds.push(map[w]); else unmapped.push(w); }
      return { careNeeds, medical, unmapped };
    }),
    lookupZipPlace: vi.fn(async () => ({ city: "San Jose", state: "CA" })),
    evaluateServiceArea: vi.fn(() => "in" as const),
    parkOutOfArea: vi.fn(async () => {}),
    loadSiteData: vi.fn(async () => ({})),
    mergeOnboardingData: vi.fn(async () => {}),
    updateSession: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    sendRecap: vi.fn(async () => {}),
    isMedicationInstruction: () => false,
    medicationMessage: "",
    today: () => ({ iso: "2026-10-21", weekday: "Wednesday" }),
  };
}

const BASE = {
  firstName: "Hamse", lastName: "Client", careFrequency: "full_time", startDate: "2026-10-22", ongoing: true, selectedDays: ["MON"], timeOfDay: ["morning"],
  homeStreet: "4746 campbell ave", homeZipCode: "95130", sameAsHomeAddress: true, street: "4746 campbell ave", zipCode: "95130",
  rate: 32, caregiversNeeded: 1, emergencyContactName: "Mahad", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "sibling",
  careNeeds: ["Personal Care", "Supervision", "Baby Care"],
  ...dataFromRoster([{ relationship: "self", name: "Hamse Client" }, { relationship: "child", name: "Mahad C", ageRange: "toddler" }]),
};

describe("edits at the recap — anything but the account holder's name; care types one at a time", () => {
  it("renames the named person only (not the first person by default)", async () => {
    const r = await applyRecapEdit(deps(), BASE, { people: { rename: { from: "Mahad C", to: "Mahad K" } } });
    const roster = rosterFromData({ ...BASE, ...r.fields });
    expect(roster[0].name).toBe("Hamse Client");
    expect(roster[1].name).toBe("Mahad K");
    expect(r.rosterChanged).toBe(true);
  });

  it("asks whose name when two people are on the post and no one was named, then finishes with the reply", async () => {
    const r = await applyRecapEdit(deps(), BASE, { people: { rename: { to: "Mahad K" } } });
    expect(r.ask).toBe("Whose name — you or Mahad C?");
    expect(r.pending).toEqual({ kind: "rename", to: "Mahad K" });
    const done = applyPendingPersonEdit(BASE, r.pending!, "Mahad");
    expect(rosterFromData({ ...BASE, ...done.fields })[1].name).toBe("Mahad K");
  });

  it("never changes the account holder's own name", async () => {
    const r = await applyRecapEdit(deps(), BASE, { people: { rename: { from: "you", to: "Hamse Mahad" } } });
    expect(r.fields).toEqual({});
    expect(r.notes.join(" ")).toContain("your own name is set at signup");
    const one = { ...BASE, ...dataFromRoster([{ relationship: "self", name: "Hamse Client" }]) };
    const r2 = await applyRecapEdit(deps(), one, { people: { rename: { to: "Someone Else" } } });
    expect(r2.fields).toEqual({});
  });

  it("changes a child's stage, by name or the only child", async () => {
    const r = await applyRecapEdit(deps(), BASE, { people: { stage: { stage: "Preschooler" } } });
    expect(rosterFromData({ ...BASE, ...r.fields })[1].ageRange).toBe("3-5");
    expect(r.notes.join(" ")).toContain("Mahad C: Preschooler");
  });

  it("removes one person; never the last one", async () => {
    const r = await applyRecapEdit(deps(), BASE, { people: { remove: "Mahad C" } });
    expect(rosterFromData({ ...BASE, ...r.fields })).toHaveLength(1);
    const one = { ...BASE, ...dataFromRoster([{ relationship: "self", name: "Hamse Client" }]) };
    const r2 = await applyRecapEdit(deps(), one, { people: { remove: "you" } });
    expect(r2.fields).toEqual({});
    expect(r2.notes.join(" ")).toContain("at least one person");
  });

  it("care types: add one, remove one, unknown ones left off, never an empty list", async () => {
    const add = await applyRecapEdit(deps(), BASE, { careNeeds: { add: ["companionship"] } });
    expect(add.fields.careNeeds).toEqual(["Personal Care", "Supervision", "Baby Care", "Companionship"]);
    expect(add.notes.join(" ")).toContain("added Companionship");
    const remove = await applyRecapEdit(deps(), BASE, { careNeeds: { remove: ["supervision"] } });
    expect(remove.fields.careNeeds).toEqual(["Personal Care", "Baby Care"]);
    const notThere = await applyRecapEdit(deps(), BASE, { careNeeds: { remove: ["meal prep"] } });
    expect(notThere.fields.careNeeds).toBeUndefined();
    expect(notThere.notes.join(" ")).toContain("Meal Preparation wasn't on the list");
    const gardening = await applyRecapEdit(deps(), BASE, { careNeeds: { add: ["gardening"] } });
    expect(gardening.fields.careNeeds).toBeUndefined();
    expect(gardening.notes.join(" ")).toContain("gardening isn't one of the services");
    const emptied = await applyRecapEdit(deps(), { ...BASE, careNeeds: ["Supervision"] }, { careNeeds: { remove: ["supervision"] } });
    expect(emptied.fields.careNeeds).toBeUndefined();
    expect(emptied.notes.join(" ")).toContain("at least one care type");
  });

  it("every other field: frequency, start, days, time, rate, providers, pets, emergency contact, care address", async () => {
    const r = await applyRecapEdit(deps(), BASE, {
      careFrequency: "part-time", startDate: "2026-11-01", selectedDays: ["TUE", "THU"], timeOfDay: ["afternoon"], rate: "40", caregiversNeeded: 2,
      petsInHome: true, emergencyContactPhone: "6505633842", emergencyContactRelationship: "friend", street: "1 Main St", zipCode: "95112",
    });
    expect(r.fields).toMatchObject({ careFrequency: "part_time", startDate: "2026-11-01", selectedDays: ["TUE", "THU"], timeOfDay: ["afternoon"], rate: 40, caregiversNeeded: 2, petsInHome: true, emergencyContactPhone: "(650) 563-3842", emergencyContactRelationship: "friend", street: "1 Main St", zipCode: "95112", city: "San Jose", sameAsHomeAddress: false });
  });

  it("the photo: no field changes — the note says to send the picture; a changed home address carries the care address with it while care is at home", async () => {
    const r = await applyRecapEdit(deps(), BASE, { photo: true });
    expect(r.fields).toEqual({});
    expect(r.notes.join(" ")).toContain("send the new picture here");
    const moved = await applyRecapEdit(deps(), BASE, { homeStreet: "9 Oak St", homeZipCode: "95112" });
    expect(moved.fields).toMatchObject({ homeStreet: "9 Oak St", homeZipCode: "95112", street: "9 Oak St", zipCode: "95112", city: "San Jose", state: "CA" });
  });

  it("resolves a person by name, relationship word, or 'you'", () => {
    const roster = rosterFromData(BASE);
    expect(resolvePerson(roster, "mahad")).toEqual({ index: 1 });
    expect(resolvePerson(roster, "my child")).toBeNull(); // not a bare relationship word → no guess
    expect(resolvePerson(roster, "child")).toEqual({ index: 1 });
    expect(resolvePerson(roster, "you")).toEqual({ index: 0 });
    expect(resolvePerson(roster, "")).toEqual({ ambiguous: true });
  });

  it("readRecapEdit returns the structured edit from the one model read", async () => {
    const d = deps(['{"careNeeds":{"remove":["supervision"]},"people":{"rename":{"from":"Mahad C","to":"Mahad K"}}}']);
    const e = await readRecapEdit(d, "remove supervision and the name is Mahad K not Mahad C", BASE);
    expect(e?.careNeeds?.remove).toEqual(["supervision"]);
    expect(e?.people?.rename?.to).toBe("Mahad K");
  });
});
