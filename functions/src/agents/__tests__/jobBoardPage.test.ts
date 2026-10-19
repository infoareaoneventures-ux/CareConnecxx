import { describe, it, expect, vi, beforeEach } from "vitest";

// The Jobs board as data — every rule here is copied from JobBoard.tsx /
// CaregiverHomeDashboard.tsx, so these tests pin the SITE's behavior:
// query + drops + radius + filters + card labels + Details + Hide.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const applySentinel = (cur: any, k: string, v: any) => {
    if (v && typeof v === "object" && Array.isArray(v.__arrayUnion)) {
      const prev = Array.isArray(cur[k]) ? cur[k] : [];
      cur[k] = [...prev, ...v.__arrayUnion.filter((x: unknown) => !prev.includes(x))];
      return;
    }
    if (v && typeof v === "object" && Array.isArray(v.__arrayRemove)) {
      cur[k] = (Array.isArray(cur[k]) ? cur[k] : []).filter((x: unknown) => !v.__arrayRemove.includes(x));
      return;
    }
    cur[k] = v;
  };
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ id: path.split("/").pop(), exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      const base = opts?.merge ? { ...(docState.get(path) ?? {}) } : {};
      for (const [k, v] of Object.entries(data)) applySentinel(base, k, v);
      docState.set(path, base);
    }),
    update: vi.fn(async (data: any) => {
      const cur = { ...(docState.get(path) ?? {}) };
      for (const [k, v] of Object.entries(data)) applySentinel(cur, k, v);
      docState.set(path, cur);
    }),
  });
  const makeQuery = (coll: string, filters: Array<[string, string, any]>, lim?: number): any => ({
    where: (f: string, op: string, v: any) => makeQuery(coll, [...filters, [f, op, v]], lim),
    orderBy: () => makeQuery(coll, filters, lim),
    limit: (n: number) => makeQuery(coll, filters, n),
    get: vi.fn(async () => {
      let items = Array.from(docState.entries())
        .filter(([p]) => p.startsWith(`${coll}/`) && p.split("/").length === 2)
        .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
      for (const [f, op, v] of filters) {
        items = items.filter((it) => {
          const val = it.data()[f];
          if (op === "==") return val === v;
          if (op === "in") return Array.isArray(v) && v.includes(val);
          return true;
        });
      }
      if (lim) items = items.slice(0, lim);
      return { empty: items.length === 0, size: items.length, docs: items };
    }),
  });
  const makeCollRef = (coll: string): any => ({
    doc: (id: string) => makeDocRef(`${coll}/${id}`),
    ...makeQuery(coll, []),
  });
  return { docState, collectionMock: vi.fn((c: string) => makeCollRef(c)), reset: () => docState.clear() };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:  (...v: unknown[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: unknown[]) => ({ __arrayRemove: v }),
      delete:      () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

import {
  normalizeJobPost, rateLabel, frequencyLabel, dateLabel, hoursLabel, passesJobBoardFilters,
  withinCaregiverRadius, loadAvailableJobs, loadJobDetails, setJobHidden, loadHiddenJobs, jobCardLine, buildJobCard,
  normalizeJobBoardFilters, hasJobBoardFilters, jobBoardFiltersLabel, applyJobBoardFilters,
} from "../jobBoardPage";

// San Jose (0.2 mi), Santa Clara (~3.9 mi), Sacramento (~90 mi) from the caregiver.
const CG = { lat: 37.3382, lng: -121.8863, serviceRadius: 25, membershipPaid: true, verified: true };
const seedCg = (extra: Record<string, unknown> = {}) => hoisted.docState.set("caregivers/cg1", { ...CG, ...extra });
const seedJob = (id: string, j: Record<string, unknown>) =>
  hoisted.docState.set(`job_posts/${id}`, { status: "open", createdAt: "2026-09-20T00:00:00Z", clientId: `client-${id}`, title: `Job ${id}`, ...j });

beforeEach(() => hoisted.reset());

describe("card labels (JobBoard.tsx)", () => {
  it("rateLabel: flexible / 0 / missing → Flexible, else $N/hr", () => {
    expect(rateLabel({ rate: 26 })).toBe("$26/hr");
    expect(rateLabel({ rate: 0, rateFlexible: true })).toBe("Flexible");
    expect(rateLabel({})).toBe("Flexible");
  });
  it("frequencyLabel: jobFrequency wins, else derived from minHoursPerWeek", () => {
    expect(frequencyLabel({ jobFrequency: "part-time" })).toBe("Part-time");
    expect(frequencyLabel({ jobFrequency: "one-time" })).toBe("Occasional");
    expect(frequencyLabel({ minHoursPerWeek: 40 })).toBe("Full-time");
    expect(frequencyLabel({ minHoursPerWeek: 10 })).toBe("Part-time");
    expect(frequencyLabel({})).toBe("Occasional");
  });
  it("dateLabel: Today/Tomorrow raw, real dates formatted, ASAP shown raw (never Invalid Date)", () => {
    expect(dateLabel("Today")).toBe("Today");
    expect(dateLabel("2026-09-08")).toBe("Sep 8, 2026");
    expect(dateLabel("ASAP")).toBe("ASAP");
    expect(dateLabel(undefined)).toBeNull();
  });
  it("hoursLabel: start–end, else capitalized time of day, else Flexible hours", () => {
    expect(hoursLabel({ startTime: "09:00", endTime: "13:00" })).toBe("09:00 – 13:00");
    expect(hoursLabel({ timeOfDay: ["morning", "afternoon"] })).toBe("Morning, Afternoon");
    expect(hoursLabel({})).toBe("Flexible hours");
    expect(hoursLabel({}, null)).toBeNull();
  });
  it("normalizeJobPost: legacy object location / summary / hourlyRate coerced like services/api.ts", () => {
    const j = normalizeJobPost({ id: "x", location: { city: "San Jose", lat: 1, lng: 2 }, zipCode: "95110", summary: "Care job", hourlyRate: 22, startDate: "ASAP" });
    expect(j.location).toBe("San Jose, 95110");
    expect(j.lat).toBe(1);
    expect(j.title).toBe("Care job");
    expect(j.rate).toBe(22);
    expect(j.date).toBe("ASAP");
    expect(normalizeJobPost({ id: "y" }).rateFlexible).toBe(true);
  });
  it("jobCardLine reads like the card, in the card's order", () => {
    const card = buildJobCard(normalizeJobPost({ id: "j", title: "Care for Rosy", location: "Santa Clara", rate: 26, jobFrequency: "part-time", timeOfDay: ["morning"], date: "ASAP", lat: 37.3541, lng: -121.9552, paymentMethod: "credit" }), CG, { lat: CG.lat, lng: CG.lng });
    expect(card.action).toBe("Apply Now");
    expect(jobCardLine(card)).toBe("Care for Rosy · Santa Clara (3.9 mi away) · $26/hr · Part-time · Daytime · ASAP · Morning");
  });
});

describe("sidebar filters + radius (JobBoard.tsx filteredJobs)", () => {
  const job = { title: "Senior care in San Jose", location: "San Jose, CA", requirements: ["Driving"], rate: 25, timeOfDay: ["morning"], daysOfWeek: ["Monday", "Wednesday"], recipientsCount: 2, careTypes: ["Companionship"] };
  it("search matches title / location / requirements, case-insensitively", () => {
    expect(passesJobBoardFilters(job, { search: "san jose" })).toBe(true);
    expect(passesJobBoardFilters(job, { search: "driv" })).toBe(true);
    expect(passesJobBoardFilters(job, { search: "oakland" })).toBe(false);
  });
  it("pay range: a Flexible job (rate 0) is excluded by any minimum, like the site", () => {
    expect(passesJobBoardFilters(job, { payMin: 20, payMax: 30 })).toBe(true);
    expect(passesJobBoardFilters(job, { payMin: 26 })).toBe(false);
    expect(passesJobBoardFilters({ ...job, rate: 0 }, { payMin: 1 })).toBe(false);
  });
  it("time of day / days (prefix) / seniors / care type", () => {
    expect(passesJobBoardFilters(job, { timeOfDay: ["evening"] })).toBe(false);
    expect(passesJobBoardFilters(job, { days: ["Mon"] })).toBe(true);
    expect(passesJobBoardFilters(job, { days: ["Fri"] })).toBe(false);
    expect(passesJobBoardFilters({ ...job, daysOfWeek: undefined }, { days: ["Mon"] })).toBe(false);
    expect(passesJobBoardFilters(job, { seniors: ["2"] })).toBe(true);
    expect(passesJobBoardFilters(job, { seniors: ["3+"] })).toBe(false);
    expect(passesJobBoardFilters({ ...job, recipientsCount: undefined }, { seniors: ["1"] })).toBe(true);
    expect(passesJobBoardFilters(job, { careTypes: ["Companionship"] })).toBe(true);
    expect(passesJobBoardFilters(job, { careTypes: ["Transportation"] })).toBe(false);
  });
  it("radius applies only when care provider coords, job coords AND a radius > 0 all exist", () => {
    const far = { lat: 38.5816, lng: -121.4944 };
    expect(withinCaregiverRadius(far, { lat: CG.lat, lng: CG.lng }, 25)).toBe(false);
    expect(withinCaregiverRadius(far, { lat: CG.lat, lng: CG.lng }, 0)).toBe(true);
    expect(withinCaregiverRadius(far, null, 25)).toBe(true);
    expect(withinCaregiverRadius({}, { lat: CG.lat, lng: CG.lng }, 25)).toBe(true);
  });
});

describe("loadAvailableJobs — the Available Jobs tab and the dashboard's Nearby Jobs", () => {
  beforeEach(() => {
    seedCg();
    seedJob("near",   { lat: 37.3382, lng: -121.8863, createdAt: "2026-09-01T00:00:00Z" });
    seedJob("sc",     { lat: 37.3541, lng: -121.9552, createdAt: "2026-09-25T00:00:00Z", careTypes: ["Companionship", "Meal Preparation"] });
    seedJob("nocoords", { createdAt: "2026-09-26T00:00:00Z", rate: 0, rateFlexible: true });
    seedJob("far",    { lat: 38.5816, lng: -121.4944 });
    seedJob("applied", { lat: 37.3382, lng: -121.8863 });
    seedJob("closed", { status: "filled" });
    seedJob("inactive", { clientActive: false });
    seedJob("blocked", { clientId: "bad-client" });
    hoisted.docState.set("job_applications/a1", { caregiverId: "cg1", jobId: "applied", status: "pending" });
    hoisted.docState.set("users/cg1", { blockedUsers: ["bad-client"] });
  });

  it("lists every open job minus applied / hidden / deactivated / blocked / out of radius — no skills filter, no cap", async () => {
    seedCg({ hiddenJobIds: ["near"] });
    const page = (await loadAvailableJobs("cg1"))!;
    expect(page.jobs.map((j) => j.jobId).sort()).toEqual(["nocoords", "sc"]);
    expect(page.total).toBe(2);
    expect(page.hiddenCount).toBe(1);
    expect(page.radiusMiles).toBe(25);
    const nocoords = page.jobs.find((j) => j.jobId === "nocoords")!;
    expect(nocoords.rate).toBe("Flexible");
    expect(nocoords.distanceMiles).toBeNull();
  });

  it("child care (2026-10-18): a provider sees a post only when they offer every kind it needs — missing careKinds = senior on both sides", async () => {
    seedJob("kid", { lat: 37.3382, lng: -121.8863, createdAt: "2026-09-27T00:00:00Z", careTypes: ["Supervision"], careKinds: ["child"], ageRanges: ["toddler"] });
    seedJob("both", { lat: 37.3382, lng: -121.8863, createdAt: "2026-09-28T00:00:00Z", careTypes: ["Companionship", "Baby Care"], careKinds: ["senior", "child"] });
    // today's provider (no careKinds on the record) never sees a child post
    let page = (await loadAvailableJobs("cg1"))!;
    expect(page.jobs.map((j) => j.jobId).sort()).toEqual(["near", "nocoords", "sc"]);
    // a both-provider sees everything, the child posts badged
    seedCg({ careKinds: ["senior", "child"] });
    page = (await loadAvailableJobs("cg1"))!;
    expect(page.jobs.map((j) => j.jobId).sort()).toEqual(["both", "kid", "near", "nocoords", "sc"]);
    expect(page.jobs.find((j) => j.jobId === "kid")!.kind).toBe("Child care");
    expect(page.jobs.find((j) => j.jobId === "kid")!.ageRanges).toEqual(["Toddler"]);
    // The Care type filter at the top of the panel (Both accounts only): one kind's posts; a one-kind provider never sees it.
    page = (await loadAvailableJobs("cg1", { filters: { careType: "child" } }))!;
    expect(page.jobs.map((j) => j.jobId).sort()).toEqual(["both", "kid"]);
    page = (await loadAvailableJobs("cg1", { filters: { careType: "senior" } }))!;
    expect(page.jobs.map((j) => j.jobId).sort()).toEqual(["both", "near", "nocoords", "sc"]);
    seedCg({ careKinds: ["senior"] });
    page = (await loadAvailableJobs("cg1", { filters: { careType: "child" } }))!;
    expect(page.jobs.map((j) => j.jobId).sort()).toEqual(["near", "nocoords", "sc"]); // ignored: the filter exists only for a Both provider
    seedCg({ careKinds: ["senior", "child"] });
    page = (await loadAvailableJobs("cg1"))!;
    expect(page.jobs.find((j) => j.jobId === "both")!.kind).toBe("Senior and child care");
    expect(page.jobs.find((j) => j.jobId === "near")!.kind).toBeNull();
    // a child-care-only provider never sees a senior post, nor a both-post
    seedCg({ careKinds: ["child"] });
    page = (await loadAvailableJobs("cg1"))!;
    expect(page.jobs.map((j) => j.jobId)).toEqual(["kid"]);
  });

  it("no travel distance set → every open job shows, including the far one (site rule)", async () => {
    seedCg({ serviceRadius: 0, travelRadius: 0 });
    const page = (await loadAvailableJobs("cg1"))!;
    expect(page.jobs.map((j) => j.jobId).sort()).toEqual(["far", "near", "nocoords", "sc"]);
  });

  it("sort 'nearest' + limit 4 = the dashboard: distance ascending, no-coords last; total is the whole list", async () => {
    const page = (await loadAvailableJobs("cg1", { sort: "nearest", limit: 2 }))!;
    expect(page.jobs.map((j) => j.jobId)).toEqual(["near", "sc"]);
    expect(page.total).toBe(3);
    expect(page.jobs[0].distanceMiles).toBe(0);
    expect(page.jobs[1].distanceMiles).toBe(3.9);
  });

  it("filters mirror the sidebar", async () => {
    const page = (await loadAvailableJobs("cg1", { filters: { careTypes: ["Meal Preparation"] } }))!;
    expect(page.jobs.map((j) => j.jobId)).toEqual(["sc"]);
  });

  it("the card carries the button the site shows while gated", async () => {
    seedCg({ membershipPaid: false, verified: false });
    const page = (await loadAvailableJobs("cg1"))!;
    expect(page.jobs.every((j) => j.action === "Activate Membership")).toBe(true);
  });

  it("returns null for an unknown care provider", async () => {
    expect(await loadAvailableJobs("nobody")).toBeNull();
  });
});

describe("loadJobDetails — the Details modal", () => {
  beforeEach(() => {
    seedCg();
    seedJob("j1", { clientName: "Basra Yousuf", rate: 0, rateFlexible: true, startDate: "2026-08-02", description: "Looking for a caring and reliable care provider.", careTypes: ["Companionship"], daysOfWeek: ["Monday"], timeOfDay: ["morning"], recipientsCount: 1, minHoursPerWeek: 20 });
  });

  it("returns the modal's fields; the family's name is hidden until accepted", async () => {
    const r = await loadJobDetails("cg1", "j1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.details.postedBy).toBeNull();
    expect(r.details.rate).toBe("Flexible");
    expect(r.details.startingDate).toBe("Aug 2, 2026");
    expect(r.details.time).toBe("Morning");
    expect(r.details.hoursPerWeek).toBe("20+ hrs");
    expect(r.details.description).toBe("Looking for a caring and reliable care provider.");
    expect(r.details.applicationStatus).toBeNull();
    expect(r.details.interviewStatus).toBeNull();
    expect(r.details.action).toBe("Apply Now");
  });

  it("shows Posted by once this care provider's application is accepted, and the footer status", async () => {
    hoisted.docState.set("job_applications/a1", { caregiverId: "cg1", jobId: "j1", status: "accepted" });
    const r = await loadJobDetails("cg1", "j1");
    if (!r.ok) throw new Error("expected ok");
    expect(r.details.postedBy).toBe("Basra Yousuf");
    expect(r.details.applicationStatus).toBe("Application Accepted");
  });

  it("a pending application keeps the name hidden; an interview footer wins over the application one", async () => {
    hoisted.docState.set("job_applications/a1", { caregiverId: "cg1", jobId: "j1", status: "pending" });
    hoisted.docState.set("video_interviews/iv1", { caregiverId: "cg1", jobId: "j1", status: "requested" });
    const r = await loadJobDetails("cg1", "j1");
    if (!r.ok) throw new Error("expected ok");
    expect(r.details.postedBy).toBeNull();
    expect(r.details.interviewStatus).toBe("Interview Pending");
    expect(r.details.applicationStatus).toBeNull();
  });

  it("refuses blocked and deactivated clients like handleViewJobDetails", async () => {
    hoisted.docState.set("users/cg1", { blockedUsers: ["client-j1"] });
    expect(await loadJobDetails("cg1", "j1")).toEqual({ ok: false, reason: "unavailable" });
    hoisted.docState.set("users/cg1", {});
    seedJob("j2", { clientActive: false });
    expect(await loadJobDetails("cg1", "j2")).toEqual({ ok: false, reason: "unavailable" });
    expect(await loadJobDetails("cg1", "nope")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("hide / unhide — shared with the website via caregivers/{uid}.hiddenJobIds", () => {
  it("hides, lists the hidden tab (open jobs only), and unhides", async () => {
    seedCg();
    seedJob("j1", { title: "Senior care", location: "San Jose, CA", rate: 25 });
    seedJob("j2", { status: "filled" });
    await setJobHidden("cg1", "j1", true);
    await setJobHidden("cg1", "j2", true);
    expect(hoisted.docState.get("caregivers/cg1").hiddenJobIds).toEqual(["j1", "j2"]);
    expect(await loadHiddenJobs("cg1")).toEqual([{ jobId: "j1", title: "Senior care", location: "San Jose, CA", rate: "$25/hr" }]);
    await setJobHidden("cg1", "j1", false);
    expect(hoisted.docState.get("caregivers/cg1").hiddenJobIds).toEqual(["j2"]);
  });
});

// ── B3 (2026-10-11): the sidebar over text — values validated against the page's option sets ──
describe("normalizeJobBoardFilters — only the sidebar's own values survive", () => {
  it("keeps the page's option sets, normalizes day / care-type spellings, drops the rest", () => {
    expect(normalizeJobBoardFilters({
      search: "  san jose  ", payMin: "25", payMax: 40,
      timeOfDay: ["Morning", "night", "overnight"],
      days: ["Saturday", "sun", "Funday", "Mon"],
      seniors: ["2", "3", "9"],
      careTypes: ["companionship", "Medication Reminders Only", "Hair Styling"],
    })).toEqual({
      search: "san jose", payMin: 25, payMax: 40,
      timeOfDay: ["morning", "overnight"],
      days: ["Sat", "Sun", "Mon"],
      seniors: ["2", "3+"],
      careTypes: ["Companionship", "Medication Reminders"],
    });
  });
  it("empty / junk / negative / unknown keys → the default view ({}); a distance key is ignored (the page has no distance control)", () => {
    expect(normalizeJobBoardFilters(undefined)).toEqual({});
    expect(normalizeJobBoardFilters("morning")).toEqual({});
    expect(normalizeJobBoardFilters({ radiusMiles: 5, within: "5 miles", payMin: -3, payMax: "lots", timeOfDay: "dawn", days: [], search: "   " })).toEqual({});
    expect(hasJobBoardFilters({})).toBe(false);
    expect(hasJobBoardFilters({ payMax: 0 })).toBe(true);
    expect(hasJobBoardFilters(normalizeJobBoardFilters({ days: ["weekend"] }))).toBe(false); // not a chip — the model sends Sat/Sun
  });
  it("a long search string is capped; a single string value is accepted as a one-item list", () => {
    expect(normalizeJobBoardFilters({ search: "x".repeat(200) }).search).toHaveLength(80);
    expect(normalizeJobBoardFilters({ timeOfDay: "evening", days: "Fri" })).toEqual({ timeOfDay: ["evening"], days: ["Fri"] });
  });
});

describe("jobBoardFiltersLabel — the header names the sidebar set in its own words", () => {
  it("joins every set control", () => {
    expect(jobBoardFiltersLabel({ search: "san jose", payMin: 25, timeOfDay: ["morning", "evening"], days: ["Sat", "Sun"], seniors: ["1", "3+"], careTypes: ["Medication Reminders", "Companionship"] }))
      .toBe('"san jose", $25+/hr, Morning, Evening, Sat, Sun, 1 person, 3+ people, Medication Reminders Only, Companionship'); // "people", never "seniors" (2026-10-18)
    expect(jobBoardFiltersLabel({ payMax: 30 })).toBe("up to $30/hr");
    expect(jobBoardFiltersLabel({ payMin: 20, payMax: 30 })).toBe("$20–$30/hr");
    expect(jobBoardFiltersLabel({})).toBe("");
    expect(jobBoardFiltersLabel(undefined)).toBe("");
  });
});

describe("applyJobBoardFilters — JobBoard.tsx filteredJobs (:510-550) as one pure step", () => {
  const cg = { latitude: 37.3382, longitude: -121.8863, serviceRadius: 10 };
  const near = { id: "near", title: "Morning help in San Jose", location: "San Jose, CA", rate: 28, timeOfDay: ["morning"], daysOfWeek: ["Saturday", "Sunday"], recipientsCount: 1, careTypes: ["Companionship"], lat: 37.3382, lng: -121.8863 };
  const santaClara = { id: "sc", title: "Evening care", location: "Santa Clara, CA", rate: 22, timeOfDay: ["evening"], daysOfWeek: ["Monday"], recipientsCount: 2, careTypes: ["Meal Preparation"], lat: 37.3541, lng: -121.9552 };
  const far = { id: "far", title: "Weekend mornings", location: "Sacramento, CA", rate: 30, timeOfDay: ["morning"], daysOfWeek: ["Saturday"], careTypes: ["Companionship"], lat: 38.5816, lng: -121.4944 };
  const noCoords = { id: "nocoords", title: "Overnight sitter", location: "Fremont, CA", rate: 0, rateFlexible: true, timeOfDay: ["overnight"], daysOfWeek: ["Friday", "Saturday"], careTypes: ["Personal Care"] };
  const jobs = [near, santaClara, far, noCoords];
  const ids = (list: Array<Record<string, unknown>>) => list.map((j) => j.id);

  it("no filters = the travel-distance rule alone: a far job drops, a job with no coordinates stays (unknown, not excluded)", () => {
    expect(ids(applyJobBoardFilters(jobs, undefined, cg))).toEqual(["near", "sc", "nocoords"]);
    expect(ids(applyJobBoardFilters(jobs, {}, cg))).toEqual(["near", "sc", "nocoords"]);
  });
  it("no care provider coords, or no travel distance set → distance never excludes (the page's cgLat && cgLng && cgRadius > 0 guard)", () => {
    expect(ids(applyJobBoardFilters(jobs, {}, { serviceRadius: 10 }))).toEqual(["near", "sc", "far", "nocoords"]);
    expect(ids(applyJobBoardFilters(jobs, {}, { ...cg, serviceRadius: 0 }))).toEqual(["near", "sc", "far", "nocoords"]);
    expect(ids(applyJobBoardFilters(jobs, {}, { lat: cg.latitude, lng: cg.longitude, travelRadius: 10 }))).toEqual(["near", "sc", "nocoords"]); // legacy lat/lng + travelRadius fallbacks
    expect(ids(applyJobBoardFilters(jobs, {}, { ...cg, serviceRadius: 2 }))).toEqual(["near", "nocoords"]); // Santa Clara is ~3.9 mi out
  });
  it("each sidebar control, with the page's comparisons", () => {
    expect(ids(applyJobBoardFilters(jobs, { search: "SAN JOSE" }, cg))).toEqual(["near"]);          // title/location substring, case-insensitive
    expect(ids(applyJobBoardFilters(jobs, { payMin: 25 }, cg))).toEqual(["near"]);                  // Flexible (rate 0) is below any minimum
    expect(ids(applyJobBoardFilters(jobs, { payMax: 22 }, cg))).toEqual(["sc", "nocoords"]);
    expect(ids(applyJobBoardFilters(jobs, { timeOfDay: ["evening", "overnight"] }, cg))).toEqual(["sc", "nocoords"]); // any overlap
    expect(ids(applyJobBoardFilters(jobs, { days: ["Sat"] }, cg))).toEqual(["near", "nocoords"]);   // job day startsWith the chip
    expect(ids(applyJobBoardFilters(jobs, { seniors: ["1"] }, cg))).toEqual(["near", "nocoords"]);  // missing recipientsCount counts as 1
    expect(ids(applyJobBoardFilters(jobs, { seniors: ["2"] }, cg))).toEqual(["sc"]);
    expect(ids(applyJobBoardFilters(jobs, { careTypes: ["Personal Care", "Meal Preparation"] }, cg))).toEqual(["sc", "nocoords"]);
  });
  it("controls combine with AND, and the distance rule still applies on top", () => {
    expect(ids(applyJobBoardFilters(jobs, { timeOfDay: ["morning"], days: ["Sat", "Sun"], payMin: 25 }, cg))).toEqual(["near"]);  // far matches every control but is out of range
    expect(ids(applyJobBoardFilters(jobs, { timeOfDay: ["morning"], days: ["Sat", "Sun"], payMin: 25 }, { serviceRadius: 10 }))).toEqual(["near", "far"]);
    expect(ids(applyJobBoardFilters(jobs, { timeOfDay: ["morning"], careTypes: ["Meal Preparation"] }, cg))).toEqual([]);
  });
});
