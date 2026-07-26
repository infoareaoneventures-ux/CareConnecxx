// U9 conversation-callable tests (plan 2026-07-22-002, R20/R35/R41-R43/AE5-AE6/AE17/AE24).
//
// Scenarios (plan U9 list): same pair senior+child separate rooms both ways;
// multiple bookings per pair (per-context rooms); pre-booking vs confirmed
// disclosure phases; wrong room ID enumeration-safe; revoked adult/provider
// loses read+write; replacement caregiver gets NEW room access + address
// while the old is revoked (revoke-first ordering, END TO END through the
// REAL cancel/substitute callables); excluded user receives nothing; deleted
// conversation; opt-out honored; duplicate sends converge; address callable:
// assigned+current gets it, unassigned/revoked/stale/wrong-state denied,
// family 'view' scope gets it, reads audited; full middleware stack.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (bookingCallables pattern) ──────────────────────
const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();

  const valueAt = (doc: any, p: string): unknown =>
    p.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = valueAt(doc, f.field);
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "array-contains") return Array.isArray(v) && v.includes(f.value);
    if (f.op === "<") return typeof v === "string" && v < f.value;
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    return false;
  };

  // FieldValue.increment must behave like the real sentinel or writes that use
  // it (the U8/R45 reputation write on the confirm path) throw inside a caught
  // block and this suite covers nothing while still passing.
  const resolveSentinels = (prev: any, data: any): any => {
    const out: any = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && "__increment" in (v as any)) {
        const base = typeof prev?.[k] === "number" ? prev[k] : 0;
        out[k] = base + Number((v as any).__increment ?? 0);
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  const makeDocRef = (p: string): any => ({
    id: p.split("/").pop(),
    path: p,
    get: async () => ({
      exists: docs.has(p),
      id: p.split("/").pop(),
      data: () => docs.get(p),
      ref: makeDocRef(p),
    }),
    set: async (data: any, opts?: any) => {
      const prev = docs.get(p);
      const resolved = resolveSentinels(prev, data);
      docs.set(p, opts?.merge ? { ...(prev ?? {}), ...resolved } : { ...resolved });
    },
    update: async (data: any) => {
      if (!docs.has(p)) {
        const err: any = new Error(`5 NOT_FOUND: ${p}`);
        err.code = 5;
        throw err;
      }
      const prev = docs.get(p);
      docs.set(p, { ...(prev ?? {}), ...resolveSentinels(prev, data) });
    },
    collection: (sub: string) => makeCollRef(`${p}/${sub}`),
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
      // createdAt-desc ordering for the paginated message read.
      rows.sort((a, b) => String(b._raw?.createdAt ?? "").localeCompare(String(a._raw?.createdAt ?? "")));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (p: string): any => {
    const q = makeQuery(p);
    return {
      doc: (id?: string) => makeDocRef(`${p}/${id ?? `auto-${docs.size}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${p}/auto-${docs.size}`);
        await ref.set(data);
        return ref;
      },
      where: q.where,
      orderBy: q.orderBy,
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
        const prev = docs.get(ref.path);
        docs.set(ref.path, { ...(prev ?? {}), ...resolveSentinels(prev, data) });
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
  const firestore: any = Object.assign(() => hoisted.db, {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => ({ __delete: true }),
      increment: (n: number) => ({ __increment: n }),
    },
  });
  const storage: any = () => ({ bucket: () => ({}) });
  return {
    __esModule: true,
    default: { firestore, storage, apps: [{}] },
    firestore,
    storage,
    apps: [{}],
  };
});

const logAuditMock = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
vi.mock("../observability/auditLog", () => ({
  logAudit: logAuditMock,
  logBookingCreated: vi.fn(async () => {}),
}));

// Heavy senior module graphs mocked exactly like bookingCallables.test.ts so
// the REAL cancel/substitute callables import cleanly for the E2E wiring tests.
vi.mock("../linq/client", () => ({
  sendMessage: vi.fn(async () => {}),
  getOrCreateSession: vi.fn(async () => ({ chatId: "chat-1" })),
}));
vi.mock("../notifications", () => ({ notifyAdminBookingConfirmed: vi.fn(async () => {}) }));
vi.mock("../triggers/jobNotifications", () => ({ closeJobPost: vi.fn(async () => {}) }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async () => "msg") }));
vi.mock("../agents/shiftOffer", () => ({ createShiftOffer: vi.fn(async () => "offer-1") }));
vi.mock("../billing/createValidatedShiftHours", () => ({ BILLING_AUTHORITY_VERSION: "test" }));
vi.mock("../utils/caregiverEligibility", () => ({ isCaregiverBookable: vi.fn(() => true) }));

const recheckMock = vi.hoisted(() => vi.fn());
vi.mock("./providerEligibility", () => ({
  recheckChildcareProviderEligibility: recheckMock,
}));

const sendSMSToUserMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock("../sms", () => ({ sendSMSToUser: sendSMSToUserMock }));

import {
  openChildcareConversation as _open,
  sendChildcareMessage as _send,
  listMyChildcareConversations as _list,
  getChildcareConversationMessages as _getMessages,
  markChildcareConversationRead as _markRead,
  getChildcareBookingCoordination as _getCoordination,
} from "./conversationCallables";
import {
  requestChildcareBooking as _requestBooking,
  acceptChildcareBooking as _acceptBooking,
  cancelChildcareBooking as _cancelBooking,
  substituteChildcareCaregiver as _substitute,
  recordChildcareBookingPaymentAuthorization,
} from "./bookingCallables";
import { childcareConversationDocId } from "./conversationPolicy";
import { authorityDocId } from "./guardianAuthority";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import { familyChildcareObjectiveId } from "./signupIngress";

/* eslint-disable @typescript-eslint/no-explicit-any */
const open = _open as any;
const send = _send as any;
const list = _list as any;
const getMessages = _getMessages as any;
const markRead = _markRead as any;
const getCoordination = _getCoordination as any;
const requestBooking = _requestBooking as any;
const acceptBooking = _acceptBooking as any;
const cancelBooking = _cancelBooking as any;
const substitute = _substitute as any;

const FAMILY = "family-1";
const CG = "cg-1";
const CG2 = "cg-2";
const HH = "hh_family-1";

function ctx(uid: string): any {
  return {
    auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 5 } },
    app: { appId: "test-app" },
  };
}

function enableFlags(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set("childcare_flags/global", {
    CHILDCARE_ENABLED: true,
    CHILDCARE_DISCOVERY_ENABLED: true,
    CHILDCARE_WRITES_ENABLED: true,
    CHILDCARE_PROACTIVE_ENABLED: true,
    ...overrides,
  });
  bustChildcareFlagsCache();
}

function seedChild(childId: string, householdId = HH, safetyVersion = 1) {
  hoisted.docs.set(`child_profiles/${childId}`, {
    childId,
    householdId,
    careVertical: "child",
    displayLabel: "M.",
    ageBand: "preschool",
    careCategories: ["babysitting"],
    state: "active",
    authorizedViewerUids: [FAMILY],
    accessVersion: 1,
    safetyCurrentVersion: safetyVersion,
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
      healthNotes: null,
      allergiesNote: "peanuts",
      pickupNotes: "Only Ana may pick up",
      custodyNotes: "RESTRICTED",
      addressDetail: "123 Exact St",
    },
    immutable: true,
  });
}

function seedAuthority(
  childId: string,
  uid: string,
  scopes: string[] = ["view", "schedule", "cancellation", "message"],
) {
  hoisted.docs.set(`guardian_authorities/${authorityDocId(childId, uid)}`, {
    authorityId: authorityDocId(childId, uid),
    householdId: HH,
    childId,
    adultUid: uid,
    state: "active",
    scopes,
    accessVersion: 1,
  });
}

function seedIdentity(uid = FAMILY) {
  hoisted.docs.set(`childcare_identity_sessions/${familyChildcareObjectiveId(uid)}`, {
    status: "verified",
    adultUid: uid,
  });
}

function seedPeople() {
  hoisted.docs.set(`users/${FAMILY}`, { name: "Ana Adult", phone: "+15551230000" });
  hoisted.docs.set(`caregivers/${CG}`, { name: "Pat Provider", phone: "+15559990000" });
  hoisted.docs.set(`caregivers/${CG2}`, { name: "Quinn Provider", phone: "+15559990001" });
}

function seedConsent(uid: string, revokedAt: string | null = null) {
  hoisted.docs.set(`consent_receipts/${uid}__communicationConsent__v1`, {
    adultUid: uid,
    policyType: "communicationConsent",
    createdAt: "2026-07-01T00:00:00.000Z",
    revokedAt,
  });
}

const ELIGIBLE = () => ({
  eligible: true,
  issues: [],
  eligibilityVersion: "childcare-provider-eligibility-test",
  evidenceVersion: 2,
  capabilities: { transport: false },
  evidenceLabels: [],
  renewal: { expiresAt: null, due: false, overdue: false },
});

function seedFamily() {
  seedChild("child-a");
  seedAuthority("child-a", FAMILY);
  seedIdentity();
  seedPeople();
}

async function createRequestedBooking(): Promise<string> {
  const res = await requestBooking(
    {
      idempotencyKey: "bk-1",
      caregiverId: CG,
      childIds: ["child-a"],
      schedule: { dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "13:00" }] },
      hourlyRate: 28,
    },
    ctx(FAMILY),
  );
  expect(res.success).toBe(true);
  return res.bookingId as string;
}

async function createConfirmedBooking(): Promise<string> {
  const bookingId = await createRequestedBooking();
  await acceptBooking({ bookingId }, ctx(CG));
  await recordChildcareBookingPaymentAuthorization({
    bookingId,
    state: "authorized",
    correlationId: "pi_test_1",
  });
  expect(hoisted.docs.get(`booking_requests/${bookingId}`).status).toBe("confirmed");
  return bookingId;
}

beforeEach(() => {
  hoisted.reset();
  recheckMock.mockReset();
  recheckMock.mockResolvedValue(ELIGIBLE());
  sendSMSToUserMock.mockClear();
  logAuditMock.mockClear();
  enableFlags();
});

// ── openChildcareConversation ────────────────────────────────────────────────

describe("openChildcareConversation", () => {
  it("booking context: create-once per context; both participants converge on ONE room", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const first = await open({ contextType: "booking", contextId: bookingId }, ctx(FAMILY));
    const second = await open({ contextType: "booking", contextId: bookingId }, ctx(CG));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.roomId).toBe(first.roomId);
    expect(first.disclosurePhase).toBe("pre_booking");
    const room = hoisted.docs.get(`chatRooms/${first.roomId}`);
    expect(room.careVertical).toBe("child");
    expect(room.householdId).toBe(HH);
    expect(room.participants.sort()).toEqual([CG, FAMILY].sort());
  });

  it("MULTIPLE BOOKINGS per pair ⇒ per-context rooms (R41)", async () => {
    seedFamily();
    const booking1 = await createRequestedBooking();
    const res2 = await requestBooking(
      {
        idempotencyKey: "bk-2",
        caregiverId: CG,
        childIds: ["child-a"],
        schedule: { dates: [{ date: "2026-08-17", startTime: "09:00", endTime: "13:00" }] },
        hourlyRate: 28,
      },
      ctx(FAMILY),
    );
    const roomA = await open({ contextType: "booking", contextId: booking1 }, ctx(FAMILY));
    const roomB = await open({ contextType: "booking", contextId: res2.bookingId }, ctx(FAMILY));
    expect(roomA.roomId).not.toBe(roomB.roomId);
  });

  it("interview context: participants only, pre_booking phase; senior interview denied", async () => {
    seedFamily();
    hoisted.docs.set("video_interviews/iv-1", {
      careVertical: "child",
      clientId: FAMILY,
      caregiverId: CG,
      jobId: "job-1",
      status: "requested",
    });
    hoisted.docs.set("job_posts/job-1/private/children", { childIds: ["child-a"], householdId: HH });
    const res = await open({ contextType: "interview", contextId: "iv-1" }, ctx(FAMILY));
    expect(res.created).toBe(true);
    expect(res.disclosurePhase).toBe("pre_booking");

    hoisted.docs.set("video_interviews/iv-senior", {
      clientId: FAMILY,
      caregiverId: CG,
      status: "requested",
    });
    await expect(
      open({ contextType: "interview", contextId: "iv-senior" }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("non-participants and unknown contexts are enumeration-safe denials", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    await expect(
      open({ contextType: "booking", contextId: bookingId }, ctx("stranger")),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      open({ contextType: "booking", contextId: "cbook_nope" }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("family adult WITHOUT `message` scope cannot open (AE4)", async () => {
    seedFamily();
    seedAuthority("child-a", FAMILY, ["view", "schedule", "cancellation"]); // no message
    const bookingId = await createRequestedBooking();
    await expect(
      open({ contextType: "booking", contextId: bookingId }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("flags off ⇒ failed-precondition (middleware stack)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    enableFlags({ CHILDCARE_WRITES_ENABLED: false });
    await expect(
      open({ contextType: "booking", contextId: bookingId }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

// ── sendChildcareMessage ─────────────────────────────────────────────────────

describe("sendChildcareMessage", () => {
  async function openBookingRoom(): Promise<{ bookingId: string; roomId: string }> {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const res = await open({ contextType: "booking", contextId: bookingId }, ctx(FAMILY));
    return { bookingId, roomId: res.roomId };
  }

  it("participant sends: server-stamped message + generic in-app row + consent-gated SMS", async () => {
    seedConsent(CG);
    const { roomId } = await openBookingRoom();
    const res = await send(
      { roomId, text: "Running late", clientMessageId: "cm-1" },
      ctx(FAMILY),
    );
    expect(res.created).toBe(true);
    const message = hoisted.docs.get(`chatRooms/${roomId}/messages/${res.messageId}`);
    expect(message.text).toBe("Running late");
    expect(message.disclosurePhase).toBe("pre_booking");
    // Generic notification row — template strings, no message text (AE17).
    // (Setup already wrote a childcare_booking_request row; count message rows.)
    const rows = [...hoisted.docs.entries()].filter(
      ([p, d]) => p.startsWith(`users/${CG}/notifications/`) && d.type === "childcare_message",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0][1].title).toBe("New Message");
    expect(JSON.stringify(rows[0][1])).not.toContain("Running late");
    // Consent live ⇒ ONE generic SMS nudge.
    expect(sendSMSToUserMock).toHaveBeenCalledTimes(1);
    expect(sendSMSToUserMock).toHaveBeenCalledWith(
      CG,
      "Evia: You have a new message. Open the app to read it.",
    );
  });

  it("OPT-OUT honored (R20): revoked communication consent ⇒ in-app only", async () => {
    seedConsent(CG, "2026-07-10T00:00:00.000Z");
    const { roomId } = await openBookingRoom();
    const res = await send({ roomId, text: "hello", clientMessageId: "cm-2" }, ctx(FAMILY));
    expect(res.created).toBe(true);
    expect(sendSMSToUserMock).not.toHaveBeenCalled();
    expect(
      [...hoisted.docs.entries()].filter(
        ([p, d]) => p.startsWith(`users/${CG}/notifications/`) && d.type === "childcare_message",
      ),
    ).toHaveLength(1);
  });

  it("EXCLUDED user receives nothing while the message still lands (AE24)", async () => {
    seedConsent(CG);
    const { bookingId, roomId } = await openBookingRoom();
    hoisted.docs.set(`booking_requests/${bookingId}`, {
      ...hoisted.docs.get(`booking_requests/${bookingId}`),
      excludedUids: [CG],
    });
    const res = await send({ roomId, text: "hi", clientMessageId: "cm-3" }, ctx(FAMILY));
    expect(res.created).toBe(true);
    expect(
      [...hoisted.docs.entries()].filter(
        ([p, d]) => p.startsWith(`users/${CG}/notifications/`) && d.type === "childcare_message",
      ),
    ).toHaveLength(0);
    expect(sendSMSToUserMock).not.toHaveBeenCalled();
  });

  it("duplicate clientMessageId converges to ONE message and ONE notification (AE15)", async () => {
    seedConsent(CG);
    const { roomId } = await openBookingRoom();
    const first = await send({ roomId, text: "hi", clientMessageId: "cm-4" }, ctx(FAMILY));
    const replay = await send({ roomId, text: "hi", clientMessageId: "cm-4" }, ctx(FAMILY));
    expect(first.created).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(replay.messageId).toBe(first.messageId);
    expect(
      [...hoisted.docs.keys()].filter((p) => p.startsWith(`chatRooms/${roomId}/messages/`)),
    ).toHaveLength(1);
    expect(
      [...hoisted.docs.entries()].filter(
        ([p, d]) => p.startsWith(`users/${CG}/notifications/`) && d.type === "childcare_message",
      ),
    ).toHaveLength(1);
    expect(sendSMSToUserMock).toHaveBeenCalledTimes(1);
  });

  it("WRONG ROOM ID is enumeration-safe: nonexistent and non-participant read identically", async () => {
    await openBookingRoom();
    const nonexistent = await send(
      { roomId: "cchat_0000000000000000000000000000000000000000", text: "hi" },
      ctx(FAMILY),
    ).catch((e: any) => e);
    const notMine = await send(
      { roomId: (await list({}, ctx(FAMILY))).conversations[0].roomId, text: "hi" },
      ctx("stranger"),
    ).catch((e: any) => e);
    expect(nonexistent.code).toBe("permission-denied");
    expect(notMine.code).toBe("permission-denied");
    expect(nonexistent.message).toBe(notMine.message);
  });

  it("family sender is re-checked for LIVE `message` scope at send time (R42)", async () => {
    const { roomId } = await openBookingRoom();
    // Authority reduced AFTER the room was opened.
    seedAuthority("child-a", FAMILY, ["view"]);
    await expect(send({ roomId, text: "hi" }, ctx(FAMILY))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });
});

// ── list / paginated messages / mark read ────────────────────────────────────

describe("list + paginated read + mark read", () => {
  it("lists the caller's rooms and pages messages by createdAt cursor", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const { roomId } = await open({ contextType: "booking", contextId: bookingId }, ctx(FAMILY));
    for (let i = 0; i < 5; i++) {
      // Distinct createdAt stamps via distinct times.
      await send({ roomId, text: `m${i}`, clientMessageId: `cm-${i}` }, ctx(FAMILY));
      await new Promise((r) => setTimeout(r, 2));
    }
    const listed = await list({}, ctx(FAMILY));
    expect(listed.conversations).toHaveLength(1);
    expect(listed.conversations[0].lastMessage).toBe("New message"); // generic only

    const page1 = await getMessages({ roomId, limit: 3 }, ctx(FAMILY));
    expect(page1.messages).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    const page2 = await getMessages(
      { roomId, limit: 3, beforeCreatedAt: page1.cursor },
      ctx(FAMILY),
    );
    expect(page2.messages.length).toBeGreaterThan(0);
    expect(page2.hasMore).toBe(false);
    const texts = [...page2.messages, ...page1.messages].map((m: any) => m.text);
    expect(new Set(texts).size).toBe(5);
  });

  it("DELETED/unknown conversation reads are enumeration-safe; strangers denied", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const { roomId } = await open({ contextType: "booking", contextId: bookingId }, ctx(FAMILY));
    await expect(getMessages({ roomId: "cchat_deleted" }, ctx(FAMILY))).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(getMessages({ roomId }, ctx("stranger"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    await markRead({ roomId }, ctx(FAMILY));
    expect(hoisted.docs.get(`chatRooms/${roomId}`).unreadCount[FAMILY]).toBe(0);
  });
});

// ── Revocation wiring E2E (REAL cancel/substitute callables) ─────────────────

describe("revocation wiring (U7 cancel/substitute → U9 conversation + address)", () => {
  it("CANCEL: provider loses chat read+write AND coordination; family keeps history", async () => {
    seedFamily();
    seedConsent(CG);
    const bookingId = await createConfirmedBooking();
    const roomId = childcareConversationDocId("booking", bookingId, [FAMILY, CG]);
    // The confirm transition server-ensured the room in the confirmed phase.
    expect(hoisted.docs.get(`chatRooms/${roomId}`).disclosurePhase).toBe("confirmed_booking");
    // Assigned + confirmed ⇒ coordination (exact address) readable.
    const coord = await getCoordination({ bookingId }, ctx(CG));
    expect(coord.coordination[0].addressDetail).toBe("123 Exact St");

    await cancelBooking({ bookingId }, ctx(FAMILY));

    const room = hoisted.docs.get(`chatRooms/${roomId}`);
    expect(room.state).toBe("revoked");
    expect(room.participants).toEqual([FAMILY]); // provider read access died
    await expect(send({ roomId, text: "hi" }, ctx(CG))).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(getMessages({ roomId }, ctx(CG))).rejects.toMatchObject({
      code: "permission-denied",
    });
    // Address access died with the same revoke (booking_not_active + revoked pointer).
    await expect(getCoordination({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "permission-denied",
    });
    // Family still reads their own history.
    const familyRead = await getMessages({ roomId }, ctx(FAMILY));
    expect(familyRead.success).toBe(true);
  });

  it("SUBSTITUTION revoke-first: old caregiver loses room+address BEFORE the replacement gains a NEW room+address", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    const oldRoomId = childcareConversationDocId("booking", bookingId, [FAMILY, CG]);
    const newRoomId = childcareConversationDocId("booking", bookingId, [FAMILY, CG2]);
    expect(oldRoomId).not.toBe(newRoomId); // NEW room by construction

    await substitute(
      { bookingId, newCaregiverId: CG2, idempotencyKey: "sub-1" },
      ctx(FAMILY),
    );

    // Old caregiver: revoked room, no send, no coordination.
    const oldRoom = hoisted.docs.get(`chatRooms/${oldRoomId}`);
    expect(oldRoom.state).toBe("revoked");
    expect(oldRoom.participants).not.toContain(CG);
    await expect(getCoordination({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "permission-denied",
    });

    // Replacement: fresh ACTIVE room + coordination (current access version).
    const newRoom = hoisted.docs.get(`chatRooms/${newRoomId}`);
    expect(newRoom.state).toBe("active");
    expect(newRoom.participants.sort()).toEqual([CG2, FAMILY].sort());
    const coord = await getCoordination({ bookingId }, ctx(CG2));
    expect(coord.coordination[0].addressDetail).toBe("123 Exact St");
    const sent = await send({ roomId: newRoomId, text: "on my way" }, ctx(CG2));
    expect(sent.created).toBe(true);
  });
});

// ── getChildcareBookingCoordination (THE address callable) ───────────────────

describe("getChildcareBookingCoordination", () => {
  it("assigned caregiver on a CONFIRMED booking gets address + arrival notes; read is AUDITED", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    const res = await getCoordination({ bookingId }, ctx(CG));
    expect(res.coordination).toEqual([
      { childId: "child-a", addressDetail: "123 Exact St", arrivalNotes: "Only Ana may pick up" },
    ]);
    // R29 recheck in context safety_read happened.
    expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "safety_read" }));
    // Audit row: IDs only, never the address (R57).
    const audit = logAuditMock.mock.calls.find(
      (c: any[]) => c[0]?.eventType === "childcare_coordination_read",
    );
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit![0])).not.toContain("123 Exact St");
  });

  it("WRONG STATE: accepted-but-unconfirmed booking denies the address (tighter than safety read)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    await acceptBooking({ bookingId }, ctx(CG));
    expect(hoisted.docs.get(`booking_requests/${bookingId}`).status).toBe("accepted");
    await expect(getCoordination({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("UNASSIGNED caregiver and strangers are denied identically", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    const unassigned = await getCoordination({ bookingId }, ctx(CG2)).catch((e: any) => e);
    const stranger = await getCoordination({ bookingId }, ctx("stranger")).catch((e: any) => e);
    expect(unassigned.code).toBe("permission-denied");
    expect(stranger.code).toBe("permission-denied");
    expect(unassigned.message).toBe(stranger.message);
  });

  it("STALE/EXPIRED projection: a safety change after projection denies until re-projection (R19)", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    // The family changes safety details — the child's current version moves on.
    hoisted.docs.set("child_profiles/child-a", {
      ...hoisted.docs.get("child_profiles/child-a"),
      safetyCurrentVersion: 2,
    });
    await expect(getCoordination({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "stale_projection" },
    });
  });

  it("ineligible provider is denied even while assigned (R29 fail closed)", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    recheckMock.mockResolvedValue({ ...ELIGIBLE(), eligible: false });
    await expect(getCoordination({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("FAMILY with `view` scope gets the coordination; without it, denied", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    const res = await getCoordination({ bookingId }, ctx(FAMILY));
    expect(res.coordination[0].addressDetail).toBe("123 Exact St");

    seedAuthority("child-a", FAMILY, ["schedule", "cancellation", "message"]); // no view
    await expect(getCoordination({ bookingId }, ctx(FAMILY))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("address NEVER leaks into chat rooms, messages, or notification rows (structural sweep)", async () => {
    seedFamily();
    seedConsent(CG);
    const bookingId = await createConfirmedBooking();
    const roomId = childcareConversationDocId("booking", bookingId, [FAMILY, CG]);
    await send({ roomId, text: "see you soon", clientMessageId: "cm-x" }, ctx(FAMILY));
    await getCoordination({ bookingId }, ctx(CG));
    for (const [p, doc] of hoisted.docs.entries()) {
      if (p.includes("/private/") || p.startsWith("childcare_booking_safety/")) continue;
      expect(
        JSON.stringify(doc),
        `exact address must not appear in ${p}`,
      ).not.toContain("123 Exact St");
    }
  });
});
