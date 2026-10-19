import { describe, it, expect, vi } from "vitest";

// The contracts under test touch no data, but jobBoardPage.ts / jobPostContract.ts initialize firebase-admin at load.
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({ doc: () => ({}), where: () => ({ get: async () => ({ docs: [] }) }) }) }), {
    FieldValue: { serverTimestamp: () => "__ts__", delete: () => "__delete__", arrayUnion: (...a: unknown[]) => a },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

// Child care (2026-10-18), un-framed 2026-10-19: nobody is asked "senior, child or both" on either door.
// The kinds are DERIVED — a family's from each recipient's relationship, a provider's and a post's from the
// services ticked — and nothing is hidden by kind. These are the contract helpers in caregiverServiceLabels.ts
// and the two post contracts; the site mirrors the data arrays byte-for-byte (caregiverServices.test.ts parity).

import {
  CARE_KINDS, CHILD_SERVICES, PRIMARY_SERVICES, CANONICAL_SERVICES, AGE_RANGES, RELATIONSHIPS,
  normalizeCareKinds, serviceListsForKinds, kindsOfServices, kindsOfPost, kindsOfProvider,
  careKindsFromWords, ageRangesFromWords, ageRangeFromWords, stageOf, stageQuestion, STAGE_HEADING, ageRangeLabel, careKindBadge, defaultJobTitleFor, serviceMenuText,
  SERVICE_LABELS, CHILD_SERVICE_LABELS,
  recipientCareKind, relationshipsForKinds, rosterCareKinds,
} from "../caregiverServiceLabels";
import { buildWebJobPostDoc, defaultJobTitle } from "../jobPostContract";
import { buildJobPostingsDoc, mapJobPostingsDocToOnboardingData } from "../clientJobPostingContract";
import { buildJobCard, jobCardLine, passesJobBoardFilters, applyJobBoardFilters, JOB_BOARD_CARE_TYPES } from "../jobBoardPage";

describe("who decides a recipient's kind (founder, 2026-10-19): the relationship, nothing else — no household setting", () => {
  it("Child → child; Myself / Parent / Spouse or Partner (and the older stored values) → senior; Other → its own careKind", () => {
    expect(recipientCareKind("Child")).toBe("child");
    expect(recipientCareKind("child")).toBe("child");
    expect(recipientCareKind("Parent")).toBe("senior");
    expect(recipientCareKind("Myself")).toBe("senior");
    expect(recipientCareKind("Grandparent")).toBe("senior"); // legacy stored value still reads
    expect(recipientCareKind("Other")).toBe("senior");
    expect(recipientCareKind("Other", "child")).toBe("child");
    expect(recipientCareKind("Parent", "child")).toBe("senior"); // careKind only counts for Other
    expect(recipientCareKind("Adult child")).toBe("senior");       // a grown son or daughter — the senior side (2026-10-18 late)
    expect(recipientCareKind("adult child", "child")).toBe("senior");
  });
  it("relationshipsForKinds is only a derivation helper now — every caller passes both kinds and gets all six", () => {
    expect(relationshipsForKinds(undefined)).toEqual(["Myself", "Parent", "Spouse or Partner", "Adult child", "Other"]);
    expect(relationshipsForKinds(["child"])).toEqual(["Child", "Other"]);
    expect(relationshipsForKinds(["senior", "child"])).toEqual(["Myself", "Parent", "Spouse or Partner", "Adult child", "Child", "Other"]);
    expect(relationshipsForKinds(["senior", "child"], { includeMyself: false })).toEqual(["Parent", "Spouse or Partner", "Adult child", "Child", "Other"]);
  });
  it("a roster implies its kinds (a child → child, anyone else → senior; Other by its own answer)", () => {
    const roster = [{ name: "H M", relationship: "Parent" }, { name: "S Mahad", relationship: "Child" }];
    expect(rosterCareKinds(roster)).toEqual(["senior", "child"]);
    expect(rosterCareKinds([{ relationship: "Other", careKind: "child" }])).toEqual(["child"]);
    expect(rosterCareKinds([])).toEqual([]);
  });
});

describe("care kinds — the contract", () => {
  it("a missing or empty value still reads senior (legacy records keep their titles); only the two kinds survive", () => {
    expect(CARE_KINDS).toEqual(["senior", "child"]);
    expect(normalizeCareKinds(undefined)).toEqual(["senior"]);
    expect(normalizeCareKinds([])).toEqual(["senior"]);
    expect(normalizeCareKinds(["child"])).toEqual(["child"]);
    expect(normalizeCareKinds(["child", "senior", "pets"])).toEqual(["senior", "child"]); // canonical order, junk dropped
  });

  it("one list, or both under their own names — never a mixed list", () => {
    expect(serviceListsForKinds(undefined).map((l) => l.kind)).toEqual(["senior"]);
    expect(serviceListsForKinds(["child"])).toEqual([{ kind: "child", services: CHILD_SERVICES }]);
    expect(serviceListsForKinds(["senior", "child"]).map((l) => l.kind)).toEqual(["senior", "child"]);
    expect(serviceMenuText()).toBe(SERVICE_LABELS.join("\n")); // today's menu, untouched
    expect(serviceMenuText(["child"])).toBe(CHILD_SERVICE_LABELS.join("\n"));
    expect(serviceMenuText(["senior", "child"])).toBe(`Senior care:\n${SERVICE_LABELS.join("\n")}\n\nChild care:\n${CHILD_SERVICE_LABELS.join("\n")}`);
    expect(CANONICAL_SERVICES).toEqual([...PRIMARY_SERVICES, ...CHILD_SERVICES.filter((s) => s !== "Transportation")]);
  });

  it("the kinds a post needs follow what was ticked; Transportation alone defers to the answer on record", () => {
    expect(kindsOfServices(["Personal Care", "Transportation"])).toEqual(["senior"]);
    expect(kindsOfServices(["Supervision"])).toEqual(["child"]);
    expect(kindsOfServices(["Companionship", "Baby Care"])).toEqual(["senior", "child"]);
    expect(kindsOfServices(["Transportation"])).toEqual(["senior"]);            // nothing on record → senior
    expect(kindsOfServices(["Transportation"], ["child"])).toEqual(["child"]);  // the household's answer decides
    expect(kindsOfServices([], ["senior", "child"])).toEqual(["senior", "child"]);
  });

  it("nothing hides anyone by kind (2026-10-19): kindsOfPost / kindsOfProvider only feed the optional view filter — both mirror the site's helpers", () => {
    expect(kindsOfPost({ careTypes: ["Supervision"] })).toEqual(["child"]);
    expect(kindsOfPost({ careTypes: ["Companionship", "Baby Care"] })).toEqual(["senior", "child"]);
    expect(kindsOfPost({ careTypes: ["Transportation"], careKinds: ["child"] })).toEqual(["child"]); // the stored kinds decide a ride-only post
    expect(kindsOfPost({ careTypes: ["Transportation"] })).toEqual(["senior"]);                      // a legacy ride-only post stays senior
    expect(kindsOfPost(undefined)).toEqual(["senior"]);
    expect(kindsOfProvider({ services: ["Companionship"] })).toEqual(["senior"]);
    expect(kindsOfProvider({ services: [], skills: ["Supervision"] })).toEqual(["child"]);              // skills when services is empty
    expect(kindsOfProvider({ services: ["Transportation"] })).toEqual(["senior", "child"]);            // Transportation alone = both
    expect(kindsOfProvider({})).toEqual(["senior", "child"]);                                           // nothing ticked yet = both
    expect(kindsOfProvider(null)).toEqual(["senior", "child"]);
    // The Care type VIEW filter narrows for ANY provider; no filter = every post (the hiding is gone).
    const seniorPost = { id: "s", careTypes: ["Companionship"] };
    const childPost = { id: "c", careTypes: ["Supervision"] };
    const seniorOnlyProvider = { services: ["Companionship"] };
    expect(applyJobBoardFilters([seniorPost, childPost], undefined, seniorOnlyProvider).map((j) => j.id)).toEqual(["s", "c"]);
    expect(applyJobBoardFilters([seniorPost, childPost], { careType: "child" }, seniorOnlyProvider).map((j) => j.id)).toEqual(["c"]);
    expect(applyJobBoardFilters([seniorPost, childPost], { careType: "senior" }, { services: ["Supervision"] }).map((j) => j.id)).toEqual(["s"]);
  });

  it("the kinds question's answer and the age-range chips canonicalize from words; never a number is kept", () => {
    expect(careKindsFromWords("child care")).toEqual(["child"]);
    expect(careKindsFromWords("both")).toEqual(["senior", "child"]);
    expect(careKindsFromWords("for my mom")).toEqual(["senior"]);
    expect(careKindsFromWords("SENIOR")).toEqual(["senior"]);
    expect(careKindsFromWords("a person")).toBeNull();                        // "person" never trips "son"
    expect(careKindsFromWords("")).toBeNull();
    expect(ageRangesFromWords(["Infant", "ages 6–12"])).toEqual(["infant", "6-12"]);
    expect(ageRangesFromWords("toddler and a teen")).toEqual(["toddler", "teen"]);
    expect(ageRangesFromWords("3-5")).toEqual(["3-5"]);
    expect(ageRangesFromWords("82")).toEqual([]);
    expect(AGE_RANGES.map((a) => a.id)).toEqual(["infant", "toddler", "3-5", "6-12", "teen"]);
    // Stage words, never numbers (founder 2026-10-18): the ids stay, the labels are the stages.
    expect(AGE_RANGES.map((a) => a.label)).toEqual(["Infant", "Toddler", "Preschooler", "School-age", "Teen"]);
    expect(ageRangeLabel("3-5")).toBe("Preschooler");
    expect(STAGE_HEADING).toBe("Stage");
    expect(RELATIONSHIPS).toEqual(["Myself", "Parent", "Spouse or Partner", "Adult child", "Child", "Other"]);
  });

  it("ONE stage per child (2026-10-18 late): a single id from words; the stored stage reads ageRange first, a legacy ageRanges list as a fallback; the question names the child only when asked", () => {
    expect(ageRangeFromWords("Preschooler")).toBe("3-5");
    expect(ageRangeFromWords("she's a toddler, maybe preschool next year")).toBe("toddler"); // the first stage named, one only
    expect(ageRangeFromWords("82")).toBeNull();
    expect(stageOf({ ageRange: "teen" })).toBe("teen");
    expect(stageOf({ ageRanges: ["6-12", "teen"] })).toBe("6-12");
    expect(stageOf({ ageRange: "teen", ageRanges: ["6-12"] })).toBe("teen");
    expect(stageOf({})).toBeNull();
    expect(stageQuestion()).toBe("Which stage — Infant, Toddler, Preschooler, School-age, or Teen?");
    expect(stageQuestion("Mahad")).toBe("Which stage is Mahad at — Infant, Toddler, Preschooler, School-age, or Teen?");
  });

  it("the badge and the title follow the kinds — senior-only stays exactly as before", () => {
    expect(careKindBadge(undefined)).toBeNull();
    expect(careKindBadge(["child"])).toBe("Child care");
    expect(careKindBadge(["senior", "child"])).toBe("Senior and child care");
    expect(defaultJobTitleFor("San Jose")).toBe("Senior care in San Jose");
    expect(defaultJobTitle("San Jose")).toBe("Senior care in San Jose");
    expect(defaultJobTitle("San Jose", ["child"])).toBe("Child care in San Jose");
    expect(defaultJobTitle("San Jose", ["senior", "child"])).toBe("Senior and child care in San Jose");
    expect(defaultJobTitle(null, ["child"])).toBe("Child care needed");
  });
});

describe("care kinds — the records", () => {
  const base = { clientId: "c1", source: "cara", title: "t", city: "San Jose" };

  it("job_posts carries careKinds from the ticked services and the chips only on a child post", () => {
    const senior = buildWebJobPostDoc({ ...base, careTypes: ["Companionship"], ageRanges: ["toddler"] });
    expect(senior.careKinds).toEqual(["senior"]);
    expect(senior.ageRanges).toBeUndefined();
    const child = buildWebJobPostDoc({ ...base, careTypes: ["Supervision", "Transportation"], ageRanges: ["Toddler", "teen"] });
    expect(child.careKinds).toEqual(["child"]);
    expect(child.ageRanges).toEqual(["toddler", "teen"]);
    const both = buildWebJobPostDoc({ ...base, careTypes: ["Companionship", "School & Homework"] });
    expect(both.careKinds).toEqual(["senior", "child"]);
    const rideOnly = buildWebJobPostDoc({ ...base, careTypes: ["Transportation"], careKinds: ["child"] });
    expect(rideOnly.careKinds).toEqual(["child"]);
  });

  it("job_postings.careKinds is DERIVED from the people on the record (2026-10-19) — never asked, never read back into the intake", () => {
    const none = buildJobPostingsDoc("u1", "+1", { careNeeds: ["Companionship"] });
    expect("careKinds" in none).toBe(false);                                          // nobody named yet
    const senior = buildJobPostingsDoc("u1", "+1", { seniorName: "Ann Lee", relationship: "parent", careNeeds: ["Companionship"] });
    expect(senior.careKinds).toEqual(["senior"]);
    const child = buildJobPostingsDoc("u1", "+1", { seniorName: "S Mahad", relationship: "child", careNeeds: ["Supervision"], careKinds: ["senior"] });
    expect(child.careKinds).toEqual(["child"]);                                        // the relationship wins over any stale stored value
    const both = buildJobPostingsDoc("u1", "+1", { seniorName: "Ann Lee", relationship: "parent", additionalRecipients: [{ name: "Lee", relationship: "other", careKind: "child" }], careNeeds: ["Companionship"] });
    expect(both.careKinds).toEqual(["senior", "child"]);
    expect(mapJobPostingsDocToOnboardingData({ careKinds: ["senior", "child"] }).careKinds).toBeUndefined();
  });

  it("the Jobs board card: a kind badge only when child care is involved, 'people' never 'seniors', the chips beside the pills", () => {
    const cg = { id: "cg1" };
    const seniorCard = buildJobCard({ id: "j1", title: "Senior care in San Jose", careTypes: ["Companionship"], recipientsCount: 2, timeOfDay: ["morning"] }, cg, null);
    expect(seniorCard.kind).toBeNull();
    expect(seniorCard.ageRanges).toEqual([]);
    expect(jobCardLine(seniorCard)).toContain("2 people");
    expect(jobCardLine(seniorCard)).not.toMatch(/seniors/);
    const childCard = buildJobCard({ id: "j2", title: "Child care in San Jose", careTypes: ["Supervision"], careKinds: ["child"], ageRanges: ["toddler", "3-5"], timeOfDay: ["morning"] }, cg, null);
    expect(childCard.kind).toBe("Child care");
    expect(childCard.ageRanges).toEqual(["Toddler", "Preschooler"]); // the stage chip of each child on the post
    expect(jobCardLine(childCard)).toContain("Child care · Occasional · Daytime · Toddler · Preschooler");
    expect(JOB_BOARD_CARE_TYPES).toContain("Supervision");
    expect(passesJobBoardFilters({ careTypes: ["Supervision"] }, { careTypes: ["Supervision"] })).toBe(true);
  });
});
