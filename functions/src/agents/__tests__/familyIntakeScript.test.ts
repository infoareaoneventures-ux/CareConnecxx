import { describe, it, expect, vi } from "vitest";
import {
  nextFamilyStep, familyQuestion, rosterFromData, dataFromRoster, rosterPending, readRoster, runFamilyIntakeTurn,
  normalizeDayCodes, normalizeFrequency, describeRoster, MAX_RECIPIENTS, FAMILY_STEP_ORDER,
  type FamilyIntakeDeps, type RosterPerson,
} from "../familyIntakeScript";

// ── fakes ───────────────────────────────────────────────────────────────────
function makeDeps(parseQueue: string[] = [], site: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const merged: Record<string, unknown>[] = [];
  const sessionUpdates: Record<string, unknown>[] = [];
  let recapSent = 0;
  let parked: unknown = null;
  const deps: FamilyIntakeDeps = {
    parseWithClaude: vi.fn(async () => parseQueue.shift() ?? "unknown"),
    isQuestionOrOther: vi.fn(async () => false),
    answerQuestionMidFlow: vi.fn(async () => "Here's the answer."),
    canonicalizeCareNeeds: vi.fn(async (terms: unknown) => {
      const words = (Array.isArray(terms) ? terms : [terms]).map((t) => String(t).toLowerCase());
      const map: Record<string, string> = { "light housekeeping": "Light Housekeeping", "supervision": "Supervision", "homework": "School & Homework", "insulin": "" };
      const careNeeds: string[] = []; const medical: string[] = []; const unmapped: string[] = [];
      for (const w of words) { if (w === "insulin") medical.push(w); else if (map[w]) careNeeds.push(map[w]); else unmapped.push(w); }
      return { careNeeds, medical, unmapped };
    }),
    lookupZipPlace: vi.fn(async (zip: string) => (zip === "95130" ? { city: "San Jose", state: "CA" } : zip === "90210" ? { city: "Beverly Hills", state: "CA" } : null)),
    evaluateServiceArea: vi.fn(({ zip }) => (zip === "90210" ? "out" : "in")),
    parkOutOfArea: vi.fn(async (args) => { parked = args; }),
    loadSiteData: vi.fn(async () => site),
    mergeOnboardingData: vi.fn(async (_phone, fields) => { merged.push(fields); }),
    updateSession: vi.fn(async (_phone, u) => { sessionUpdates.push(u); }),
    sendMessage: vi.fn(async (_chat, text) => { sent.push(text); }),
    sendRecap: vi.fn(async (_p: string, _c: string, prefix?: string) => { recapSent++; sent.push(prefix ? `${prefix}\n\n[recap]` : "[recap]"); }),
    isMedicationInstruction: (t) => /insulin|dosage/i.test(t),
    medicationMessage: "Care providers here don't give medication.",
    today: () => ({ iso: "2026-10-20", weekday: "Tuesday" }),
  };
  return { deps, sent, merged, sessionUpdates, recap: () => recapSent, parked: () => parked };
}

const CHILD_ROSTER = '{"people":[{"relationship":"self","name":""},{"relationship":"child","name":""}]}';

