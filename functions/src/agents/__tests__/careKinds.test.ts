import { describe, it, expect, vi } from "vitest";

// The contracts under test touch no data, but jobBoardPage.ts / jobPostContract.ts initialize firebase-admin at load.
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({ doc: () => ({}), where: () => ({ get: async () => ({ docs: [] }) }) }) }), {
    FieldValue: { serverTimestamp: () => "__ts__", delete: () => "__delete__", arrayUnion: (...a: unknown[]) => a },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

// Child care (2026-10-18): the ONE new fact on both doors — who the care is for — and everything
// that reads it. These are the contract helpers in caregiverServiceLabels.ts and the two post
// contracts; the site mirrors the data arrays byte-for-byte (caregiverServices.test.ts parity).

import {
  CARE_KINDS, CHILD_SERVICES, PRIMARY_SERVICES, CANONICAL_SERVICES, AGE_RANGES, RELATIONSHIPS,
  normalizeCareKinds, serviceListsForKinds, kindsOfServices, providerCoversPost, providerMatchesHousehold,
  careKindsFromWords, ageRangesFromWords, ageRangeLabel, careKindBadge, defaultJobTitleFor, serviceMenuText,
  SERVICE_LABELS, CHILD_SERVICE_LABELS,
  recipientCareKind, relationshipsForKinds, rosterCareKinds, careTypeChangeBlockedBy,
} from "../caregiverServiceLabels";
import { careTypeRefusalLine, careTypeSettingHint, rosterFromJobPostings, careTypeLabel } from "../householdCareType";
import { buildWebJobPostDoc, defaultJobTitle } from "../jobPostContract";
import { buildJobPostingsDoc, mapJobPostingsDocToOnboardingData } from "../clientJobPostingContract";
import { buildJobCard, jobCardLine, passesJobBoardFilters, JOB_BOARD_CARE_TYPES } from "../jobBoardPage";

describe("who decides a recipient's kind (founder, 2026-10-18 evening): the relationship, gated by the household's ONE setting", () => {
  it("Child → child; Myself / Parent / Spouse or Partner (and the older stored values) → senior; Other → its own careKind", () => {
    expect(recipientCareKind("Child")).toBe("child");
    expect(recipientCareKind("child")).toBe("child");
    expect(recipientCareKind("Parent")).toBe("senior");
    expect(recipientCareKind("Myself")).toBe("senior");
    expect(recipientCareKind("Grandparent")).toBe("senior"); // legacy stored value still reads
    expect(recipientCareKind("Other")).toBe("senior");
    expect(recipientCareKind("Other", "child")).toBe("child");
    expect(recipientCareKind("Parent", "child")).toBe("senior"); // careKind only counts for Other
  });
  it("the relationship choices follow the household: Child only with child care, the senior ones only with senior care, Other always", () => {
    expect(relationshipsForKinds(undefined)).toEqual(["Myself", "Parent", "Spouse or Partner", "Other"]);
    expect(relationshipsForKinds(["child"])).toEqual(["Child", "Other"]);
    expect(relationshipsForKinds(["senior", "child"])).toEqual(["Myself", "Parent", "Spouse or Partner", "Child", "Other"]);
    expect(relationshipsForKinds(["senior", "child"], { includeMyself: false })).toEqual(["Parent", "Spouse or Partner", "Child", "Other"]);
  });
  it("a roster implies its kinds; a setting that leaves someone uncovered is refused with the page's sentence", () => {
    const roster = [{ name: "H M", relationship: "Parent" }, { name: "S Mahad", relationship: "Child" }];
    expect(rosterCareKinds(roster)).toEqual(["senior", "child"]);
    expect(rosterCareKinds([])).toEqual([]);
    expect(careTypeChangeBlockedBy(["senior", "child"], roster)).toBeNull();
    expect(careTypeChangeBlockedBy(["child"], roster)?.name).toBe("H M");
    expect(careTypeChangeBlockedBy(["senior"], roster)?.name).toBe("S Mahad");
    expect(careTypeRefusalLine({ name: "H M", relationship: "Parent" })).toBe("H M is a Parent. Choose Both, or remove H M first.");
    expect(careTypeSettingHint("child")).toBe("Child care isn't on this household yet — change the care type to Both in Account Settings, or tell me to and I'll do it.");
    expect(careTypeLabel(["senior", "child"])).toBe("Both");
    expect(careTypeLabel(undefined)).toBe("Senior care");
  });
  it("the roster read off job_postings carries the primary, the additional people, and Other's two-way pick", () => {
    const roster = rosterFromJobPostings({ careRecipientFirstName: "H", careRecipientLastName: "M", relationship: "Parent", additionalRecipients: [{ firstName: "S", lastName: "Mahad", relationship: "Child" }, { firstName: "Lee", relationship: "Other", careKind: "child" }, { firstName: "" }] });
    expect(roster.map((r) => [r.name, r.kind, r.isPrimary])).toEqual([["H M", "senior", true], ["S Mahad", "child", false], ["Lee", "child", false]]);
    expect(rosterFromJobPostings(undefined)).toEqual([]);
  });
});

describe("care kinds — the contract", () => {
  it("a missing or empty value means senior care; only the two kinds survive", () => {
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

  it("a provider sees a post only when they offer EVERY kind it needs; a family sees a provider who offers ANY kind they need", () => {
    expect(providerCoversPost(undefined, undefined)).toBe(true);              // senior-only provider, senior post (today)
    expect(providerCoversPost(undefined, ["child"])).toBe(false);             // never a child post
    expect(providerCoversPost(["child"], undefined)).toBe(false);             // a child-care-only provider never sees a senior post
    expect(providerCoversPost(["senior", "child"], ["senior", "child"])).toBe(true);
    expect(providerCoversPost(["senior"], ["senior", "child"])).toBe(false);  // a both-post needs a both-provider
    expect(providerMatchesHousehold(["child"], ["senior", "child"])).toBe(true);
    expect(providerMatchesHousehold(undefined, ["child"])).toBe(false);
    expect(providerMatchesHousehold(undefined, undefined)).toBe(true);
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
    expect(ageRangeLabel("3-5")).toBe("Ages 3–5");
    expect(RELATIONSHIPS).toEqual(["Myself", "Parent", "Spouse or Partner", "Child", "Other"]);
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

  it("job_postings carries the household's answer only when answered, and reads it back", () => {
    const none = buildJobPostingsDoc("u1", "+1", { seniorName: "Ann Lee", careNeeds: ["Companionship"] });
    expect("careKinds" in none).toBe(false);
    const child = buildJobPostingsDoc("u1", "+1", { seniorName: "Ann Lee", careNeeds: ["Supervision"], careKinds: ["child", "nope"] });
    expect(child.careKinds).toEqual(["child"]);
    expect(mapJobPostingsDocToOnboardingData({ careKinds: ["senior", "child"] }).careKinds).toEqual(["senior", "child"]);
    expect(mapJobPostingsDocToOnboardingData({}).careKinds).toBeUndefined();
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
    expect(childCard.ageRanges).toEqual(["Toddler", "Ages 3–5"]);
    expect(jobCardLine(childCard)).toContain("Child care · Occasional · Daytime · Toddler · Ages 3–5");
    expect(JOB_BOARD_CARE_TYPES).toContain("Supervision");
    expect(passesJobBoardFilters({ careTypes: ["Supervision"] }, { careTypes: ["Supervision"] })).toBe(true);
  });
});
