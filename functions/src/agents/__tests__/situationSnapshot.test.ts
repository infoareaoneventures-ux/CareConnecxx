import { describe, it, expect, vi } from "vitest";

// Transitive imports call admin.firestore() at module load, so the module won't
// import without a firebase-admin stub. These tests exercise only the pure
// formatting functions — the stub just lets the module load; it's never read.
vi.mock("firebase-admin", () => {
  const firestore = () => ({ collection: () => ({ where: () => ({}), doc: () => ({}), add: () => {} }) });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import { formatCaregiverSnapshot, formatClientSnapshot } from "../situationSnapshot";

// The situation snapshot powers the existing "LEAD, DON'T ASK" directive: it
// gives the agent loop a few headline counts (and removes the tool round-trips
// to discover them) so it can open proactively instead of asking "what do you
// need?". These cover the pure formatting — what (if anything) gets surfaced.

const cg = (over: Partial<Parameters<typeof formatCaregiverSnapshot>[0]> = {}) =>
  formatCaregiverSnapshot({
    pendingApplications: 0, hasShiftOffer: false,
    hasJobInvite: false, upcomingVisits: 0, nextVisit: null, ...over,
  });

const client = (over: Partial<Parameters<typeof formatClientSnapshot>[0]> = {}) =>
  formatClientSnapshot({ openJobs: 0, totalApplicants: 0, pendingTimesheets: 0, upcomingVisits: 0, openJobTitle: null, ...over });

describe("formatCaregiverSnapshot", () => {
  it("returns empty string when nothing needs attention", () => {
    expect(cg()).toBe("");
  });

  it("surfaces a pending shift offer and job invite as YES/NO prompts", () => {
    const out = cg({ hasShiftOffer: true, hasJobInvite: true });
    expect(out).toContain("shift offer is awaiting your YES/NO");
    expect(out).toContain("job invite is awaiting your YES/NO");
  });

  it("pluralizes applications correctly", () => {
    expect(cg({ pendingApplications: 1 })).toContain("1 job application still pending");
    expect(cg({ pendingApplications: 2 })).toContain("2 job applications still pending");
  });

  it("surfaces the next visit with time and a count of the rest this week", () => {
    const out = cg({ upcomingVisits: 3, nextVisit: { date: "2026-06-25", startTime: "9:00 AM" } });
    expect(out).toContain("Next visit: 2026-06-25 at 9:00 AM");
    expect(out).toContain("(+2 more in the next 7 days)");
  });

  it("omits the '+N more' suffix when there's only one upcoming visit", () => {
    const out = cg({ upcomingVisits: 1, nextVisit: { date: "2026-06-25" } });
    expect(out).toContain("Next visit: 2026-06-25.");
    expect(out).not.toContain("more in the next 7 days");
  });

  it("always carries the verify-before-acting header when it surfaces anything", () => {
    expect(cg({ pendingApplications: 1 })).toContain("verify with a tool before");
  });
});

describe("formatClientSnapshot", () => {
  it("returns empty string when nothing needs attention", () => {
    expect(client()).toBe("");
  });

  it("folds applicant total into the open-jobs line", () => {
    expect(client({ openJobs: 2, totalApplicants: 5 })).toContain("2 open job posts (5 applicants total)");
  });

  it("names the job when exactly one is open (connect-the-dots)", () => {
    const out = client({ openJobs: 1, totalApplicants: 3, openJobTitle: "weekend coverage for Mom" });
    expect(out).toContain("1 open job post for weekend coverage for Mom (3 applicants total)");
  });

  it("falls back to a count when several jobs are open even if a title is passed", () => {
    const out = client({ openJobs: 3, totalApplicants: 4, openJobTitle: "ignored" });
    expect(out).toContain("3 open job posts (4 applicants total)");
    expect(out).not.toContain("ignored");
  });

  it("omits the applicant parenthetical when there are no applicants", () => {
    const out = client({ openJobs: 1, totalApplicants: 0 });
    expect(out).toContain("1 open job post.");
    expect(out).not.toContain("applicant");
  });

  it("surfaces pending timesheets with correct pluralization", () => {
    expect(client({ pendingTimesheets: 1 })).toContain("1 timesheet waiting for your approval");
    expect(client({ pendingTimesheets: 4 })).toContain("4 timesheets waiting for your approval");
  });

  it("surfaces upcoming visit count", () => {
    expect(client({ upcomingVisits: 1 })).toContain("1 upcoming visit scheduled");
    expect(client({ upcomingVisits: 3 })).toContain("3 upcoming visits scheduled");
  });
});
