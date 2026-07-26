// U9 notification-privacy tests (plan 2026-07-22-002, R20/R43/KTD16/AE17/AE24).
//
// Covers: the childSafe template registry (static strings, prohibited-
// interpolation scan, exact lock-screen strings), R20 consent-receipt gating
// (revoked adult ⇒ in-app only), duplicate-send dedupe (deterministic ids),
// the excludedUids fan-out hook (excluded uid receives NOTHING), and the
// U9 guarded-branch SOURCE SCANS on the live senior notification surfaces
// (notifications.ts, pushNotifications.ts, the five scheduled reminders,
// linq/threadMirror.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { evaluateChildcarePushContext } from "./notificationPolicy";

describe("childcare push context", () => {
  const room = {
    careVertical: "child",
    state: "active",
    roomId: "room-1",
    contextType: "booking",
    contextId: "booking-1",
    participants: ["family-1", "caregiver-1"],
    accessVersion: 4,
  };
  const message = {
    chatRoomId: "room-1",
    senderId: "family-1",
    accessVersion: 4,
  };
  const booking = {
    careVertical: "child",
    clientId: "family-1",
    caregiverId: "caregiver-1",
  };

  it("allows only a current participant on a child-stamped booking", () => {
    expect(evaluateChildcarePushContext({
      roomId: "room-1",
      room,
      message,
      booking,
      recipientUid: "caregiver-1",
    })).toEqual({ allowed: true });
  });

  it.each([
    ["missing booking", null, room, message, "missing_booking"],
    ["senior booking", { ...booking, careVertical: "senior" }, room, message, "vertical_mismatch"],
    ["removed participant", booking, { ...room, participants: ["family-1"] }, message, "participant_mismatch"],
    ["stale access version", booking, room, { ...message, accessVersion: 3 }, "stale_message"],
    ["excluded recipient", { ...booking, excludedUids: ["caregiver-1"] }, room, message, "excluded_uid"],
  ])("denies %s", (_label, candidateBooking, candidateRoom, candidateMessage, reason) => {
    expect(evaluateChildcarePushContext({
      roomId: "room-1",
      room: candidateRoom as Record<string, unknown>,
      message: candidateMessage as Record<string, unknown>,
      booking: candidateBooking as Record<string, unknown> | null,
      recipientUid: "caregiver-1",
    })).toEqual({ allowed: false, reason });
  });
});

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
    },
  });
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

const sendSMSToUserMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
vi.mock("../sms", () => ({ sendSMSToUser: sendSMSToUserMock }));

import {
  CHILDCARE_NOTIFICATION_TEMPLATES,
  deliverChildcareNotification,
  getChildcareNotificationTemplate,
  hasLiveChildcareCommunicationConsent,
  type ChildcareNotificationKind,
} from "./notificationPolicy";
import { assertChildSafeOutboundPayload } from "./matchingEligibility";

const FAMILY = "family-1";
const CG = "cg-1";

function seedConsent(uid: string, revokedAt: string | null = null, createdAt = "2026-07-01T00:00:00.000Z") {
  hoisted.docs.set(`consent_receipts/${uid}__communicationConsent__v1`, {
    adultUid: uid,
    policyType: "communicationConsent",
    policyVersion: "v1",
    createdAt,
    revokedAt,
  });
}

beforeEach(() => {
  hoisted.reset();
  sendSMSToUserMock.mockClear();
});

// ── Registry (R43/KTD16/AE17) ────────────────────────────────────────────────

describe("childSafe template registry", () => {
  const entries = Object.entries(CHILDCARE_NOTIFICATION_TEMPLATES);

  it("every entry is childSafe:true with STATIC strings (no interpolation slots)", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [kind, templateRaw] of entries) {
      const template = templateRaw as import("./notificationPolicy").ChildSafeNotificationTemplate;
      expect(template.childSafe, `${kind}.childSafe`).toBe(true);
      for (const value of [template.title, template.body, template.sms ?? ""]) {
        expect(typeof value).toBe("string");
        expect(value, `${kind} must not interpolate`).not.toContain("${");
        expect(value, `${kind} must not carry placeholder tokens`).not.toMatch(/\{[a-zA-Z]+\}/);
      }
      // The registry rows pass the recursive child-sensitive-key assertion.
      assertChildSafeOutboundPayload(
        { title: template.title, body: template.body },
        `registry.${kind}`,
      );
    }
  });

  it("PROHIBITED-INTERPOLATION source scan: registry + writers reference no child label/address identifiers", () => {
    const dir = path.resolve(__dirname);
    const banned = [
      "displayLabel",
      "recipientLabel",
      "addressDetail",
      "arrivalNotes",
      "pickupNotes",
      "custodyNotes",
      "healthNotes",
      "allergiesNote",
      "dateOfBirth",
      "childName",
    ];
    const source = fs
      .readFileSync(path.join(dir, "notificationPolicy.ts"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const word of banned) {
      expect(source, `notificationPolicy.ts must not reference "${word}"`).not.toContain(word);
    }
  });

  it("AE17: the childcare lock-screen payload is EXACTLY the generic template strings", () => {
    const t = getChildcareNotificationTemplate("childcare_message");
    expect(t.title).toBe("New Message");
    expect(t.body).toBe("You have a new message on Evia. Open the app to read it.");
    expect(t.sms).toBe("Evia: You have a new message. Open the app to read it.");
  });

  it("unknown kinds fail closed", () => {
    expect(() =>
      getChildcareNotificationTemplate("childcare_bogus" as ChildcareNotificationKind),
    ).toThrow(/unknown/);
  });
});

