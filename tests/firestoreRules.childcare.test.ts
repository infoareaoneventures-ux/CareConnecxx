// @vitest-environment node
//
// Childcare U2 Firestore Rules emulator suite (plan 2026-07-22-002, R59/AE26).
//
// Run via:  npm run test:rules:childcare
//   (firebase emulators:exec --only firestore "npx vitest run tests/firestoreRules.childcare.test.ts")
//
// The suite SELF-SKIPS when FIRESTORE_EMULATOR_HOST is not set (plain
// `npm test` runs, machines without Java) — the always-on static companion is
// tests/firestoreRulesContract.childcare.test.ts. Coverage here: owner,
// scoped adult, non-member, revoked membership, cross-household, broad-admin
// browser denial, and the server-only write posture of every U2 path — plus
// the U3 paths (plan 2026-07-22-002 U3): child_profiles summary reads via the
// authorizedViewerUids derived cache, the fully server-only private zone
// (exact DOB / safety versions / file records), and data_lifecycle_requests.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const EMULATOR = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const ROOT = path.resolve(__dirname, '..');
const HH = 'hh_parent-1';

// Deferred import so machines without the emulator never load the package.
type TestEnv = import('@firebase/rules-unit-testing').RulesTestEnvironment;

if (EMULATOR) {
describe('Childcare U2 Firestore Rules (emulator)', () => {
    let testEnv: TestEnv;
    let assertFails: (p: Promise<unknown>) => Promise<unknown>;
    let assertSucceeds: (p: Promise<unknown>) => Promise<unknown>;

    beforeAll(async () => {
        const rut = await import('@firebase/rules-unit-testing');
        assertFails = rut.assertFails;
        assertSucceeds = rut.assertSucceeds;
        testEnv = await rut.initializeTestEnvironment({
            projectId: 'childcare-rules-test',
            firestore: {
                rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'),
            },
        });
    }, 30_000);

    afterAll(async () => {
        await testEnv?.cleanup();
    }, 30_000);

    beforeEach(async () => {
        await testEnv.clearFirestore();
        // Server-side seed (rules disabled — the Admin SDK posture).
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const db = ctx.firestore();
            await db.doc(`households/${HH}`).set({
                householdId: HH,
                primaryAdultUid: 'parent-1',
                status: 'active',
                accessVersion: 1,
            });
            await db.doc(`household_memberships/${HH}__parent-1`).set({
                membershipId: `${HH}__parent-1`,
                householdId: HH,
                adultUid: 'parent-1',
                role: 'primary',
                status: 'active',
            });
            await db.doc(`household_memberships/${HH}__aunt-1`).set({
                membershipId: `${HH}__aunt-1`,
                householdId: HH,
                adultUid: 'aunt-1',
                role: 'adult',
                status: 'active',
            });
            await db.doc(`household_memberships/${HH}__revoked-1`).set({
                membershipId: `${HH}__revoked-1`,
                householdId: HH,
                adultUid: 'revoked-1',
                role: 'adult',
                status: 'revoked',
            });
            await db.doc('guardian_authorities/child-1__aunt-1').set({
                authorityId: 'child-1__aunt-1',
                householdId: HH,
                childId: 'child-1',
                adultUid: 'aunt-1',
                scopes: ['view'],
                state: 'active',
                accessVersion: 1,
                expiresAt: null,
            });
            await db.doc('guardian_authorities/child-1__parent-1').set({
                authorityId: 'child-1__parent-1',
                householdId: HH,
                childId: 'child-1',
                adultUid: 'parent-1',
                scopes: ['view', 'management'],
                state: 'active',
                accessVersion: 1,
                expiresAt: null,
            });
            await db.doc('childcare_invite_tokens/inv_t1').set({
                tokenId: 'inv_t1',
                householdId: HH,
                invitedByUid: 'parent-1',
                intendedContact: { channel: 'sms', value: '+14085551234' },
                status: 'pending',
                nonceHash: 'hash',
                expiresAt: '2099-01-01T00:00:00.000Z',
            });
            await db.doc('guardianAuthorityOutbox/o1').set({
                outboxId: 'o1',
                kind: 'co_guardian_notice',
                affectedAdultUid: 'aunt-1',
                state: 'pending',
            });
            // Broad admin user doc — must grant NOTHING on the U2 paths (R55).
            await db.doc('users/admin-1').set({ userType: 'admin', isAdmin: true });

            // ── U3 seeds: child profile zones + lifecycle request ──
            await db.doc('child_profiles/child-1').set({
                childId: 'child-1',
                householdId: HH,
                careVertical: 'child',
                displayLabel: 'Mia',
                ageBand: 'school_age',
                careCategories: ['babysitting'],
                state: 'active',
                // Derived viewer cache includes stale-1 deliberately. Rules now
                // require both this cache and live guardian authority.
                authorizedViewerUids: ['parent-1', 'aunt-1', 'stale-1'],
                accessVersion: 1,
                safetyCurrentVersion: 1,
            });
            await db.doc('child_profiles/child-1/private/safety').set({
                childId: 'child-1',
                currentVersion: 1,
                accessVersion: 1,
            });
            await db.doc('child_profiles/child-1/private/safety/versions/1').set({
                childId: 'child-1',
                version: 1,
                data: { dateOfBirth: '2020-03-15', healthNotes: 'peanut allergy' },
                immutable: true,
            });
            await db.doc('child_profiles/child-1/private/file_cf1').set({
                fileId: 'cf1',
                childId: 'child-1',
                path: `childcare/${HH}/child-1/photo/cf1`,
                state: 'uploaded',
            });
            await db.doc('data_lifecycle_requests/dlr_1').set({
                requestId: 'dlr_1',
                scope: 'delete',
                childId: 'child-1',
                requesterUid: 'parent-1',
                state: 'pending',
            });
            await db.doc('childcare_file_scan_operations/cfs_1').set({
                operationId: 'cfs_1',
                childId: 'child-1',
                fileId: 'cf1',
                state: 'dispatched',
            });
            await db.doc('childcare_file_delivery_refs/cdr_1').set({
                deliveryRef: 'cdr_1',
                actorUid: 'parent-1',
                childId: 'child-1',
                kind: 'child_file',
            });
        });
    });

    const as = (uid: string | null) =>
        uid === null
            ? testEnv.unauthenticatedContext().firestore()
            : testEnv.authenticatedContext(uid).firestore();

    describe('/households', () => {
        it('active members (primary and adult) can read their household', async () => {
            await assertSucceeds(as('parent-1').doc(`households/${HH}`).get());
            await assertSucceeds(as('aunt-1').doc(`households/${HH}`).get());
        });

        it('non-members, revoked members, unauthenticated, and broad admins cannot read', async () => {
            await assertFails(as('stranger-1').doc(`households/${HH}`).get());
            await assertFails(as('revoked-1').doc(`households/${HH}`).get());
            await assertFails(as(null).doc(`households/${HH}`).get());
            await assertFails(as('admin-1').doc(`households/${HH}`).get()); // R55/AE18
        });

        it('all browser writes are denied — even the primary adult and admins', async () => {
            await assertFails(as('parent-1').doc(`households/${HH}`).update({ status: 'closed' }));
            await assertFails(as('admin-1').doc(`households/${HH}`).update({ status: 'closed' }));
            await assertFails(
                as('stranger-1').doc('households/hh_stranger-1').set({
                    householdId: 'hh_stranger-1',
                    primaryAdultUid: 'stranger-1',
                    status: 'active',
                }),
            );
        });
    });

    describe('/household_memberships', () => {
        it('an adult reads their OWN membership rows only', async () => {
            await assertSucceeds(as('aunt-1').doc(`household_memberships/${HH}__aunt-1`).get());
            await assertFails(as('aunt-1').doc(`household_memberships/${HH}__parent-1`).get());
            await assertSucceeds(
                as('aunt-1')
                    .collection('household_memberships')
                    .where('adultUid', '==', 'aunt-1')
                    .get(),
            );
            await assertFails(as('aunt-1').collection('household_memberships').get()); // unscoped listing
        });

        it('membership cannot be self-created or edited from the browser', async () => {
            await assertFails(
                as('stranger-1').doc(`household_memberships/${HH}__stranger-1`).set({
                    membershipId: `${HH}__stranger-1`,
                    householdId: HH,
                    adultUid: 'stranger-1',
                    role: 'adult',
                    status: 'active',
                }),
            );
            await assertFails(
                as('aunt-1').doc(`household_memberships/${HH}__aunt-1`).update({ role: 'primary' }),
            );
            await assertFails(
                as('admin-1').doc(`household_memberships/${HH}__aunt-1`).update({ status: 'revoked' }),
            );
        });
    });

    describe('/guardian_authorities', () => {
        it('an adult reads their OWN authority records; cross-adult and cross-household reads fail', async () => {
            await assertSucceeds(as('aunt-1').doc('guardian_authorities/child-1__aunt-1').get());
            await assertFails(as('parent-1').doc('guardian_authorities/child-1__aunt-1').get());
            await assertFails(as('stranger-1').doc('guardian_authorities/child-1__aunt-1').get());
            await assertFails(as('admin-1').doc('guardian_authorities/child-1__aunt-1').get()); // R55
        });

        it('authority can never be self-granted, widened, or revoked from the browser', async () => {
            await assertFails(
                as('stranger-1').doc('guardian_authorities/child-1__stranger-1').set({
                    authorityId: 'child-1__stranger-1',
                    childId: 'child-1',
                    adultUid: 'stranger-1',
                    scopes: ['view', 'pickup', 'management'],
                    state: 'active',
                }),
            );
            await assertFails(
                as('aunt-1').doc('guardian_authorities/child-1__aunt-1').update({
                    scopes: ['view', 'management'],
                }),
            );
            await assertFails(
                as('admin-1').doc('guardian_authorities/child-1__aunt-1').update({ state: 'revoked' }),
            );
        });
    });

    describe('/childcare_invite_tokens (fully server-only)', () => {
        it('reads are denied for everyone — inviter, intended adult, admin', async () => {
            await assertFails(as('parent-1').doc('childcare_invite_tokens/inv_t1').get());
            await assertFails(as('aunt-1').doc('childcare_invite_tokens/inv_t1').get());
            await assertFails(as('admin-1').doc('childcare_invite_tokens/inv_t1').get());
            await assertFails(as(null).doc('childcare_invite_tokens/inv_t1').get());
        });

        it('writes are denied for everyone', async () => {
            await assertFails(
                as('parent-1').doc('childcare_invite_tokens/inv_new').set({ status: 'pending' }),
            );
            await assertFails(
                as('admin-1').doc('childcare_invite_tokens/inv_t1').update({ status: 'accepted' }),
            );
        });
    });

    describe('/guardianAuthorityOutbox (fully server-only)', () => {
        it('reads and writes are denied for everyone, including admins', async () => {
            await assertFails(as('aunt-1').doc('guardianAuthorityOutbox/o1').get());
            await assertFails(as('admin-1').doc('guardianAuthorityOutbox/o1').get());
            await assertFails(as('admin-1').doc('guardianAuthorityOutbox/o1').update({ state: 'completed' }));
        });
    });

    // ── U3: child profiles + privacy lifecycle ──────────────────────────────

    describe('/child_profiles (operational summary)', () => {
        it('cached viewer uids can read the SUMMARY; strangers, admins, unauthenticated cannot', async () => {
            await assertSucceeds(as('parent-1').doc('child_profiles/child-1').get());
            await assertSucceeds(as('aunt-1').doc('child_profiles/child-1').get());
            await assertFails(as('stranger-1').doc('child_profiles/child-1').get());
            await assertFails(as('admin-1').doc('child_profiles/child-1').get()); // R55
            await assertFails(as(null).doc('child_profiles/child-1').get());
        });

        it('a stale cache entry cannot grant a summary or private read without live authority', async () => {
            await assertFails(as('stale-1').doc('child_profiles/child-1').get());
            await assertFails(as('stale-1').doc('child_profiles/child-1/private/safety').get());
        });

        it('revoked and expired authorities deny immediately even if the viewer cache is stale', async () => {
            await testEnv.withSecurityRulesDisabled(async (context) => {
                const db = context.firestore();
                await db.doc('guardian_authorities/child-1__aunt-1').update({
                    state: 'revoked',
                    accessVersion: 2,
                });
            });
            await assertFails(as('aunt-1').doc('child_profiles/child-1').get());

            await testEnv.withSecurityRulesDisabled(async (context) => {
                const db = context.firestore();
                await db.doc('guardian_authorities/child-1__aunt-1').update({
                    state: 'active',
                    expiresAt: '2020-01-01T00:00:00.000Z',
                    accessVersion: 3,
                });
            });
            await assertFails(as('aunt-1').doc('child_profiles/child-1').get());
        });

        it('all browser writes are denied — guardians and admins included', async () => {
            await assertFails(as('parent-1').doc('child_profiles/child-1').update({ displayLabel: 'X' }));
            await assertFails(as('parent-1').doc('child_profiles/child-1').update({
                authorizedViewerUids: ['parent-1', 'attacker-1'], // cache tampering
            }));
            await assertFails(as('admin-1').doc('child_profiles/child-1').update({ state: 'deleted' }));
            await assertFails(as('parent-1').doc('child_profiles/child-new').set({
                childId: 'child-new',
                householdId: HH,
                authorizedViewerUids: ['parent-1'],
            }));
        });
    });

    describe('/child_profiles private zone (fully server-only)', () => {
        it('NOBODY browser-reads the private zone — not even the primary guardian (exact DOB lives here)', async () => {
            await assertFails(as('parent-1').doc('child_profiles/child-1/private/safety').get());
            await assertFails(as('parent-1').doc('child_profiles/child-1/private/safety/versions/1').get());
            await assertFails(as('aunt-1').doc('child_profiles/child-1/private/file_cf1').get());
            await assertFails(as('admin-1').doc('child_profiles/child-1/private/safety/versions/1').get());
            await assertFails(as(null).doc('child_profiles/child-1/private/safety').get());
        });

        it('private-zone writes are denied for everyone', async () => {
            await assertFails(
                as('parent-1').doc('child_profiles/child-1/private/safety/versions/2').set({
                    version: 2,
                    data: { dateOfBirth: '2020-03-15' },
                }),
            );
            await assertFails(
                as('admin-1').doc('child_profiles/child-1/private/safety').update({ currentVersion: 0 }),
            );
        });
    });

    describe('/data_lifecycle_requests (fully server-only)', () => {
        it('reads are denied for everyone — including the requester (status flows through the callable)', async () => {
            await assertFails(as('parent-1').doc('data_lifecycle_requests/dlr_1').get());
            await assertFails(as('admin-1').doc('data_lifecycle_requests/dlr_1').get());
            await assertFails(as(null).doc('data_lifecycle_requests/dlr_1').get());
        });

        it('writes are denied for everyone', async () => {
            await assertFails(
                as('parent-1').doc('data_lifecycle_requests/dlr_new').set({ scope: 'delete', childId: 'child-1' }),
            );
            await assertFails(
                as('admin-1').doc('data_lifecycle_requests/dlr_1').update({ state: 'completed' }),
            );
        });
    });

    describe('/childcare file scan and delivery control records (fully server-only)', () => {
        it('denies reads and writes to scan operations and delivery refs for every browser role', async () => {
            for (const uid of [null, 'parent-1', 'admin-1']) {
                await assertFails(as(uid).doc('childcare_file_scan_operations/cfs_1').get());
                await assertFails(as(uid).doc('childcare_file_delivery_refs/cdr_1').get());
            }
            await assertFails(
                as('parent-1').doc('childcare_file_scan_operations/cfs_evil').set({ state: 'clean' }),
            );
            await assertFails(
                as('admin-1').doc('childcare_file_delivery_refs/cdr_evil').set({ actorUid: 'admin-1' }),
            );
        });
    });

    // ── U5: provider vertical profiles + screenings ─────────────────────────

    describe('/caregivers/{uid}/vertical_profiles (owner-read, server-write)', () => {
        beforeEach(async () => {
            await testEnv.withSecurityRulesDisabled(async (ctx) => {
                const db = ctx.firestore();
                await db.doc('caregivers/cg-1').set({
                    name: 'Jane Doe', status: 'active', verificationStatus: 'approved',
                });
                await db.doc('caregivers/cg-1/vertical_profiles/child').set({
                    careVertical: 'child', caregiverUid: 'cg-1', jurisdictionState: 'CA',
                    approval: { state: 'none' },
                });
                await db.doc('caregivers/cg-1/screenings/child').set({
                    careVertical: 'child', caregiverUid: 'cg-1', evidenceStatus: 'clear',
                    checkr: { candidateId: 'cand_1' },
                });
            });
        });

        it('the owning caregiver reads their OWN vertical profile; others cannot', async () => {
            await assertSucceeds(as('cg-1').doc('caregivers/cg-1/vertical_profiles/child').get());
            await assertFails(as('stranger-1').doc('caregivers/cg-1/vertical_profiles/child').get());
            await assertFails(as('admin-1').doc('caregivers/cg-1/vertical_profiles/child').get()); // R55
            await assertFails(as(null).doc('caregivers/cg-1/vertical_profiles/child').get());
        });

        it('vertical-profile writes are denied for everyone — approval/acceptance/suspension are server-owned', async () => {
            await assertFails(
                as('cg-1').doc('caregivers/cg-1/vertical_profiles/child').update({
                    approval: { state: 'approved' }, // self-approval attempt (R28)
                }),
            );
            await assertFails(
                as('cg-1').doc('caregivers/cg-1/vertical_profiles/senior').set({ careVertical: 'senior' }),
            );
            await assertFails(
                as('admin-1').doc('caregivers/cg-1/vertical_profiles/child').update({ suspension: { active: false } }),
            );
        });

        it('screenings are FULLY server-only — evidence is never browser-readable, owner included', async () => {
            await assertFails(as('cg-1').doc('caregivers/cg-1/screenings/child').get());
            await assertFails(as('stranger-1').doc('caregivers/cg-1/screenings/child').get());
            await assertFails(as('admin-1').doc('caregivers/cg-1/screenings/child').get());
            await assertFails(
                as('cg-1').doc('caregivers/cg-1/screenings/child').update({ evidenceStatus: 'clear' }),
            );
            await assertFails(
                as('cg-1').doc('caregivers/cg-1/screenings/senior').set({ evidenceStatus: 'clear' }),
            );
        });

        it('a caregiver cannot self-write the derived childcareProvider summary (update, submitted-escape, create)', async () => {
            await assertFails(
                as('cg-1').doc('caregivers/cg-1').update({ childcareProvider: { visible: true } }),
            );
            await assertFails(
                as('cg-1').doc('caregivers/cg-1').update({
                    verificationStatus: 'submitted',
                    onboardingStep: 'x',
                    backgroundCheckData: {},
                    childcareProvider: { visible: true },
                }),
            );
            await assertFails(
                as('cg-2').doc('caregivers/cg-2').set({
                    name: 'Mallory', childcareProvider: { visible: true },
                }),
            );
            // The plain self-create without childcareProvider still works (unchanged senior signup).
            await assertSucceeds(as('cg-2').doc('caregivers/cg-2').set({ name: 'Mallory' }));
        });
    });

    // ── U7: booking safety projections + childcare booking write posture ──
    describe('U7 booking / safety projection posture (R11/R36/R38/R46)', () => {
        beforeEach(async () => {
            await testEnv.withSecurityRulesDisabled(async (ctx) => {
                const db = ctx.firestore();
                await db.doc('booking_requests/cbook_1').set({
                    careVertical: 'child',
                    bookingId: 'cbook_1',
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    childIds: ['child-1'],
                    status: 'requested',
                });
                await db.doc('booking_requests/senior-b1').set({
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    status: 'pending',
                });
                await db.doc('childcare_booking_safety/cbook_1').set({
                    bookingId: 'cbook_1',
                    childIds: ['child-1'],
                    assignedCaregiverUid: 'cg-1',
                    currentVersion: 1,
                    accessVersion: 1,
                    state: 'active',
                });
                await db.doc('childcare_booking_safety/cbook_1/versions/1').set({
                    bookingId: 'cbook_1',
                    version: 1,
                    grantAccessVersion: 1,
                    children: [{ childId: 'child-1', displayLabel: 'M.' }],
                    immutable: true,
                });
                await db.doc('appointments/cappt_1').set({
                    careVertical: 'child',
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    childcareBookingId: 'cbook_1',
                    date: '2026-08-10',
                    status: 'confirmed',
                });
                await db.doc('shifts/cshift_1').set({
                    careVertical: 'child',
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    bookingRequestId: 'cbook_1',
                    status: 'scheduled',
                });
            });
        });

        it('childcare_booking_safety is unreadable and unwritable by EVERYONE — assigned caregiver, family, admin', async () => {
            for (const uid of ['cg-1', 'parent-1', 'admin-1', 'stranger-1']) {
                await assertFails(as(uid).doc('childcare_booking_safety/cbook_1').get());
                await assertFails(as(uid).doc('childcare_booking_safety/cbook_1/versions/1').get());
                await assertFails(
                    as(uid).doc('childcare_booking_safety/cbook_1').update({ assignedCaregiverUid: uid }),
                );
                await assertFails(
                    as(uid).doc('childcare_booking_safety/cbook_1/versions/2').set({ children: [] }),
                );
            }
        });

        it('a browser can neither create a childcare booking nor mutate one (direct write denial)', async () => {
            await assertFails(
                as('parent-1').doc('booking_requests/cbook_evil').set({
                    careVertical: 'child',
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    status: 'requested',
                }),
            );
            await assertFails(
                as('cg-1').doc('booking_requests/cbook_1').update({ status: 'accepted' }),
            );
            // Converting a senior booking INTO a childcare booking is denied too.
            await assertFails(
                as('parent-1').doc('booking_requests/senior-b1').update({ careVertical: 'child' }),
            );
            // Participants can still READ their own childcare booking (safe by construction).
            await assertSucceeds(as('parent-1').doc('booking_requests/cbook_1').get());
            await assertSucceeds(as('cg-1').doc('booking_requests/cbook_1').get());
            await assertFails(as('admin-1').doc('booking_requests/cbook_1').get());
            await assertSucceeds(as('admin-1').doc('booking_requests/senior-b1').get());
            await assertFails(as('stranger-1').doc('booking_requests/cbook_1').get());
        });

        it('legacy senior booking_requests behavior is untouched (create + participant update)', async () => {
            await assertSucceeds(
                as('parent-1').doc('booking_requests/senior-new').set({
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    status: 'pending',
                }),
            );
            await assertSucceeds(
                as('cg-1').doc('booking_requests/senior-b1').update({ status: 'accepted' }),
            );
        });

        it('broad admin cannot list mixed child-bearing shared collections', async () => {
            await assertFails(as('admin-1').collection('booking_requests').get());
            await assertFails(as('admin-1').collection('appointments').get());
            await assertFails(as('admin-1').collection('chatRooms').get());
        });

        it('childcare appointments and shifts are server-only for browsers (create + update denied)', async () => {
            await assertFails(
                as('cg-1').doc('appointments/cappt_evil').set({
                    careVertical: 'child',
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    status: 'confirmed',
                }),
            );
            await assertFails(as('cg-1').doc('appointments/cappt_1').update({ status: 'in-progress' }));
            await assertFails(
                as('cg-1').doc('shifts/cshift_evil').set({
                    careVertical: 'child',
                    caregiverId: 'cg-1',
                    status: 'scheduled',
                }),
            );
            await assertFails(as('cg-1').doc('shifts/cshift_1').update({ status: 'in-progress' }));
            // Participant reads stay allowed (safe projections inside authed views).
            await assertSucceeds(as('cg-1').doc('appointments/cappt_1').get());
            await assertSucceeds(as('parent-1').doc('shifts/cshift_1').get());
            await assertFails(as('admin-1').doc('appointments/cappt_1').get());
            await assertFails(as('admin-1').doc('shifts/cshift_1').get());
        });

        it('legacy senior appointment/shift writes are untouched (characterization)', async () => {
            await assertSucceeds(
                as('parent-1').doc('appointments/senior-a1').set({
                    clientId: 'parent-1',
                    caregiverId: 'cg-1',
                    date: '2026-08-10',
                    status: 'pending_caregiver_confirmation',
                }),
            );
            await assertSucceeds(
                as('cg-1').doc('shifts/senior-s1').set({
                    caregiverId: 'cg-1',
                    clientId: 'parent-1',
                    status: 'in-progress',
                }),
            );
        });
    });

    describe('U9 childcare context-chat posture (R41-R42/R55/KTD14)', () => {
        beforeEach(async () => {
            await testEnv.withSecurityRulesDisabled(async (ctx) => {
                const db = ctx.firestore();
                await db.doc('chatRooms/cchat_room1').set({
                    careVertical: 'child',
                    roomId: 'cchat_room1',
                    contextType: 'booking',
                    contextId: 'cbook_1',
                    householdId: HH,
                    participants: ['parent-1', 'cg-1'],
                    participantNames: ['Ana', 'Pat'],
                    state: 'active',
                    accessVersion: 1,
                    lastMessage: 'New message',
                    unreadCount: { 'parent-1': 0, 'cg-1': 1 },
                });
                await db.doc('chatRooms/cchat_room1/messages/m1').set({
                    chatRoomId: 'cchat_room1',
                    senderId: 'parent-1',
                    senderName: 'Ana',
                    text: 'see you at 3',
                    type: 'text',
                    disclosurePhase: 'pre_booking',
                    accessVersion: 1,
                    createdAt: '2026-07-23T18:00:00.000Z',
                    isRead: false,
                    readBy: [],
                });
                await db.doc('chatRooms/senior_room1').set({
                    participants: ['parent-1', 'cg-1'],
                    participantNames: ['Ana', 'Pat'],
                    lastMessage: 'hello',
                    unreadCount: { 'parent-1': 0, 'cg-1': 0 },
                });
            });
        });

        it('browser can NEVER create a childcare-vertical room (senior create unchanged)', async () => {
            await assertFails(
                as('parent-1').doc('chatRooms/cchat_evil').set({
                    careVertical: 'child',
                    participants: ['parent-1', 'cg-1'],
                }),
            );
            // Senior pairwise create by a participant still works (compat).
            await assertSucceeds(
                as('parent-1').doc('chatRooms/senior_new').set({
                    participants: ['parent-1', 'cg-1'],
                    participantNames: ['Ana', 'Pat'],
                    lastMessage: '',
                    unreadCount: { 'parent-1': 0, 'cg-1': 0 },
                }),
            );
        });

        it('childcare room update/delete is server-only, even for participants and admin', async () => {
            await assertFails(
                as('parent-1').doc('chatRooms/cchat_room1').update({ participants: ['parent-1'] }),
            );
            await assertFails(
                as('cg-1').doc('chatRooms/cchat_room1').update({ state: 'active', accessVersion: 99 }),
            );
            await assertFails(as('admin-1').doc('chatRooms/cchat_room1').delete());
            // Senior room updates by participants unchanged.
            await assertSucceeds(
                as('parent-1').doc('chatRooms/senior_room1').update({ lastMessage: 'hey' }),
            );
        });

        it('childcare messages: CURRENT participants read; strangers, revoked adults, and ADMIN denied (R55)', async () => {
            await assertSucceeds(as('parent-1').doc('chatRooms/cchat_room1/messages/m1').get());
            await assertSucceeds(as('cg-1').doc('chatRooms/cchat_room1/messages/m1').get());
            await assertFails(as('stranger-1').doc('chatRooms/cchat_room1/messages/m1').get());
            await assertFails(as('admin-1').doc('chatRooms/cchat_room1/messages/m1').get());
            // Revocation removes the uid from participants — reads die with it.
            await testEnv.withSecurityRulesDisabled(async (ctx) => {
                await ctx.firestore().doc('chatRooms/cchat_room1').update({
                    participants: ['parent-1'],
                    state: 'revoked',
                    accessVersion: 2,
                });
            });
            await assertFails(as('cg-1').doc('chatRooms/cchat_room1/messages/m1').get());
            await assertSucceeds(as('parent-1').doc('chatRooms/cchat_room1/messages/m1').get());
        });

        it('childcare message WRITES are server-only (participants and admin both denied); senior writes unchanged', async () => {
            await assertFails(
                as('parent-1').doc('chatRooms/cchat_room1/messages/m2').set({
                    chatRoomId: 'cchat_room1',
                    senderId: 'parent-1',
                    text: 'browser write',
                }),
            );
            await assertFails(
                as('admin-1').doc('chatRooms/cchat_room1/messages/m1').update({ text: 'edited' }),
            );
            await assertSucceeds(
                as('parent-1').doc('chatRooms/senior_room1/messages/s1').set({
                    chatRoomId: 'senior_room1',
                    senderId: 'parent-1',
                    text: 'senior message',
                }),
            );
        });

        it('child room docs stay participant-only; broad admin has no child-bearing read shortcut', async () => {
            await assertSucceeds(as('parent-1').doc('chatRooms/cchat_room1').get());
            await assertFails(as('admin-1').doc('chatRooms/cchat_room1').get());
            await assertFails(as('stranger-1').doc('chatRooms/cchat_room1').get());
        });
    });

    describe('review moderation and quality telemetry posture', () => {
        beforeEach(async () => {
            await testEnv.withSecurityRulesDisabled(async (ctx) => {
                const db = ctx.firestore();
                await db.doc('reviews/public_child_review').set({
                    schemaVersion: 'childcare-review-public-v1',
                    careVertical: 'child',
                    sourceReviewId: 'private_review_1',
                    sourceVersion: 1,
                    sourceStateVersion: 2,
                    caregiverId: 'cg-1',
                    reviewerRole: 'family',
                    rating: 5,
                    comment: 'Reliable care',
                    moderationState: 'published',
                    isPublic: true,
                });
                await db.doc('reviews/pending_child_review').set({
                    schemaVersion: 'childcare-review-public-v1',
                    careVertical: 'child',
                    sourceReviewId: 'private_review_2',
                    sourceVersion: 1,
                    sourceStateVersion: 1,
                    caregiverId: 'cg-1',
                    rating: 4,
                    moderationState: 'pending',
                    isPublic: false,
                });
                await db.doc('reviews/senior_review').set({
                    caregiverId: 'cg-1',
                    clientId: 'parent-1',
                    rating: 5,
                });
                await db.doc('childcare_review_submissions/private_review_1').set({
                    careVertical: 'child',
                    reviewerUid: 'parent-1',
                    comment: 'Raw private review',
                    moderationState: 'published',
                });
                await db.doc('childcare_quality_events/event_1').set({
                    schemaVersion: 'childcare-quality-v1',
                    careVertical: 'child',
                    principalHash: 'abc',
                    eventCode: 'conversation_repair',
                });
            });
        });

        it('reads valid public projections and senior reviews, but not pending child rows', async () => {
            await assertSucceeds(as(null).doc('reviews/public_child_review').get());
            await assertSucceeds(as(null).doc('reviews/senior_review').get());
            await assertFails(as(null).doc('reviews/pending_child_review').get());
            await assertFails(as('admin-1').doc('reviews/pending_child_review').get());
        });

        it('private originals and quality events are unreadable and unwritable in browsers', async () => {
            for (const uid of [null, 'parent-1', 'admin-1']) {
                await assertFails(as(uid).doc('childcare_review_submissions/private_review_1').get());
                await assertFails(as(uid).doc('childcare_quality_events/event_1').get());
            }
            await assertFails(
                as('admin-1').doc('childcare_review_submissions/private_review_1').update({
                    moderationState: 'published',
                }),
            );
            await assertFails(
                as('parent-1').doc('childcare_quality_events/event_evil').set({
                    careVertical: 'child',
                }),
            );
        });

        it('browser clients cannot create, edit, or delete childcare public projections', async () => {
            await assertFails(
                as('parent-1').doc('reviews/forged_child_review').set({
                    schemaVersion: 'childcare-review-public-v1',
                    careVertical: 'child',
                    sourceReviewId: 'private_review_1',
                    sourceVersion: 1,
                    clientId: 'parent-1',
                    moderationState: 'published',
                    isPublic: true,
                }),
            );
            await assertFails(
                as('parent-1').doc('reviews/public_child_review').update({ comment: 'Changed' }),
            );
            await assertFails(as('admin-1').doc('reviews/public_child_review').delete());
        });
    });

    // ── U12: restricted incident cases + operator scope grants (R55/R56/AE18/AE26) ──
    describe('U12 incident cases + operator grants posture', () => {
        beforeEach(async () => {
            await testEnv.withSecurityRulesDisabled(async (ctx) => {
                const db = ctx.firestore();
                await db.doc('childcare_incidents/cinc_1').set({
                    caseId: 'cinc_1',
                    careVertical: 'child',
                    category: 'injury',
                    source: 'marker',
                    status: 'open',
                    ownerUid: null,
                    suspectedPartyUids: ['cg-1'],
                    createdAt: '2026-07-23T18:00:00.000Z',
                });
                await db.doc('childcare_incidents/cinc_1/restricted/note1').set({
                    note: 'restricted case content',
                });
                await db.doc('childcare_operators/op-safety').set({
                    operatorUid: 'op-safety',
                    scopes: ['childSafetyOperator'],
                    active: true,
                });
            });
        });

        it('incident cases are unreadable by EVERYONE in the browser — admin, operator, participant, stranger (R55/AE18)', async () => {
            await assertFails(as('admin-1').doc('childcare_incidents/cinc_1').get());
            await assertFails(as('op-safety').doc('childcare_incidents/cinc_1').get());
            await assertFails(as('parent-1').doc('childcare_incidents/cinc_1').get());
            await assertFails(as('cg-1').doc('childcare_incidents/cinc_1').get());
            await assertFails(as(null).doc('childcare_incidents/cinc_1').get());
        });

        it('incident cases are unwritable from the browser (create/update/delete) even for admins', async () => {
            await assertFails(
                as('admin-1').doc('childcare_incidents/cinc_evil').set({ category: 'injury', status: 'open' }),
            );
            await assertFails(
                as('admin-1').doc('childcare_incidents/cinc_1').update({ status: 'resolved' }),
            );
            await assertFails(as('admin-1').doc('childcare_incidents/cinc_1').delete());
        });

        it('the restricted subcollection is a recursive deny', async () => {
            await assertFails(as('admin-1').doc('childcare_incidents/cinc_1/restricted/note1').get());
            await assertFails(as('op-safety').doc('childcare_incidents/cinc_1/restricted/note1').get());
        });

        it('operator scope grants are unreadable and unwritable from the browser — self-grant impossible', async () => {
            await assertFails(as('op-safety').doc('childcare_operators/op-safety').get());
            await assertFails(as('admin-1').doc('childcare_operators/op-safety').get());
            await assertFails(
                as('admin-1').doc('childcare_operators/admin-1').set({
                    operatorUid: 'admin-1',
                    scopes: ['childSafetyOperator'],
                    active: true,
                }),
            );
            await assertFails(
                as('op-safety').doc('childcare_operators/op-safety').update({ scopes: ['childSafetyOperator', 'generalOperator'] }),
            );
        });
    });
});

}

if (!EMULATOR) {
describe('Childcare U2 Firestore Rules (emulator not available)', () => {
    it('skipped — run `npm run test:rules:childcare` with the Firestore emulator (requires Java); static posture is pinned by tests/firestoreRulesContract.childcare.test.ts', () => {
        expect(EMULATOR).toBe(false);
    });
});
}
