import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// U13 — enforce the CLAUDE.md seam: components go through services/api.ts
// (dbService / stores), not raw db.collection()/db.doc(). The full migration of
// the existing offenders is mechanical follow-up; this guard makes the seam REAL
// now by RATCHETING — the known-offenders baseline may only SHRINK. A new
// component reaching past the seam fails the build; fixing one and forgetting to
// remove it from the baseline also fails (so the list can't rot).

const ROOT = path.resolve(__dirname, "..");
const DIRECT_DB = /\bdb\.(collection|doc)\(/;

// Baseline captured 2026-06-21 (38 files). DELETE entries as they're migrated;
// never ADD. Goal: empty.
// 2026-06-21: +5 files arrived via the origin/main merge (legacy direct-db
// style, predating this seam) and -1 (CaregiverOnboardingDashboard, rebuilt on
// main without direct db). Net baseline = 42; migration remains mechanical
// follow-up tracked in context/progress-tracker.md.
// 2026-06-21 (cleanup pass): -2 (CaregiverEarnings, HireDecision) — deleted as
// dead/orphaned top-level components, not migrated. Baseline now 40.
// 2026-06-24 (migration pass): -2 (AdminReports, CaregiverBookingsCard) migrated
// off direct db. Baseline now 38.
const KNOWN_OFFENDERS = new Set<string>([
  "components/CarePlan.tsx",
  "components/CaregiverDashboard.tsx",
  "components/CaregiverProfile.tsx",
  "components/FindCaregivers.tsx",
  "components/InboxView.tsx",
  "components/ReviewSystem.tsx",
  "components/Schedule.tsx",
  "components/admin/AdminClientManager.tsx",
  "components/admin/AdminMessages.tsx",
  "components/admin/AssignmentManager.tsx",
  "components/admin/FinanceDashboard.tsx",
  "components/caregiver/CaregiverBookingsPage.tsx",
  "components/caregiver/CaregiverCalendarPage.tsx",
  "components/caregiver/CaregiverCareRequestsCard.tsx",
  "components/caregiver/CaregiverHomeDashboard.tsx",
  "components/caregiver/CaregiverPayments.tsx",
  "components/caregiver/CaregiverPaymentsPage.tsx",
  "components/caregiver/JobBoard.tsx",
  "components/caregiver/PayoutHistory.tsx",
  "components/caregiver/ShiftCheckin.tsx",
  "components/client/AccountSettings.tsx",
  "components/client/CareRequestConfirmModal.tsx",
  "components/client/CaregiverProfileModal.tsx",
  "components/client/CaregiverSearch.tsx",
  "components/client/ClientDashboard.tsx",
  "components/client/ClientVisitsPage.tsx",
  "components/client/CompleteIntake.tsx",
  "components/client/DashboardSidebar.tsx",
  "components/client/EditJobPostModal.tsx",
  "components/client/IntakeModal.tsx",
  "components/client/Payments.tsx",
  "components/client/PostsPage.tsx",
  "components/client/WhatsNext.tsx",
  "components/client/postJob/PostJobFlow.tsx",
  "components/client/postJob/Step2WhoWhere.tsx",
  "components/client/postJob/Step3CareNeeds.tsx",
  "components/landing/FeaturedCaregiversSection.tsx",
]);

function componentFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if ((e.name.endsWith(".tsx") || e.name.endsWith(".ts")) && !e.name.includes(".test.")) {
        out.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(ROOT, "components"));
  return out;
}

describe("no direct db.collection()/db.doc() in components (seam ratchet)", () => {
  const current = new Set(
    componentFiles().filter((f) => DIRECT_DB.test(fs.readFileSync(path.join(ROOT, f), "utf8"))),
  );

  it("no NEW component bypasses the services/api seam", () => {
    const added = [...current].filter((f) => !KNOWN_OFFENDERS.has(f));
    expect(added, "new direct-db component(s) — route through services/api.ts instead").toEqual([]);
  });

  it("the baseline only shrinks — migrated files must be removed from KNOWN_OFFENDERS", () => {
    const stale = [...KNOWN_OFFENDERS].filter((f) => !current.has(f));
    expect(stale, "these were migrated (good!) — delete them from KNOWN_OFFENDERS").toEqual([]);
  });
});