// ── R20 consent gate ─────────────────────────────────────────────────────────

describe("hasLiveChildcareCommunicationConsent", () => {
  it("live receipt ⇒ true; revoked latest receipt ⇒ false; no receipt ⇒ false (fail closed)", async () => {
    seedConsent(FAMILY);
    expect(await hasLiveChildcareCommunicationConsent(FAMILY, hoisted.db)).toBe(true);

    seedConsent(CG, "2026-07-10T00:00:00.000Z");
    expect(await hasLiveChildcareCommunicationConsent(CG, hoisted.db)).toBe(false);

    expect(await hasLiveChildcareCommunicationConsent("nobody", hoisted.db)).toBe(false);
  });

  it("a NEWER re-consent receipt supersedes an older revoked one", async () => {
    hoisted.docs.set(`consent_receipts/${FAMILY}__communicationConsent__v1`, {
      adultUid: FAMILY,
      policyType: "communicationConsent",
      createdAt: "2026-07-01T00:00:00.000Z",
      revokedAt: "2026-07-05T00:00:00.000Z",
    });
    hoisted.docs.set(`consent_receipts/${FAMILY}__communicationConsent__v2`, {
      adultUid: FAMILY,
      policyType: "communicationConsent",
      createdAt: "2026-07-10T00:00:00.000Z",
      revokedAt: null,
    });
    expect(await hasLiveChildcareCommunicationConsent(FAMILY, hoisted.db)).toBe(true);
  });
});

// ── Delivery (dedupe + exclusion + consent) ──────────────────────────────────

describe("deliverChildcareNotification", () => {
  const EVENT = (overrides: Record<string, unknown> = {}) => ({
    sourcePath: "booking_requests/b1",
    eventId: "evt-1",
    recipientUid: CG,
    kind: "childcare_booking_request" as ChildcareNotificationKind,
    data: { bookingId: "b1" },
    ...overrides,
  });

  it("writes ONE idempotent generic in-app row; replays converge (AE15)", async () => {
    const first = await deliverChildcareNotification(EVENT(), { db: hoisted.db });
    const replay = await deliverChildcareNotification(EVENT(), { db: hoisted.db });
    expect(first.inAppCreated).toBe(true);
    expect(replay.inAppCreated).toBe(false);
    const rows = [...hoisted.docs.entries()].filter(([p]) =>
      p.startsWith(`users/${CG}/notifications/`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0][1].title).toBe("New Booking Request");
    expect(JSON.stringify(rows[0][1])).not.toContain("M."); // no child label anywhere
  });

  it("AE24: an excluded uid receives NOTHING while another party is notified", async () => {
    const exclusionRecord = { excludedUids: [CG] };
    const excluded = await deliverChildcareNotification(
      EVENT({ exclusionRecord, smsNudge: true }),
      { db: hoisted.db },
    );
    expect(excluded.skippedReason).toBe("excluded_uid");
    expect(excluded.inAppCreated).toBe(false);
    expect(sendSMSToUserMock).not.toHaveBeenCalled();

    const other = await deliverChildcareNotification(
      EVENT({ recipientUid: FAMILY, exclusionRecord }),
      { db: hoisted.db },
    );
    expect(other.inAppCreated).toBe(true);
    expect(
      [...hoisted.docs.keys()].filter((p) => p.startsWith(`users/${CG}/notifications/`)),
    ).toHaveLength(0);
    expect(
      [...hoisted.docs.keys()].filter((p) => p.startsWith(`users/${FAMILY}/notifications/`)),
    ).toHaveLength(1);
  });

  it("R20: SMS nudge sends the GENERIC template only when consent is live", async () => {
    seedConsent(CG);
    const outcome = await deliverChildcareNotification(
      EVENT({ smsNudge: true }),
      { db: hoisted.db },
    );
    expect(outcome.smsSent).toBe(true);
    expect(sendSMSToUserMock).toHaveBeenCalledWith(
      CG,
      "Evia: You have a new childcare booking request. Open the app to respond.",
    );
  });

  it("R20: a revoked adult gets IN-APP ONLY (no SMS)", async () => {
    seedConsent(CG, "2026-07-10T00:00:00.000Z");
    const outcome = await deliverChildcareNotification(
      EVENT({ smsNudge: true }),
      { db: hoisted.db },
    );
    expect(outcome.inAppCreated).toBe(true);
    expect(outcome.smsSent).toBe(false);
    expect(sendSMSToUserMock).not.toHaveBeenCalled();
  });

  it("SMS bursts are throttled per key (second nudge inside the window is dropped)", async () => {
    seedConsent(CG);
    const first = await deliverChildcareNotification(
      EVENT({ smsNudge: true, smsThrottleKey: "k1" }),
      { db: hoisted.db },
    );
    const second = await deliverChildcareNotification(
      EVENT({ eventId: "evt-2", smsNudge: true, smsThrottleKey: "k1" }),
      { db: hoisted.db },
    );
    expect(first.smsSent).toBe(true);
    expect(second.inAppCreated).toBe(true); // in-app row still lands
    expect(second.smsSent).toBe(false);
    expect(sendSMSToUserMock).toHaveBeenCalledTimes(1);
  });
});