describe("the family intake follows the site: one step list, first unanswered step next", () => {
  it("starts at frequency and walks the site's order", () => {
    expect(FAMILY_STEP_ORDER[0]).toBe("family_ask_name");
    expect(nextFamilyStep({})).toBe("family_ask_name"); // a cold text: the name once, first + last
    expect(nextFamilyStep({ firstName: "Hamse" })).toBe("family_ask_frequency");
    expect(nextFamilyStep({ firstName: "Hamse", careFrequency: "part_time" })).toBe("family_ask_home_address");
    const d: Record<string, unknown> = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "4746 Campbell Ave", homeZipCode: "95130" };
    expect(nextFamilyStep(d)).toBe("family_ask_care_address");
    d.sameAsHomeAddress = true;
    expect(nextFamilyStep(d)).toBe("family_ask_start");
    d.startDate = "2026-10-21";
    expect(nextFamilyStep(d)).toBe("family_ask_ongoing");
    d.ongoing = true;
    expect(nextFamilyStep(d)).toBe("family_ask_days");
    d.selectedDays = ["TUE"]; d.timeOfDay = ["morning"];
    expect(nextFamilyStep(d)).toBe("family_ask_photo");
    d.photoSkipped = true;
    expect(nextFamilyStep(d)).toBe("family_ask_recipients");
  });

  it("answers already on the site are never asked again", () => {
    const d = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["MON"], timeOfDay: ["morning"], photoSkipped: true, relationship: "parent", seniorName: "Rosa Diaz", rosterCountConfirmed: true, caregiversNeeded: 1 };
    expect(nextFamilyStep(d)).toBe("family_ask_emergency"); // the count was answered by text
  });

  it("the roster gate works like the site's step 10: a child needs a stage, Other needs adult or child, names before anything", () => {
    const base = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["MON"], timeOfDay: ["morning"], photoSkipped: true };
    // me + child: self needs nothing, the child needs a name then a stage
    const meAndChild = { ...base, ...dataFromRoster([{ relationship: "self", name: "Hamse" }, { relationship: "child", name: "" }]) };
    expect(nextFamilyStep(meAndChild)).toBe("family_ask_recipient_name");
    expect(familyQuestion("family_ask_recipient_name", meAndChild)).toBe("What's your child's name? First and last is best.");
    const named = { ...base, ...dataFromRoster([{ relationship: "self", name: "Hamse" }, { relationship: "child", name: "Mahad K" }]) };
    expect(nextFamilyStep(named)).toBe("family_ask_recipient_stage");
    expect(familyQuestion("family_ask_recipient_stage", named)).toContain("Mahad K");
    const stagedOpen = { ...base, ...dataFromRoster([{ relationship: "self", name: "Hamse" }, { relationship: "child", name: "Mahad K", ageRange: "toddler" }]) };
    expect(nextFamilyStep(stagedOpen)).toBe("family_ask_more_people"); // the cycle: asked again after each person until NO / a number / four
    const staged = { ...base, ...dataFromRoster([{ relationship: "self", name: "Hamse" }, { relationship: "child", name: "Mahad K", ageRange: "toddler" }]), rosterCountConfirmed: true };
    expect(nextFamilyStep(staged)).toBe("family_ask_providers_count"); // the site's "How many care providers do you need, 1 to 4?"
    expect(nextFamilyStep({ ...staged, caregiversNeeded: 1 })).toBe("family_ask_emergency");
    // ONE person named → the site's "How many people need care?" counter is asked before moving on
    const four = { ...base, ...dataFromRoster([{ relationship: "self", name: "H" }, { relationship: "parent", name: "A" }, { relationship: "parent", name: "B" }, { relationship: "spouse", name: "C" }]) };
    expect(nextFamilyStep(four)).toBe("family_ask_providers_count"); // four people: no further "anyone else?"
    const onlyMom = { ...base, ...dataFromRoster([{ relationship: "parent", name: "Rosa Diaz" }]) };
    expect(nextFamilyStep(onlyMom)).toBe("family_ask_more_people");
    expect(familyQuestion("family_ask_more_people", onlyMom)).toBe("Is there anyone else who needs care? If not, just say no. Otherwise tell me who.");
    expect(nextFamilyStep({ ...onlyMom, rosterCountConfirmed: true })).toBe("family_ask_providers_count");
    // a person the counter added, relationship still to be asked, in the site's words
    const placeholder = { ...base, ...dataFromRoster([{ relationship: "parent", name: "Rosa Diaz" }, { relationship: "unknown", name: "" }]), rosterCountConfirmed: true };
    expect(nextFamilyStep(placeholder)).toBe("family_ask_recipient_relationship");
    expect(familyQuestion("family_ask_recipient_relationship", placeholder)).toBe("What is your relationship to care recipient 2? Myself, Parent, Spouse or Partner, Adult child, Child, or Other.");
    // a bare "my son": child or adult son/daughter is ASKED, never guessed (the site's two buttons)
    const bareSon = { ...base, ...dataFromRoster([{ relationship: "child", name: "", kindUnknown: true }]) };
    expect(nextFamilyStep(bareSon)).toBe("family_ask_recipient_kind");
    expect(familyQuestion("family_ask_recipient_kind", bareSon)).toBe("Is your son or daughter a child, or an adult son or daughter?");
    // Other → adult or child first
    const other = { ...base, ...dataFromRoster([{ relationship: "other", name: "Nadia" }]) };
    expect(nextFamilyStep(other)).toBe("family_ask_recipient_kind");
    const otherChild = { ...base, ...dataFromRoster([{ relationship: "other", name: "Nadia", careKind: "child" }]) };
    expect(nextFamilyStep(otherChild)).toBe("family_ask_recipient_stage");
    // an adult child is an adult: no stage
    const adultChild = { ...base, ...dataFromRoster([{ relationship: "adult child", name: "Sam" }]), rosterCountConfirmed: true, caregiversNeeded: 1 };
    expect(nextFamilyStep(adultChild)).toBe("family_ask_emergency");
  });

  it("the roster round-trips through the stored shape (primary + additionalRecipients) and the self name is the account's", () => {
    const roster: RosterPerson[] = [{ relationship: "self", name: "Hamse Mahad" }, { relationship: "child", name: "Mahad K", ageRange: "toddler" }, { relationship: "parent", name: "" }];
    const d = dataFromRoster(roster);
    expect(d.relationship).toBe("self");
    expect(d.seniorName).toBe("Hamse Mahad");
    expect(d.additionalRecipients).toEqual([{ name: "Mahad K", relationship: "child", ageRange: "toddler" }, { name: "", relationship: "parent" }]);
    expect(rosterFromData(d)).toEqual(roster);
    expect(rosterPending(roster)).toEqual({ kind: "name", index: 2, person: roster[2] });
  });

  it("the needs question shows the lists for the people on the roster", () => {
    const both = dataFromRoster([{ relationship: "self", name: "Hamse" }, { relationship: "child", name: "Mahad", ageRange: "toddler" }]);
    const q = familyQuestion("family_ask_needs", both);
    expect(q).toContain("Senior care:");
    expect(q).toContain("Child care:");
    const childOnly = dataFromRoster([{ relationship: "child", name: "Mahad", ageRange: "toddler" }]);
    const q2 = familyQuestion("family_ask_needs", childOnly);
    expect(q2).not.toContain("Senior care:");
    expect(q2).toContain("Supervision");
  });

  it("after the care types, the site's pets / smoking checkboxes are asked once", () => {
    const d = { firstName: "H", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["MON"], timeOfDay: ["morning"], photoSkipped: true, ...dataFromRoster([{ relationship: "self", name: "H" }]), rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "s", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "cousin", careNeeds: ["Companionship"] };
    expect(nextFamilyStep(d)).toBe("family_ask_pets_smoking");
    expect(nextFamilyStep({ ...d, householdAsked: true })).toBe("family_ask_rate");
  });

  it("value rules: day codes, frequency words", () => {
    expect(normalizeDayCodes(["tuesday", "Mon", "fri"])).toEqual(["MON", "TUE", "FRI"]);
    expect(normalizeFrequency("Part-time")).toBe("part_time");
    expect(normalizeFrequency("occasional")).toBe("occasional");
    expect(normalizeFrequency("whenever")).toBeNull();
  });

  it("the recap names everyone with relationship and stage", () => {
    const d = dataFromRoster([{ relationship: "self", name: "Hamse" }, { relationship: "child", name: "Mahad K", ageRange: "toddler" }]);
    expect(describeRoster(d)).toBe("you and Mahad K (your child · Toddler)");
  });
});

