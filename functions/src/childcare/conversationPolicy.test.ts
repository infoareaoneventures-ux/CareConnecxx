// U9 conversation-policy tests (plan 2026-07-22-002, R41-R42/KTD14).
//
// Covers: room key derivation (same pair senior+child separate BOTH ways;
// per-context rooms for multiple children/bookings; replacement caregiver ⇒
// NEW key), participant/disclosure/access-version model, revocation
// semantics (participant removal, booking revoke, household authority
// fan-out), the excludedUids hook, the pinned message-doc key set, and the
// STATIC no-safety-injection + senior-byte-compat source scans.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

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
      docs.set(p, opts?.merge ? { ...(docs.get(p) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(p)) {
        const err: any = new Error(`5 NOT_FOUND: ${p}`);
        err.code = 5;
        throw err;
      }
      docs.set(p, { ...(docs.get(p) ?? {}), ...data });
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
  const firestore: any = Object.assign(() => hoisted.db, {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => ({ __delete: true }),
      increment: (n: number) => ({ __increment: n }),
    },
  });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

import {
  CHILDCARE_MESSAGE_DOC_KEYS,
  CHILDCARE_ROOM_GENERIC_PREVIEW,
  ConversationPolicyError,
  advanceChildcareConversationPhaseForBooking,
  appendChildcareMessage,
  buildChildcareConversationDoc,
  buildChildcareMessageDoc,
  childcareConversationDocId,
  childcareMessageDocId,
  ensureChildcareConversation,
  filterExcludedNotificationRecipients,
  isExcludedNotificationRecipient,
  listChildcareConversationsForUser,
  markChildcareConversationRead,
  revokeChildcareConversationParticipant,
  revokeChildcareConversationsForAdultInHousehold,
  revokeChildcareConversationsForBooking,
} from "./conversationPolicy";

const NOW = new Date("2026-07-23T18:00:00.000Z");
const FAMILY = "family-1";
const CG = "cg-1";
const CG2 = "cg-2";
const HH = "hh_family-1";

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    contextType: "booking" as const,
    contextId: "cbook_1",
    householdId: HH,
    participants: [FAMILY, CG],
    participantNames: ["Ana Adult", "Pat Provider"],
    disclosurePhase: "pre_booking" as const,
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.reset();
});

// ── Room key derivation (KTD14/R41/AE5) ──────────────────────────────────────

describe("childcareConversationDocId", () => {
  it("is deterministic and participant-order-insensitive", () => {
    const a = childcareConversationDocId("booking", "b1", [FAMILY, CG]);
    const b = childcareConversationDocId("booking", "b1", [CG, FAMILY]);
    expect(a).toBe(b);
    expect(a).toMatch(/^cchat_[0-9a-f]{40}$/);
  });

  it("SAME PAIR, different contexts ⇒ SEPARATE rooms (per-booking, per-interview)", () => {
    const booking1 = childcareConversationDocId("booking", "b1", [FAMILY, CG]);
    const booking2 = childcareConversationDocId("booking", "b2", [FAMILY, CG]);
    const interview = childcareConversationDocId("interview", "i1", [FAMILY, CG]);
    expect(new Set([booking1, booking2, interview]).size).toBe(3);
  });

  it("same context id under different context types ⇒ separate rooms", () => {
    expect(childcareConversationDocId("booking", "x", [FAMILY, CG])).not.toBe(
      childcareConversationDocId("interview", "x", [FAMILY, CG]),
    );
  });

  it("replacement caregiver ⇒ NEW room key (participant set is part of the key)", () => {
    expect(childcareConversationDocId("booking", "b1", [FAMILY, CG])).not.toBe(
      childcareConversationDocId("booking", "b1", [FAMILY, CG2]),
    );
  });

  it("AE5: the childcare namespace can never collide with senior pairwise rooms", () => {
    // Senior rooms are addDoc auto-IDs or `{uidA}_{uidB}` (notifications.ts
    // ensureChatRoom). Childcare keys always carry the cchat_ prefix.
    const seniorEnsureId = [FAMILY, CG].sort().join("_");
    const childId = childcareConversationDocId("booking", "b1", [FAMILY, CG]);
    expect(childId.startsWith("cchat_")).toBe(true);
    expect(childId).not.toBe(seniorEnsureId);
  });

  it("rejects malformed inputs", () => {
    expect(() => childcareConversationDocId("booking", "", [FAMILY, CG])).toThrow(
      ConversationPolicyError,
    );
    expect(() => childcareConversationDocId("booking", "b1", [FAMILY])).toThrow(
      ConversationPolicyError,
    );
    expect(() =>
      childcareConversationDocId("nope" as never, "b1", [FAMILY, CG]),
    ).toThrow(ConversationPolicyError);
  });
});

