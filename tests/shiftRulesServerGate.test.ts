import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// 2026-10-11 (founder: "3 fix. not leaving it for later"): a caregiver can no
// longer write the Start / End / Cancel / Log Hours status transitions on
// shifts/{id} from the browser. They go through the visit_action_requests
// queue and functions/src/shifts/visitActions.ts enforces the membership +
// background gate, the 15-minute Start window, one visit at a time and the
// 24-hour cancel rule server-side. The repo has no rules emulator in CI, so
// this guard pins the rule TEXT: if someone loosens the shifts block or drops
// the queue block, this fails.

const ROOT = path.resolve(__dirname, '..');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

function block(name: string): string {
    const start = rules.indexOf(`match /${name} {`);
    expect(start, `firestore.rules has no match /${name}/ block`).toBeGreaterThan(-1);
    const next = rules.indexOf('\n    match /', start + 1);
    return rules.slice(start, next === -1 ? undefined : next);
}

describe('firestore.rules — shifts: caregiver status transitions are server-owned', () => {
    const shifts = block('shifts/{shiftId}');

    it('an in-progress visit accepts only the Tasks checklist and the visit-notes log from the caregiver', () => {
        expect(shifts).toMatch(/resource\.data\.status == 'in-progress' &&\s*request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\s*\.hasOnly\(\['tasksCompleted', 'notesLog', 'updatedAt'\]\)/);
    });

    it('a scheduled / active / pending visit can never be moved by the caregiver into in-progress, completed, cancelled or needs_replacement', () => {
        expect(shifts).toMatch(/!\(request\.resource\.data\.status in \['in-progress', 'completed', 'cancelled', 'needs_replacement'\]\)/);
        // The pre-2026-10-11 grant (any update on an in-progress / pending shift) is gone.
        expect(shifts).not.toMatch(/resource\.data\.status == 'in-progress' \|\| resource\.data\.status == 'pending'\)\)/);
    });

    it('the family and admin paths are unchanged', () => {
        expect(shifts).toMatch(/resource\.data\.clientId == request\.auth\.uid &&\s*\(resource\.data\.status == 'scheduled' \|\| resource\.data\.status == 'pending' \|\|\s*resource\.data\.status == 'needs_replacement'\)/);
        expect(shifts).toMatch(/allow delete: if isAdmin\(\);/);
    });

    // 2026-10-11 (caregiver sweep follow-up): the accepted-schedule-change visits
    // moved to the server (onBookingAmendmentAccepted), so a caregiver may only
    // CREATE a 'scheduled' visit of their own — never one in any other status.
    // The family's pending extra-visit request create is unchanged.
    it('a caregiver can create only a scheduled visit of their own; the family keeps the pending extra-visit create', () => {
        const create = shifts.slice(shifts.indexOf('allow create:'), shifts.indexOf('allow read:'));
        expect(create).toMatch(/\(request\.resource\.data\.caregiverId == request\.auth\.uid &&\s*request\.resource\.data\.status == 'scheduled'\)/);
        // The pre-2026-10-11 grant (any status for the caregiver's own caregiverId) is gone.
        expect(create).not.toMatch(/request\.resource\.data\.caregiverId == request\.auth\.uid \|\|/);
        expect(create).toMatch(/request\.resource\.data\.clientId == request\.auth\.uid &&\s*request\.resource\.data\.status == 'pending' &&\s*request\.resource\.data\.createdBy == 'client'/);
    });
});

describe('firestore.rules — booking_amendments: the caregiver writes only the two buttons', () => {
    const amendments = block('booking_amendments/{amendmentId}');

    it("accept / decline a PENDING request of their own = {status, respondedAt}, nothing else (the server's stamp and the visits are admin writes)", () => {
        expect(amendments).toMatch(/resource\.data\.caregiverId == request\.auth\.uid &&\s*resource\.data\.status == 'pending' &&\s*request\.resource\.data\.status in \['accepted', 'declined'\] &&\s*request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\s*\.hasOnly\(\['status', 'respondedAt'\]\)/);
        // the family's retract and the admin path stay
        expect(amendments).toMatch(/resource\.data\.clientId == request\.auth\.uid && resource\.data\.status == 'pending'/);
        expect(amendments).toMatch(/isAdmin\(\)\s*\);/);
    });
});

