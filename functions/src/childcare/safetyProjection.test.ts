// U7 versioned booking safety projection tests (plan 2026-07-22-002,
// KTD13/R38/AE6/AE20).
//
// Scenarios: exact allowlist field set; minimum projection excludes
// DOB/custody/address; revoke-before-replace BY CONSTRUCTION (every new
// version bumps the access version — old versions dead); gated read by
// assigned-current / unassigned / revoked-version caregiver; live staleness
// check (safety change invalidates); authority-change reprojection fan-out;
// the REAL assigned-provider file-grant source (replaces the U3 dark stub).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (jobCallables pattern + array-contains + "in") ──
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const valueAt = (doc: any, path: string): unknown =>
    path.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = valueAt(doc, f.field);
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "array-contains") return Array.isArray(v) && v.includes(f.value);
    return false;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
      ref: makeDocRef(path),
    }),
    set: async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(path)) {
        const err: any = new Error(`5 NOT_FOUND: ${path}`);
        err.code = 5;
        throw err;
      }
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = [], lim?: number): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }], lim),
    orderBy: () => makeQuery(collPath, filters, lim),
    limit: (n: number) => makeQuery(collPath, filters, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(
          ([p]) =>
            p.startsWith(`${collPath}/`) &&
            p.split("/").length === collPath.split("/").length + 1,
        )
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => matches(r._raw, f)));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => {
    const q = makeQuery(path);
    return {
      doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${docs.size}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${path}/auto-${docs.size}`);
        await ref.set(data);
        return ref;
      },
      where: q.where,
      limit: q.limit,
      get: q.get,
    };
  };

  const runTransaction = async (fn: any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => {
        void ref.set(data, opts);
      },
      update: (ref: any, data: any) => {
        docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
      },
    };
    return fn(tx);
  };

  return {
    docs,
    db: { collection: (p: string) => makeCollRef(p), runTransaction },
    reset: () => docs.clear(),
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => hoisted.db;
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));

const recheckMock = vi.hoisted(() => vi.fn(async () => ({ eligible: true })));
vi.mock("./providerEligibility", () => ({
  recheckChildcareProviderEligibility: recheckMock,
}));

import {
  buildChildSafetyProjection,
  createSafetyProjectionVersion,
  readSafetyProjectionForCaregiver,
  revokeSafetyProjectionAccess,
  reprojectActiveBookingSafetyForChild,
  createBookingAssignedProviderSource,
  CHILD_SAFETY_PROJECTION_FIELDS,
  SafetyProjectionError,
} from "./safetyProjection";

const BOOKING = "cbook_1";
const CG = "cg-1";
const CHILD = "child-a";

function seedChild(childId = CHILD, safetyVersion = 1) {
  hoisted.docs.set(`child_profiles/${childId}`, {
    childId,
    householdId: "hh_1",
    careVertical: "child",
    displayLabel: "M.",
    ageBand: "preschool",
    state: "active",
    safetyCurrentVersion: safetyVersion,
    accessVersion: 1,
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety`, {
    childId,
    currentVersion: safetyVersion,
    accessVersion: safetyVersion,
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety/versions/${safetyVersion}`, {
    childId,
    version: safetyVersion,
    data: {
      dateOfBirth: "2022-04-01",
      emergencyContacts: [{ name: "Ana Adult", relationship: "parent", phone: "+15551230000" }],
      healthNotes: "mild asthma",
      allergiesNote: "peanuts",
      pickupNotes: "Only Ana or Ben may pick up",
      custodyNotes: "RESTRICTED custody detail",
      addressDetail: "123 Exact St",
    },
    immutable: true,
  });
}

function seedBooking(status = "confirmed", caregiverId = CG) {
  hoisted.docs.set(`booking_requests/${BOOKING}`, {
    careVertical: "child",
    bookingId: BOOKING,
    clientId: "family-1",
    caregiverId,
    childIds: [CHILD],
    status,
  });
}

beforeEach(() => {
  hoisted.reset();
  recheckMock.mockReset();
  recheckMock.mockResolvedValue({ eligible: true });
});

// ── Allowlist + minimum projection ───────────────────────────────────────────

describe("minimum projection allowlist (R38/R10)", () => {
  it("the allowlist is EXACTLY the declared field set", () => {
    expect([...CHILD_SAFETY_PROJECTION_FIELDS].sort()).toEqual([
      "ageBand",
      "allergiesNote",
      "childId",
      "displayLabel",
      "emergencyContacts",
      "healthNotes",
      "pickupNotes",
      "sourceSafetyVersion",
    ]);
  });

  it("buildChildSafetyProjection emits exactly the allowlisted keys — never DOB/custody/address", () => {
    seedChild();
    const profile = hoisted.docs.get(`child_profiles/${CHILD}`);
    const safetyVersion = hoisted.docs.get(`child_profiles/${CHILD}/private/safety/versions/1`);
    const projection = buildChildSafetyProjection(profile, safetyVersion);
    expect(Object.keys(projection).sort()).toEqual([...CHILD_SAFETY_PROJECTION_FIELDS].sort());
    const json = JSON.stringify(projection);
    expect(json).not.toContain("2022-04-01");       // exact DOB
    expect(json).not.toContain("RESTRICTED");        // custody
    expect(json).not.toContain("123 Exact St");      // exact address
    expect(projection.pickupNotes).toBe("Only Ana or Ben may pick up");
    expect(projection.emergencyContacts).toHaveLength(1);
    expect(projection.sourceSafetyVersion).toBe(1);
  });
});

// ── Revoke-before-replace by construction ────────────────────────────────────

describe("createSafetyProjectionVersion (KTD13/AE6)", () => {
  it("v1 grants at accessVersion 1; every new version bumps the access version (old versions die)", async () => {
    seedChild();
    const v1 = await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
    expect(v1.pointer).toMatchObject({ currentVersion: 1, accessVersion: 1, state: "active", assignedCaregiverUid: CG });
    expect(v1.version.grantAccessVersion).toBe(1);
    expect(v1.version.immutable).toBe(true);

    const v2 = await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
    expect(v2.pointer).toMatchObject({ currentVersion: 2, accessVersion: 2 });
    // v1 is dead: its grantAccessVersion no longer matches the pointer.
    const storedV1 = hoisted.docs.get(`childcare_booking_safety/${BOOKING}/versions/1`);
    expect(storedV1.grantAccessVersion).toBe(1);
    expect(v2.pointer.accessVersion).not.toBe(storedV1.grantAccessVersion);
  });

  it("version docs are immutable — a colliding version number throws", async () => {
    seedChild();
    await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
    // Simulate a raced pointer rollback that would re-mint version 1.
    hoisted.docs.set(`childcare_booking_safety/${BOOKING}`, {
      ...hoisted.docs.get(`childcare_booking_safety/${BOOKING}`),
      currentVersion: 0,
    });
    await expect(
      createSafetyProjectionVersion(
        { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
      ),
    ).rejects.toMatchObject({ code: "immutable_version" });
  });

  it("a deleted child is not projectable (fail closed)", async () => {
    seedChild();
    hoisted.docs.set(`child_profiles/${CHILD}`, {
      ...hoisted.docs.get(`child_profiles/${CHILD}`),
      state: "deleted",
    });
    await expect(
      createSafetyProjectionVersion(
        { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
      ),
    ).rejects.toBeInstanceOf(SafetyProjectionError);
  });
});

// ── Gated read ───────────────────────────────────────────────────────────────

describe("readSafetyProjectionForCaregiver (R38 gates)", () => {
  async function grant() {
    seedChild();
    seedBooking("confirmed", CG);
    return createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
  }

  it("the assigned caregiver reads the CURRENT version", async () => {
    await grant();
    const result = await readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: CG });
    expect(result.version).toBe(1);
    expect(result.children[0].childId).toBe(CHILD);
    expect(result.children[0].pickupNotes).toContain("Ana or Ben");
  });

  it("an unassigned caregiver is denied", async () => {
    await grant();
    await expect(
      readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: "cg-other" }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("a revoked caregiver is denied (revocation kills the pointer)", async () => {
    await grant();
    await revokeSafetyProjectionAccess(BOOKING, { reason: "booking_canceled", byUid: "family-1" });
    await expect(
      readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: CG }),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("a stale VERSION is denied even if the pointer read races (access-version match)", async () => {
    await grant();
    // Re-projection replaced the version; simulate reading with the OLD
    // version doc still current on a stale pointer copy: bump pointer only.
    hoisted.docs.set(`childcare_booking_safety/${BOOKING}`, {
      ...hoisted.docs.get(`childcare_booking_safety/${BOOKING}`),
      accessVersion: 99,
    });
    await expect(
      readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: CG }),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("booking state gates the read (canceled/declined/completed bookings deny)", async () => {
    await grant();
    seedBooking("canceled", CG);
    await expect(
      readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: CG }),
    ).rejects.toMatchObject({ code: "booking_not_active" });
  });

  it("provider eligibility is rechecked live (context safety_read) — ineligible denies", async () => {
    await grant();
    recheckMock.mockResolvedValue({ eligible: false });
    await expect(
      readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: CG }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "safety_read" }));
  });

  it("a pickup/safety change invalidates the projection (live staleness — AE20)", async () => {
    await grant();
    // Family appends safety version 2 (pickup change) — profile version moves.
    hoisted.docs.set(`child_profiles/${CHILD}`, {
      ...hoisted.docs.get(`child_profiles/${CHILD}`),
      safetyCurrentVersion: 2,
    });
    await expect(
      readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: CG }),
    ).rejects.toMatchObject({ code: "stale_projection" });
  });
});

// ── Authority-change fan-out (the U2 outbox effect target) ───────────────────

describe("reprojectActiveBookingSafetyForChild (R19/AE20)", () => {
  it("re-versions active projections: old version dead, fresh version readable", async () => {
    seedChild();
    seedBooking("confirmed", CG);
    await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );

    const result = await reprojectActiveBookingSafetyForChild(CHILD);
    expect(result).toEqual({ reprojected: 1, revokedOnly: 0 });

    const pointer = hoisted.docs.get(`childcare_booking_safety/${BOOKING}`);
    expect(pointer.currentVersion).toBe(2);
    expect(pointer.accessVersion).toBe(2);
    // Old version 1 (grantAccessVersion 1) is dead; version 2 is readable.
    const read = await readSafetyProjectionForCaregiver({ bookingId: BOOKING, callerUid: CG });
    expect(read.version).toBe(2);
  });

  it("fails SAFE: when the fresh projection cannot be built, access is revoked instead", async () => {
    seedChild();
    seedBooking("confirmed", CG);
    await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
    hoisted.docs.set(`child_profiles/${CHILD}`, {
      ...hoisted.docs.get(`child_profiles/${CHILD}`),
      state: "deleted",
    });
    const result = await reprojectActiveBookingSafetyForChild(CHILD);
    expect(result).toEqual({ reprojected: 0, revokedOnly: 1 });
    const pointer = hoisted.docs.get(`childcare_booking_safety/${BOOKING}`);
    expect(pointer.state).toBe("revoked");
    expect(pointer.assignedCaregiverUid).toBeNull();
  });

  it("touches nothing for a child with no active projections", async () => {
    const result = await reprojectActiveBookingSafetyForChild("child-unknown");
    expect(result).toEqual({ reprojected: 0, revokedOnly: 0 });
  });
});

// ── The REAL assigned-provider file-grant source (U3 stub replacement) ───────

describe("createBookingAssignedProviderSource (assigned + current version = file grants)", () => {
  it("grants the assigned caregiver on an active booking", async () => {
    seedChild();
    seedBooking("confirmed", CG);
    await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
    const source = createBookingAssignedProviderSource();
    const result = await source.isAssignedProviderEligible(CG, CHILD);
    expect(result).toMatchObject({ eligible: true, bookingId: BOOKING });
  });

  it("denies an unassigned provider, a revoked pointer, and an inactive booking", async () => {
    seedChild();
    seedBooking("confirmed", CG);
    await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
    const source = createBookingAssignedProviderSource();

    expect((await source.isAssignedProviderEligible("cg-other", CHILD)).eligible).toBe(false);

    seedBooking("canceled", CG);
    expect((await source.isAssignedProviderEligible(CG, CHILD)).eligible).toBe(false);

    seedBooking("confirmed", CG);
    await revokeSafetyProjectionAccess(BOOKING, { reason: "substitution", byUid: "family-1" });
    expect((await source.isAssignedProviderEligible(CG, CHILD)).eligible).toBe(false);
  });

  it("denies when provider eligibility fails (live recheck, fail closed)", async () => {
    seedChild();
    seedBooking("confirmed", CG);
    await createSafetyProjectionVersion(
      { bookingId: BOOKING, childIds: [CHILD], assignedCaregiverUid: CG, createdByUid: CG },
    );
    recheckMock.mockResolvedValue({ eligible: false });
    const source = createBookingAssignedProviderSource();
    expect((await source.isAssignedProviderEligible(CG, CHILD)).eligible).toBe(false);
  });
});