// ── Doc builders ─────────────────────────────────────────────────────────────

describe("buildChildcareConversationDoc / buildChildcareMessageDoc", () => {
  it("builds a vertical-stamped room with access version 1 and empty generic metadata", () => {
    const room = buildChildcareConversationDoc(baseParams());
    expect(room.careVertical).toBe("child");
    expect(room.accessVersion).toBe(1);
    expect(room.state).toBe("active");
    expect(room.disclosurePhase).toBe("pre_booking");
    expect(room.participants).toEqual([CG, FAMILY].sort());
    expect(room.lastMessage).toBe("");
    expect(room.unreadCount).toEqual({ [FAMILY]: 0, [CG]: 0 });
    // Names stay index-aligned with the sorted participants.
    const idx = room.participants.indexOf(FAMILY);
    expect(room.participantNames[idx]).toBe("Ana Adult");
  });

  it("message docs carry EXACTLY the pinned key set (no safety-data slot exists)", () => {
    const message = buildChildcareMessageDoc({
      roomId: "cchat_x",
      senderId: FAMILY,
      senderName: "Ana Adult",
      text: "Running 10 minutes late",
      disclosurePhase: "confirmed_booking",
      accessVersion: 3,
      now: NOW,
    });
    expect(Object.keys(message).sort()).toEqual([...CHILDCARE_MESSAGE_DOC_KEYS].sort());
    expect(message.createdAt).toBe(NOW.toISOString()); // server-side stamp
    expect(message.accessVersion).toBe(3);
    expect(message.disclosurePhase).toBe("confirmed_booking");
  });

  it("bounds message text (required, max 2000)", () => {
    const params = {
      roomId: "r",
      senderId: FAMILY,
      senderName: "A",
      disclosurePhase: "pre_booking" as const,
      accessVersion: 1,
      now: NOW,
    };
    expect(() => buildChildcareMessageDoc({ ...params, text: "" })).toThrow(
      ConversationPolicyError,
    );
    expect(() => buildChildcareMessageDoc({ ...params, text: "x".repeat(2001) })).toThrow(
      ConversationPolicyError,
    );
  });

  it("childcareMessageDocId dedupes retries per (room, sender, clientMessageId)", () => {
    expect(childcareMessageDocId("r1", FAMILY, "cm-1")).toBe(
      childcareMessageDocId("r1", FAMILY, "cm-1"),
    );
    expect(childcareMessageDocId("r1", FAMILY, "cm-1")).not.toBe(
      childcareMessageDocId("r1", CG, "cm-1"),
    );
  });
});

// ── excludedUids hook (AE24) ─────────────────────────────────────────────────

describe("suspected-unsafe-party exclusion hook", () => {
  it("filters excluded uids; others receive normally", () => {
    const record = { excludedUids: [CG] };
    expect(filterExcludedNotificationRecipients(record, [FAMILY, CG])).toEqual([FAMILY]);
    expect(isExcludedNotificationRecipient(record, CG)).toBe(true);
    expect(isExcludedNotificationRecipient(record, FAMILY)).toBe(false);
  });

  it("absent/malformed sets exclude nobody", () => {
    expect(filterExcludedNotificationRecipients(null, [FAMILY])).toEqual([FAMILY]);
    expect(filterExcludedNotificationRecipients({}, [FAMILY])).toEqual([FAMILY]);
    expect(filterExcludedNotificationRecipients({ excludedUids: "x" }, [FAMILY])).toEqual([
      FAMILY,
    ]);
  });
});