// ── U9 guarded-branch SOURCE SCANS on the live senior surfaces ───────────────

const FUNCTIONS_SRC = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(FUNCTIONS_SRC, rel), "utf8");
}

describe("static: U9 childcare guards on shared notification surfaces", () => {
  it("notifications.ts: appointment create/cancel triggers + shift reminders skip childcare docs", () => {
    const src = read("notifications.ts");
    // onAppointmentCreated top guard (before ensureChatRoom).
    const created = src.slice(src.indexOf("onAppointmentCreated"), src.indexOf("onMessageSent"));
    expect(created).toContain("appointment.careVertical === 'child'");
    expect(created.indexOf("careVertical === 'child'")).toBeLessThan(
      created.indexOf("ensureChatRoom("),
    );
    // onAppointmentCancelled guard.
    const cancelled = src.slice(
      src.indexOf("onAppointmentCancelled"),
      src.indexOf("sendShiftReminders"),
    );
    expect(cancelled).toContain("careVertical === 'child'");
    // sendShiftReminders loop skip.
    const reminders = src.slice(src.indexOf("sendShiftReminders"));
    expect(reminders).toContain("appointment.careVertical === 'child'");
  });

  it("notifications.ts: the pairwise ensureChatRoom stays the SENIOR room factory (unchanged shape)", () => {
    const src = read("notifications.ts");
    const ensure = src.slice(src.indexOf("async function ensureChatRoom"), src.indexOf("async function createNotification"));
    // Senior rooms keep the sorted-pair key; no childcare stamp appears here.
    expect(ensure).toContain("sorted.join('_')");
    expect(ensure).not.toContain("careVertical");
  });

  it("pushNotifications.ts: childcare rooms take the GENERIC branch with fail-closed context validation", () => {
    const src = read("pushNotifications.ts");
    expect(src).toContain('chatRoom?.careVertical === "child"');
    expect(src).toContain('getChildcareNotificationTemplate("childcare_message")');
    expect(src).toContain("evaluateChildcarePushContext");
    // The childcare branch returns BEFORE the senior payload is built.
    expect(src.indexOf('careVertical === "child"')).toBeLessThan(
      src.indexOf("New message from ${senderName}"),
    );
    // Senior payload string is byte-identical.
    expect(src).toContain("title: `New message from ${senderName}`");
  });

  it.each([
    "scheduled/clientDayBeforeReminder.ts",
    "scheduled/clientThirtyMinReminder.ts",
    "scheduled/dayBeforeShiftReminder.ts",
    "scheduled/thirtyMinShiftReminder.ts",
    "scheduled/upcomingVisitReminder.ts",
  ])("%s skips childcare appointments (senior-name SMS never fires for a child doc)", (rel) => {
    const src = read(rel);
    expect(src).toContain('if (appt.careVertical === "child") continue;');
  });

  it("linq/threadMirror.ts: childcare turns are never mirrored into senior thread structures", () => {
    const src = read("linq/threadMirror.ts");
    // The mirror early-returns on a child vertical. The guard now fires on
    // EITHER the resolved vertical or the execution context's vertical, which
    // is strictly broader than the original params.careVertical-only check.
    expect(src).toContain('params.careVertical === "child") return;');
    expect(src).toContain('params.executionContext?.careVertical === "child"');
  });

  it("calendar privacy (R35/AE17): childcare interview calendar/SMS strings are fully generic (U6-landed, characterized)", () => {
    const src = read("triggers/interviewLinkTrigger.ts");
    // Childcare calendar title is the static generic string; the senior title
    // (with the caregiver name) is preserved byte-identical.
    expect(src).toContain('isChildcareInterview(doc) ? "Evia Care Interview" : `Care Interview — ${caregiverName}`');
    // Childcare link/reminder bodies never interpolate a party name.
    expect(src).toContain("Your Evia interview is confirmed for ${formattedTime}");
    expect(src).toContain("Your Evia interview is in an hour");
    // And the childcare request SMS is name-free.
    expect(src).toContain("a family on Evia would like a 30-minute video interview");
  });

  it("email.ts audit: no childcare sender exists — welcome emails are role-based adult copy only", () => {
    const src = read("email.ts");
    expect(src).not.toContain("childcare");
    expect(src).not.toContain("careVertical");
    // Characterize the only trigger: keyed on userType, not vertical/child data.
    expect(src).toContain('userData?.userType === "caregiver"');
  });
});