describe("readRoster — who the care is for, read as a list (up to four, like the site)", () => {
  it('"me and my child" → Myself (account name) plus one child; never an adult-or-child question about the sender', async () => {
    const { deps } = makeDeps([CHILD_ROSTER]);
    const r = await readRoster(deps, "it's for me and my child", { first: "Hamse", last: "" });
    expect(r?.roster).toEqual([{ relationship: "self", name: "Hamse" }, { relationship: "child", name: "" }]);
    expect(r?.capped).toBe(false);
  });

  it('a bare "my son" is flagged to be asked; "my 3-year-old son" is a child; "my grown son" is an adult child', async () => {
    const { deps } = makeDeps([
      '{"people":[{"relationship":"son or daughter (age unknown)","name":""}]}',
      '{"people":[{"relationship":"child","name":"","stage":"Toddler"}]}',
      '{"people":[{"relationship":"adult child","name":"Sam"}]}',
    ]);
    const bare = await readRoster(deps, "my son", { first: "H", last: "" });
    expect(bare?.roster).toEqual([{ relationship: "child", name: "", kindUnknown: true }]);
    const toddler = await readRoster(deps, "my 3-year-old son", { first: "H", last: "" });
    expect(toddler?.roster).toEqual([{ relationship: "child", name: "", ageRange: "toddler" }]);
    const grown = await readRoster(deps, "my grown son Sam", { first: "H", last: "" });
    expect(grown?.roster).toEqual([{ relationship: "adult child", name: "Sam" }]);
  });

  it("five people are kept to four and flagged", async () => {
    const { deps } = makeDeps(['{"people":[{"relationship":"parent","name":"A"},{"relationship":"parent","name":"B"},{"relationship":"child","name":"C"},{"relationship":"child","name":"D"},{"relationship":"other","name":"E"}]}']);
    const r = await readRoster(deps, "all five of them", { first: "H", last: "" });
    expect(r?.roster.length).toBe(MAX_RECIPIENTS);
    expect(r?.capped).toBe(true);
  });
});