// ── Lifecycle: create-once / append / revoke / phase / list ─────────────────

describe("ensureChildcareConversation", () => {
  it("create-once: duplicate opens converge to the same room (AE15)", async () => {
    const first = await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    const second = await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.room.roomId).toBe(first.room.roomId);
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("chatRooms/")).length).toBe(1);
  });
});

describe("appendChildcareMessage", () => {
  async function seedRoom(overrides: Record<string, unknown> = {}) {
    const { room } = await ensureChildcareConversation(
      baseParams(overrides),
      { db: hoisted.db },
    );
    return room;
  }

  it("writes a stamped message + GENERIC room metadata (never message text)", async () => {
    const room = await seedRoom();
    const result = await appendChildcareMessage(
      { roomId: room.roomId, senderId: FAMILY, text: "See you at 3", clientMessageId: "cm-1" },
      { db: hoisted.db, now: NOW },
    );
    expect(result.created).toBe(true);
    expect(result.recipients).toEqual([CG]);
    const stored = hoisted.docs.get(`chatRooms/${room.roomId}/messages/${result.messageId}`);
    expect(stored.text).toBe("See you at 3");
    expect(stored.accessVersion).toBe(1);
    expect(stored.disclosurePhase).toBe("pre_booking");
    const roomDoc = hoisted.docs.get(`chatRooms/${room.roomId}`);
    expect(roomDoc.lastMessage).toBe(CHILDCARE_ROOM_GENERIC_PREVIEW);
    expect(roomDoc.lastMessage).not.toContain("See you");
    expect(roomDoc.unreadCount[CG]).toBe(1);
  });

  it("duplicate clientMessageId converges without re-notifying (AE15)", async () => {
    const room = await seedRoom();
    const first = await appendChildcareMessage(
      { roomId: room.roomId, senderId: FAMILY, text: "hi", clientMessageId: "cm-2" },
      { db: hoisted.db, now: NOW },
    );
    const replay = await appendChildcareMessage(
      { roomId: room.roomId, senderId: FAMILY, text: "hi", clientMessageId: "cm-2" },
      { db: hoisted.db, now: NOW },
    );
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.messageId).toBe(first.messageId);
    expect(replay.recipients).toEqual([]); // no second fan-out
    expect(hoisted.docs.get(`chatRooms/${room.roomId}`).unreadCount[CG]).toBe(1);
  });

  it("non-participants, revoked rooms, and missing rooms all fail", async () => {
    const room = await seedRoom();
    await expect(
      appendChildcareMessage(
        { roomId: room.roomId, senderId: "stranger", text: "hi" },
        { db: hoisted.db, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "not_participant" });
    await expect(
      appendChildcareMessage(
        { roomId: "cchat_does_not_exist", senderId: FAMILY, text: "hi" },
        { db: hoisted.db, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "conversation_not_found" });

    await revokeChildcareConversationsForBooking("cbook_1", {
      db: hoisted.db,
      now: NOW,
      reason: "booking_canceled",
      revokeUid: CG,
    });
    await expect(
      appendChildcareMessage(
        { roomId: room.roomId, senderId: FAMILY, text: "hi" },
        { db: hoisted.db, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "conversation_revoked" });
  });

  it("stale expectedAccessVersion fails closed", async () => {
    const room = await seedRoom();
    await expect(
      appendChildcareMessage(
        { roomId: room.roomId, senderId: FAMILY, text: "hi", expectedAccessVersion: 99 },
        { db: hoisted.db, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "stale_access_version" });
  });
});

describe("revocation semantics (R42/AE6)", () => {
  it("booking revoke: caregiver drops off participants (read dies), family keeps history, accessVersion bumps", async () => {
    const { room } = await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    const touched = await revokeChildcareConversationsForBooking("cbook_1", {
      db: hoisted.db,
      now: NOW,
      reason: "booking_canceled",
      revokeUid: CG,
    });
    expect(touched).toBe(1);
    const stored = hoisted.docs.get(`chatRooms/${room.roomId}`);
    expect(stored.state).toBe("revoked");
    expect(stored.participants).toEqual([FAMILY]);
    expect(stored.accessVersion).toBe(2);
    expect(stored.revokedReason).toBe("booking_canceled");
    // Idempotent: re-revoking changes nothing further.
    const again = await revokeChildcareConversationsForBooking("cbook_1", {
      db: hoisted.db,
      now: NOW,
      reason: "booking_canceled",
      revokeUid: CG,
    });
    expect(again).toBe(0);
    expect(hoisted.docs.get(`chatRooms/${room.roomId}`).accessVersion).toBe(2);
  });

  it("participant revoke removes exactly that adult and revokes a one-sided room", async () => {
    const { room } = await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    const next = await revokeChildcareConversationParticipant(room.roomId, FAMILY, {
      db: hoisted.db,
      now: NOW,
      reason: "authority_change",
    });
    expect(next?.participants).toEqual([CG]);
    expect(next?.state).toBe("revoked"); // fewer than two participants
    expect(next?.accessVersion).toBe(2);
    expect(Object.keys(next?.unreadCount ?? {})).not.toContain(FAMILY);
  });

  it("household authority fan-out removes the adult from THAT household's rooms only", async () => {
    await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    await ensureChildcareConversation(
      baseParams({ contextId: "cbook_2", householdId: "hh_other" }),
      { db: hoisted.db },
    );
    const touched = await revokeChildcareConversationsForAdultInHousehold(HH, FAMILY, {
      db: hoisted.db,
      now: NOW,
    });
    expect(touched).toBe(1);
    const rooms = [...hoisted.docs.entries()].filter(([p]) => /^chatRooms\/[^/]+$/.test(p));
    const mine = rooms.find(([, d]) => d.householdId === HH)![1];
    const other = rooms.find(([, d]) => d.householdId === "hh_other")![1];
    expect(mine.participants).not.toContain(FAMILY);
    expect(other.participants).toContain(FAMILY);
  });
});

describe("disclosure phase (pre-booking vs confirmed)", () => {
  it("advance stamps confirmed_booking + accessVersion bump; messages stamp the live phase", async () => {
    const { room } = await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    const pre = await appendChildcareMessage(
      { roomId: room.roomId, senderId: FAMILY, text: "before confirm", clientMessageId: "a" },
      { db: hoisted.db, now: NOW },
    );
    expect(hoisted.docs.get(`chatRooms/${room.roomId}/messages/${pre.messageId}`).disclosurePhase)
      .toBe("pre_booking");

    const advanced = await advanceChildcareConversationPhaseForBooking("cbook_1", {
      db: hoisted.db,
      now: NOW,
    });
    expect(advanced).toBe(1);
    const stored = hoisted.docs.get(`chatRooms/${room.roomId}`);
    expect(stored.disclosurePhase).toBe("confirmed_booking");
    expect(stored.accessVersion).toBe(2);

    const post = await appendChildcareMessage(
      { roomId: room.roomId, senderId: CG, text: "after confirm", clientMessageId: "b" },
      { db: hoisted.db, now: NOW },
    );
    expect(hoisted.docs.get(`chatRooms/${room.roomId}/messages/${post.messageId}`).disclosurePhase)
      .toBe("confirmed_booking");
  });
});

describe("listChildcareConversationsForUser / markChildcareConversationRead", () => {
  it("lists only the adult's childcare rooms; senior rooms are invisible", async () => {
    await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    hoisted.docs.set("chatRooms/senior_pairwise", {
      participants: [FAMILY, CG],
      participantNames: ["Ana", "Pat"],
      lastMessage: "senior text",
    });
    const rooms = await listChildcareConversationsForUser(FAMILY, { db: hoisted.db });
    expect(rooms).toHaveLength(1);
    expect(rooms[0].careVertical).toBe("child");
  });

  it("markRead resets only the caller's counter; strangers denied", async () => {
    const { room } = await ensureChildcareConversation(baseParams(), { db: hoisted.db });
    await appendChildcareMessage(
      { roomId: room.roomId, senderId: FAMILY, text: "hello", clientMessageId: "c" },
      { db: hoisted.db, now: NOW },
    );
    await markChildcareConversationRead(room.roomId, CG, { db: hoisted.db, now: NOW });
    expect(hoisted.docs.get(`chatRooms/${room.roomId}`).unreadCount[CG]).toBe(0);
    await expect(
      markChildcareConversationRead(room.roomId, "stranger", { db: hoisted.db, now: NOW }),
    ).rejects.toMatchObject({ code: "not_participant" });
  });
});

// ── STATIC source scans ──────────────────────────────────────────────────────

const SRC_DIR = path.resolve(__dirname);

/** Drop comment lines so prose ABOUT the prohibition can't trip the scan. */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

describe("static: no safety-data injection into chat message writes (plan U9)", () => {
  const policySource = stripComments(
    fs.readFileSync(path.join(SRC_DIR, "conversationPolicy.ts"), "utf8"),
  );

  it("conversationPolicy.ts imports NEITHER safetyProjection NOR the child repository", () => {
    expect(policySource).not.toMatch(/from ["']\.\/safetyProjection["']/);
    expect(policySource).not.toMatch(/childProfileRepository/);
    expect(policySource).not.toMatch(/childcare_booking_safety/);
  });

  it("conversationPolicy.ts never references private-zone/safety fields", () => {
    for (const banned of [
      "pickupNotes",
      "emergencyContacts",
      "healthNotes",
      "allergiesNote",
      "custodyNotes",
      "addressDetail",
      "arrivalNotes",
      "dateOfBirth",
      "safetyProjection",
      "displayLabel",
      "recipientLabel",
    ]) {
      expect(policySource, `conversationPolicy.ts must not reference "${banned}"`).not.toContain(
        banned,
      );
    }
  });

  it("the only message-doc constructor pins the exact key set", () => {
    expect(CHILDCARE_MESSAGE_DOC_KEYS).toEqual([
      "chatRoomId",
      "senderId",
      "senderName",
      "text",
      "type",
      "disclosurePhase",
      "accessVersion",
      "timestamp",
      "createdAt",
      "isRead",
      "readBy",
    ]);
  });
});

describe("static: senior chat path byte-compat characterization (AE5)", () => {
  const chatServiceSource = fs.readFileSync(
    path.resolve(SRC_DIR, "../../..", "services/chatService.ts"),
    "utf8",
  );

  it("getOrCreateChatRoom still keys senior rooms on the participant pair alone (untouched)", () => {
    // The senior get-or-create body: participant array-contains lookup + addDoc.
    expect(chatServiceSource).toContain("where('participants', 'array-contains', user1Id)");
    expect(chatServiceSource).toContain("if (data.participants.includes(user2Id))");
    // And it never stamps a vertical — childcare rooms are server-created only.
    const getOrCreate = chatServiceSource.slice(
      chatServiceSource.indexOf("async getOrCreateChatRoom"),
      chatServiceSource.indexOf("async sendMessage"),
    );
    expect(getOrCreate).not.toContain("careVertical");
  });

  it("browser chat service has NO childcare room create/send path (reads only)", () => {
    const start = chatServiceSource.indexOf("READ-ONLY seam");
    const end = chatServiceSource.indexOf("subscribeToAllChatRooms", start);
    expect(start).toBeGreaterThan(-1);
    const childcareSection = chatServiceSource.slice(start, end);
    expect(childcareSection).toContain("subscribeToChildcareMessages");
    expect(childcareSection).not.toContain("addDoc");
    expect(childcareSection).not.toContain("setDoc(");
  });
});