describe('the caregiver Bookings page no longer builds the visits in the browser', () => {
    it('CaregiverBookingsPage.tsx accepts a schedule change with the one amendment write — no shifts batch, no schedule merge', () => {
        const src = fs.readFileSync(path.join(ROOT, 'components/caregiver/CaregiverBookingsPage.tsx'), 'utf8');
        expect(src).not.toMatch(/collection\('shifts'\)\.doc\(\)/);
        expect(src).not.toMatch(/'schedule\.dayShiftTimes'/);
        expect(src).toMatch(/collection\('booking_amendments'\)\.doc\(amendment\.id\)\.update\(\{\s*status: 'accepted',\s*respondedAt: firebase\.firestore\.FieldValue\.serverTimestamp\(\),\s*\}\)/);
    });

    it("Evia's twin (functions/src/agents/caregiverBookingRequests.ts) is the same one write", () => {
        const src = fs.readFileSync(path.join(ROOT, 'functions/src/agents/caregiverBookingRequests.ts'), 'utf8');
        expect(src).not.toMatch(/collection\("shifts"\)/);
        expect(src).not.toMatch(/"schedule\.dayShiftTimes"/);
        expect(src).toContain('await r.ref.update({ status: "accepted", respondedAt: admin.firestore.FieldValue.serverTimestamp() });');
    });

    it('the trigger that generates instead is registered', () => {
        const index = fs.readFileSync(path.join(ROOT, 'functions/src/index.ts'), 'utf8');
        expect(index).toMatch(/export \{[^}]*onBookingAmendmentAccepted[^}]*\} from '\.\/scheduled\/shiftGenerator'/);
    });
});

describe('firestore.rules — visit_action_requests: the queue the site writes instead', () => {
    const queue = block('visit_action_requests/{requestId}');

    it('only the signed-in caregiver named on the request may create it (or an admin acting for them during an open consent window — admin assist, 2026-10-22), with the five actions and the known payload keys', () => {
        expect(queue).toContain("request.resource.data.type in ['start_visit', 'end_visit', 'cancel_visit', 'cancel_booking', 'log_hours']");
        expect(queue).toContain("request.resource.data.status == 'pending'");
        expect(queue).toContain("request.auth != null");
        expect(queue).toContain("(request.auth.uid == request.resource.data.caregiverId || actingFor(request.resource.data.caregiverId))");
        expect(queue).toMatch(/keys\(\)\.hasOnly\(\s*\['type', 'status', 'createdAt', 'caregiverId', 'shiftId',\s*'closingNote', 'startedAt', 'completedAt', 'tasksCompleted', 'completionNotes'\]/);
    });

    it('only that caregiver (or an admin) reads it back; nobody updates or deletes from the client', () => {
        expect(queue).toContain('allow read: if request.auth != null && (request.auth.uid == resource.data.caregiverId || isAdmin());');
        expect(queue).toContain('allow update, delete: if false;');
    });
});

describe('the caregiver pages no longer write those statuses directly', () => {
    const pages = [
        'components/caregiver/CaregiverBookingsPage.tsx',
        'components/caregiver/CaregiverCalendarPage.tsx',
        'components/caregiver/CaregiverHomeDashboard.tsx',
    ];
    for (const p of pages) {
        it(`${p} submits Start / End / Cancel through submitVisitAction`, () => {
            const src = fs.readFileSync(path.join(ROOT, p), 'utf8');
            expect(src).toContain("from '../../services/visitActionQueue'");
            expect(src).not.toMatch(/status: 'in-progress',\s*\n\s*startedAt:/);
            expect(src).not.toMatch(/status: 'completed',\s*\n\s*(completedAt|startedAt):/);
            expect(src).not.toMatch(/status: isUrgent \? 'needs_replacement' : 'cancelled'/);
            expect(src).not.toMatch(/loggedManually: true/);
        });
    }
});