describe("runFamilyIntakeTurn — the whole conversation, scripted", () => {
  it("walks the site's order, saves every answer, mirrors as it goes, and ends on the recap", async () => {
    const parse = [
      "part_time",                                                       // frequency
      '{"street":"4746 Campbell Ave","zip":"95130"}',                    // home
      "{}",                                                              // side extraction (6-word message)
      "SAME",                                                            // care address
      "2026-10-21",                                                      // start
      "ONGOING",                                                         // ongoing
      '{"days":["TUE"],"flexible":false,"timeOfDay":["morning"]}',       // days
      "SKIP",                                                            // photo
      CHILD_ROSTER,                                                      // recipients (two named → the count is known)
      "{}",                                                              // side extraction (6-word message)
      "Mahad K",                                                         // child's name
      "Toddler",                                                         // stage
      "1",                                                               // how many care providers
      '{"name":"contact s s","phone":"4088745451","relationship":""}',   // emergency
      "cousin",                                                          // emergency relationship
      '{"needs":["light housekeeping","supervision"]}',                  // needs
      '{"pets":false,"smoking":false}',                                  // pets / smoking
      "16",                                                              // rate
      "TEXT",                                                            // description (text)
      "hamse@example.com",                                               // email
    ];
    const { deps, sent, merged, recap } = makeDeps(parse);
    const session: any = { onboardingData: { firstName: "Hamse", lastName: "" } };
    const say = async (text: string) => {
      await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text, session });
      // the live loop reloads the session each turn; mirror that here
      session.onboardingData = Object.assign({}, session.onboardingData, ...merged);
    };
    await say("part time");
    expect(sent.at(-1)).toBe("Part-time care, got it. What's your home address? The street and ZIP code is all I need.");
    await say("4746 campbell ave san jose ca 95130");
    expect(sent.at(-1)).toContain("San Jose 95130, got it. Is care needed at that same address?");
    await say("yes");
    expect(sent.at(-1)).toContain("Same address, got it. When would you like care to start");
    await say("tomorrow");
    expect(sent.at(-1)).toContain("Starting 2026-10-21, got it. Is this ongoing");
    await say("ongoing");
    expect(sent.at(-1)).toContain("Ongoing, got it. Which days of the week");
    await say("tuesday mornings");
    expect(sent.at(-1)).toContain("TUE, morning, got it. Want to add a profile photo");
    await say("skip");
    expect(sent.at(-1)).toContain("skip the photo. What is your relationship to the person needing care? Myself, Parent, Spouse or Partner, Adult child, Child, or Other.");
    await say("it's for me and my child");
    expect(sent.at(-1)).toBe("Care for you and your child, got it. What's your child's name? First and last is best.");
    await say("Mahad K");
    expect(sent.at(-1)).toContain("Mahad K, got it. Which stage is Mahad K at");
    await say("toddler");
    expect(sent.at(-1)).toContain("Toddler, got it. How many care providers do you need, 1 to 4? Most families need 1.");
    await say("1");
    expect(sent.at(-1)).toContain("1 care provider, got it. Who should we contact in case of an emergency?");
    await say("contact s s 4088745451");
    expect(sent.at(-1)).toContain("How is contact s s related to you?");
    await say("cousin");
    expect(sent.at(-1)).toContain("Cousin, got it. What type of care is needed?");
    expect(sent.at(-1)).toContain("Child care:");
    await say("light housekeeping and supervision");
    expect(sent.at(-1)).toContain("Light Housekeeping, Supervision, got it. Two quick ones: are there pets in the home, and does anyone in the household smoke?");
    await say("no and no");
    expect(sent.at(-1)).toContain("No pets, no smoking, got it. What would you like to pay per hour?");
    await say("16");
    expect(sent.at(-1)).toContain("$16/hr, got it. What else should care providers know");
    await say("this is for my family.");
    expect(sent.at(-1)).toContain("Got it, I saved that. Last thing — what's your email address?");
    expect(recap()).toBe(0);
    await say("hamse@example.com");
    expect(recap()).toBe(1);
    const all = Object.assign({}, ...merged);
    expect(all.relationship).toBe("self");
    expect(all.seniorName).toBe("Hamse");
    expect(all.additionalRecipients).toEqual([{ name: "Mahad K", relationship: "child", ageRange: "toddler" }]);
    expect(all.careNeeds).toEqual(["Light Housekeeping", "Supervision"]);
    expect(all.jobDescription).toBe("this is for my family.");
    expect(all.emergencyContactPhone).toBe("(408) 874-5451");
    expect(all.caregiversNeeded).toBe(1);
    expect(all.petsInHome).toBe(false);
    expect(all.smokingHousehold).toBe(false);
  });

  it('"anyone else?": YES asks who, "myself" / "adult child too" are ADDED (read before any chit-chat judgment), NO confirms, "no" to pets/smoking means no to both', async () => {
    const base = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true, ...dataFromRoster([{ relationship: "child", name: "Hamse MM", ageRange: "toddler" }]) };
    const { deps, sent, merged } = makeDeps(['{"people":[{"relationship":"self","name":""}]}', '{"people":[{"relationship":"adult child","name":""}]}'], base);
    const session: any = { onboardingData: {} };
    const say = async (text: string) => { await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text, session }); session.onboardingData = Object.assign({}, session.onboardingData, ...merged); };
    await say("yes");
    expect(sent.at(-1)).toBe("Who else needs care? Your relationship to them — Myself, Parent, Spouse or Partner, Adult child, Child, or Other.");
    expect(deps.isQuestionOrOther).not.toHaveBeenCalled();
    await say("myself");
    expect(sent.at(-1)).toBe("Care for Hamse MM and you, got it. Is there anyone else who needs care? If not, just say no. Otherwise tell me who.");
    await say("no");
    expect(sent.at(-1)).toContain("Nobody else, got it. How many care providers do you need, 1 to 4?");
    // adding another later, at the providers step, still works through the side reader; here: a fresh session at the count step
    const { deps: d2, sent: s2, merged: m2 } = makeDeps(['{"people":[{"relationship":"adult child","name":""}]}'], base);
    await runFamilyIntakeTurn(d2, { phone: "+1", chatId: "c", text: "adult child too", session: { onboardingData: {} } });
    expect(s2.at(-1)).toContain("Care for Hamse MM and your adult child, got it. What's your adult child's name?");
    expect(Object.assign({}, ...m2).additionalRecipients).toEqual([{ name: "", relationship: "adult child" }]);
    expect(d2.isQuestionOrOther).not.toHaveBeenCalled();
    // pets / smoking: a plain "no"
    const petsBase = { ...base, rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "M M", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "son", careNeeds: ["Baby Care"] };
    const { deps: d3, sent: s3 } = makeDeps(['{"pets":false,"smoking":false}'], petsBase);
    await runFamilyIntakeTurn(d3, { phone: "+1", chatId: "c", text: "no", session: { onboardingData: {} } });
    expect(s3.at(-1)).toContain("No pets, no smoking, got it. What would you like to pay per hour?");
  });

  it("a person added after the care types were picked gets their list offered once, and the picks are ADDED", async () => {
    // child-only post, care types picked from the child list; then the account holder is added
    const site = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true,
      ...dataFromRoster([{ relationship: "child", name: "Hamse MM", ageRange: "toddler" }, { relationship: "self", name: "Hamse" }]), rosterCountConfirmed: true, caregiversNeeded: 1,
      emergencyContactName: "M M", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "son", careNeeds: ["Baby Care", "School & Homework"], careNeedsKindsOffered: ["child"], householdAsked: true, rate: 40, descriptionSkipped: true, email: "h@x.com" };
    const { deps, sent, merged } = makeDeps(['{"needs":["light housekeeping"],"none":false}'], site);
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "__RESUME__", session: { onboardingData: {} } });
    expect(sent.at(-1)).toContain("Now that you are on the post too, anything from the senior care list? Pick as many as apply, or say none:");
    expect(sent.at(-1)).toContain("Companionship");
    expect(sent.at(-1)).not.toContain("Baby Care");
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "light housekeeping", session: { onboardingData: {} } });
    const all = Object.assign({}, ...merged);
    expect(all.careNeeds).toEqual(["Baby Care", "School & Homework", "Light Housekeeping"]);
    expect(all.careNeedsKindsOffered).toEqual(["senior", "child"]);
    // the mapper is told whose post it is (live 2026-10-26: "bathing" on a child-care post came back as Personal Care)
    expect(deps.canonicalizeCareNeeds).toHaveBeenLastCalledWith(expect.anything(), { kinds: ["senior", "child"] });
    // care types saved on the site (no offered record) are never re-asked
    const fromSite = { ...site, careNeedsKindsOffered: undefined };
    delete (fromSite as any).careNeedsKindsOffered;
    expect(nextFamilyStep(fromSite)).toBeNull();
    // "none" on the follow-up closes it without adding
    const { deps: d2, sent: s2, merged: m2 } = makeDeps(['{"needs":[],"none":true}'], site);
    await runFamilyIntakeTurn(d2, { phone: "+1", chatId: "c", text: "none", session: { onboardingData: {} } });
    expect(s2.at(-1)).toContain("Nothing more, got it.");
    expect(Object.assign({}, ...m2).careNeedsKindsOffered).toEqual(["senior", "child"]);
  });

  it("a SHORT correction at any step is applied (\"make it full time\" at the rate step), and \"add my dad\" mid-flow ADDS", async () => {
    const site = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true, ...dataFromRoster([{ relationship: "child", name: "Mahad K", ageRange: "toddler" }]), rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "s", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "cousin", careNeeds: ["Supervision"], careNeedsKindsOffered: ["child"], householdAsked: true };
    // 4 words: the rate reader fails, the side reading still runs and applies the frequency
    const { deps, sent, merged } = makeDeps(["unknown", '{"careFrequency":"full_time"}'], site);
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "make it full time", session: { onboardingData: {} } });
    expect(Object.assign({}, ...merged).careFrequency).toBe("full_time");
    expect(sent.at(-1)).toContain("What would you like to pay per hour?");
    expect(deps.isQuestionOrOther).not.toHaveBeenCalled();
    // "add my dad" at the rate step: the child stays, the parent is added and his name is asked next
    const { deps: d2, sent: s2, merged: m2 } = makeDeps(["unknown", '{"recipients":"add my dad","recipientsMode":"add"}', '{"people":[{"relationship":"parent","name":""}]}'], site);
    await runFamilyIntakeTurn(d2, { phone: "+1", chatId: "c", text: "add my dad", session: { onboardingData: {} } });
    const all2 = Object.assign({}, ...m2);
    expect(all2.relationship).toBe("child");
    expect(all2.seniorName).toBe("Mahad K");
    expect(all2.additionalRecipients).toEqual([{ name: "", relationship: "parent" }]);
    expect(s2.at(-1)).toContain("Care for Mahad K and your parent, got it. What's your parent's name?");
  });

  it("a person already listed can be renamed from any later step (the recap's applier, mid-flow)", async () => {
    const site = { firstName: "Hamse", lastName: "Client", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true, ...dataFromRoster([{ relationship: "self", name: "Hamse Client" }, { relationship: "child", name: "Mahad C", ageRange: "toddler" }]), rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "s", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "cousin", careNeeds: ["Supervision"], careNeedsKindsOffered: ["child", "senior"], householdAsked: true };
    const { deps, sent, merged } = makeDeps(["unknown", '{"people":{"rename":{"from":"Mahad","to":"Mahad K"}}}'], site);
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "actually it's Mahad K", session: { onboardingData: {} } });
    const all = Object.assign({}, ...merged);
    expect(all.relationship).toBe("self");
    expect(all.additionalRecipients).toEqual([{ name: "Mahad K", relationship: "child", ageRange: "toddler" }]);
    expect(sent.at(-1)).toContain("Mahad K.");
    expect(sent.at(-1)).toContain("What would you like to pay per hour?");
  });

  it("the name step needs first AND last; the email ack never echoes the address", async () => {
    const { deps, sent, merged } = makeDeps(["Hamse"], {});
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "Hamse", session: { onboardingData: {}, onboardingStep: "family_ask_name" } });
    expect(merged).toHaveLength(0);
    expect(sent.at(-1)).toContain("I need your last name too");
    const site = { firstName: "Hamse", lastName: "Client", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true, ...dataFromRoster([{ relationship: "self", name: "Hamse Client" }]), rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "s", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "cousin", careNeeds: ["Companionship"], careNeedsKindsOffered: ["senior"], householdAsked: true, rate: 25, descriptionSkipped: true };
    const e = makeDeps(["hamse143@gmail.com"], site);
    await runFamilyIntakeTurn(e.deps, { phone: "+1", chatId: "c", text: "Hamse143@gmail.com", session: { onboardingData: {} } });
    expect(Object.assign({}, ...e.merged).email).toBe("hamse143@gmail.com");
    const last = e.sent.at(-1) ?? "";
    expect(last).toContain("Email saved, got it.");
    expect(last).not.toContain("@");
  });

  it("the last ack and the recap go out as ONE message", async () => {
    const site = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true, relationship: "self", seniorName: "Hamse", rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "s", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "cousin", careNeeds: ["Light Housekeeping"], householdAsked: true, rate: 16, email: "h@x.com" };
    const { deps, sent, recap } = makeDeps(["SKIP"], site);
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "skip", session: { onboardingData: {} } });
    expect(recap()).toBe(1);
    expect(sent.at(-1)).toBe("No problem, we'll leave that blank.\n\n[recap]");
  });

  it("one person named → the count question; a number adds people to ask about in the site's order; \"no\" confirms", async () => {
    const base = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true };
    // "my mom Rosa" → one person → asked how many in total
    const { deps, sent, merged } = makeDeps(['{"people":[{"relationship":"parent","name":"Rosa Diaz"}]}', '{"people":[]}' /* "2" is read for people first */, '{"count":2,"others":""}', '{"people":[{"relationship":"son or daughter (age unknown)","name":""}]}', "ADULT", "Sam Diaz"], base);
    const session: any = { onboardingData: {} };
    const say = async (text: string) => { await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text, session }); session.onboardingData = Object.assign({}, session.onboardingData, ...merged); };
    await say("my mom Rosa Diaz");
    expect(sent.at(-1)).toContain("Care for Rosa Diaz, got it. Is there anyone else who needs care? If not, just say no. Otherwise tell me who.");
    await say("2");
    expect(sent.at(-1)).toContain("2 people, got it. What is your relationship to care recipient 2? Myself, Parent, Spouse or Partner, Adult child, Child, or Other.");
    await say("my son");
    expect(sent.at(-1)).toContain("Your son or daughter, got it. Is your son or daughter a child, or an adult son or daughter?");
    await say("he's an adult");
    expect(sent.at(-1)).toContain("An adult, got it. What's your adult child's name?");
    await say("Sam Diaz");
    expect(sent.at(-1)).toContain("Sam Diaz, got it. How many care providers do you need, 1 to 4?");
    const all = Object.assign({}, ...merged);
    expect(all.additionalRecipients).toEqual([{ name: "Sam Diaz", relationship: "adult child" }]);
    // "no" at the count question confirms a single person
    const { deps: d2, sent: s2 } = makeDeps(["unknown", '{"count":1,"others":""}'], { ...base, ...dataFromRoster([{ relationship: "parent", name: "Rosa Diaz" }]) });
    await runFamilyIntakeTurn(d2, { phone: "+1", chatId: "c", text: "no, just her", session: { onboardingData: {} } });
    expect(s2.at(-1)).toContain("Nobody else, got it. How many care providers do you need, 1 to 4?");
  });

  it("a correction at any step changes the roster instead of becoming job text", async () => {
    const site = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true, relationship: "parent", seniorName: "Mahad K", rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "s s", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "cousin", careNeeds: ["Light Housekeeping"], householdAsked: true };
    // at the rate step, they say who the care is for instead of a rate
    const { deps, sent, merged } = makeDeps(["unknown", '{"recipients":"me and my child"}', CHILD_ROSTER], site);
    const session: any = { onboardingData: { firstName: "Hamse" } };
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "the care request is for me and my child", session });
    const all = Object.assign({}, ...merged);
    expect(all.relationship).toBe("self");
    expect(all.additionalRecipients).toEqual([{ name: "", relationship: "child" }]);
    expect(all.jobDescription).toBeUndefined();
    expect(sent.at(-1)).toContain("Care for you and your child, got it. What's your child's name?");
  });

  it("a side question is answered and the current question re-asked, with no write — but only after nothing read as an answer", async () => {
    const { deps, sent, merged } = makeDeps(["unknown"]);
    (deps.isQuestionOrOther as any).mockResolvedValueOnce(true);
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "how much does this cost?", session: { onboardingData: { firstName: "Hamse" } } });
    expect(merged.length).toBe(0);
    expect(sent.at(-1)).toContain("Here's the answer.");
    expect(sent.at(-1)).toContain("How often do you need care");
  });

  it("an address outside Santa Clara County parks the family on the waitlist", async () => {
    const { deps, sent, parked } = makeDeps(['{"street":"1 Rodeo Dr","zip":"90210"}'], { firstName: "Hamse", careFrequency: "part_time" });
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "1 Rodeo Dr 90210", session: { onboardingData: { firstName: "Hamse" } } });
    // the home address is saved, then the care address defaults to it only when asked — here the home ZIP itself is out
    expect(parked()).toBeNull(); // the gate runs on the CARE address; the next question asks whether care is at the same address
    expect(sent.at(-1)).toContain("Is care needed at that same address?");
    const { deps: d2, sent: s2, parked: p2 } = makeDeps(["SAME"], { firstName: "Hamse", careFrequency: "part_time", homeStreet: "1 Rodeo Dr", homeZipCode: "90210", homeCity: "Beverly Hills", homeState: "CA" });
    await runFamilyIntakeTurn(d2, { phone: "+1", chatId: "c", text: "yes", session: { onboardingData: { firstName: "Hamse" } } });
    expect(p2()).not.toBeNull();
    expect(s2.at(-1)).toContain("only serves Santa Clara County");
  });

  it("a description over the cap is refused with the count, never cut; medication instructions are refused", async () => {
    const site = { firstName: "Hamse", careFrequency: "part_time", homeStreet: "x", homeZipCode: "95130", sameAsHomeAddress: true, startDate: "2026-10-21", ongoing: true, selectedDays: ["TUE"], timeOfDay: ["morning"], photoSkipped: true, relationship: "self", seniorName: "Hamse", rosterCountConfirmed: true, caregiversNeeded: 1, emergencyContactName: "s", emergencyContactPhone: "(408) 874-5451", emergencyContactRelationship: "cousin", careNeeds: ["Light Housekeeping"], householdAsked: true, rate: 16 };
    const { deps, sent, merged } = makeDeps(["TEXT", "TEXT"], site);
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "x".repeat(1001), session: { onboardingData: {} } });
    expect(sent.at(-1)).toContain("1,001 characters");
    expect(merged.length).toBe(0);
    await runFamilyIntakeTurn(deps, { phone: "+1", chatId: "c", text: "give 10 units of insulin at noon", session: { onboardingData: {} } });
    expect(sent.at(-1)).toBe("Care providers here don't give medication.");
    expect(merged.length).toBe(0);
  });
});
