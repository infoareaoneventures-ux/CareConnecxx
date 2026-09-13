import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Firestore stand-in for the pending_actions collection ──────────────────────
const hoisted = vi.hoisted(() => {
  let docs: Map<string, { phone: string; status: string; proposedAt: string; expiresAt: string; toolName: string; toolInput: unknown; userId?: string; preview: string; resolvedAt?: string; executionPreview?: string }> = new Map();
  let autoId = 0;

  const makeDocRef = (id: string) => ({
    id,
    get: vi.fn(async () => {
      const data = docs.get(id);
      return data
        ? { exists: true, id, data: ((): Record<string, unknown> => data), ref: makeDocRef(id) }
        : { exists: false, id, data: ((): undefined => undefined) };
    }),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      const cur = docs.get(id);
      if (cur) docs.set(id, { ...cur, ...patch });
    }),
  });

  const col = {
    add: vi.fn(async (data: any) => {
      const id = `pa_${++autoId}`;
      docs.set(id, data);
      return makeDocRef(id);
    }),
    doc: vi.fn((id: string) => makeDocRef(id)),
    where: vi.fn(function chain(this: any, ..._args: unknown[]) { return this; }),
    orderBy: vi.fn(function chain(this: any, ..._args: unknown[]) { return this; }),
    limit: vi.fn(function chain(this: any, _n: number) { return this; }),
    get: vi.fn(async function (this: any) {
      // Approximate query: filter by phone + status==="awaiting", sort by proposedAt desc.
      // We capture the filter values via the call args on `where`.
      const wheres = (col.where as any).mock.calls as Array<[string, string, unknown]>;
      let entries = Array.from(docs.entries());
      for (const [field, op, value] of wheres) {
        if (op !== "==") continue;
        entries = entries.filter(([, d]) => (d as any)[field] === value);
      }
      entries.sort((a, b) => (b[1].proposedAt ?? "").localeCompare(a[1].proposedAt ?? ""));
      return {
        empty: entries.length === 0,
        docs:  entries.map(([id, data]) => ({
          id,
          ref: makeDocRef(id),
          data: () => data,
        })),
      };
    }),
  };

  // Minimal doc store for publicCaregiverProfiles — only used by
  // buildActionPreview's schedule_interview name-resolution lookup.
  const caregiverProfiles = new Map<string, Record<string, unknown>>();
  const caregiverProfilesCol = {
    doc: vi.fn((id: string) => ({
      get: vi.fn(async () => {
        const data = caregiverProfiles.get(id);
        return data
          ? { exists: true, data: () => data }
          : { exists: false, data: () => undefined };
      }),
    })),
  };

  const firestore = () => ({
    collection: vi.fn((name: string) => {
      if (name === "pending_actions") {
        // Reset where-call accumulator each access so previous queries don't leak.
        (col.where as any).mockClear();
        return col;
      }
      if (name === "publicCaregiverProfiles") return caregiverProfilesCol;
      throw new Error(`unexpected collection: ${name}`);
    }),
    runTransaction: vi.fn(async (fn: any) => {
      const tx = {
        get: async (ref: any) => ref.get(),
        update: (ref: any, patch: any) => ref.update(patch),
      };
      return fn(tx);
    }),
  });

  return {
    firestore,
    caregiverProfiles,
    seed: (entries: Array<[string, any]>) => {
      docs = new Map(entries);
      autoId = Math.max(0, ...entries.map(([k]) => parseInt(k.replace("pa_", ""), 10) || 0));
    },
    snapshot: () => Array.from(docs.entries()),
    reset: () => {
      docs = new Map();
      autoId = 0;
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: hoisted.firestore },
  firestore: hoisted.firestore,
}));

import {
  isHighRisk,
  buildActionPreview,
  proposePendingAction,
  getLatestPending,
  getAllPending,
  resolvePendingAction,
  buildPendingActionStub,
  PENDING_ACTION_TTL_MS,
  type PendingAction,
} from "./pendingActions";

beforeEach(() => {
  hoisted.reset();
});

describe("isHighRisk", () => {
  it("flags always-confirm tools regardless of input", () => {
    expect(isHighRisk("remove_family_member",     { memberPhone: "x" })).toBe(true);
    expect(isHighRisk("cancel_job_post",          { jobId: "x" })).toBe(true);
    expect(isHighRisk("delete_account",           {})).toBe(true);
  });

  // 2026-09-09 live incident: cancel_interview was prompt-only ("Confirm
  // before calling" in its own tool description, unenforced) — a bare "Yes."
  // confirming a cancellation got swallowed by the toolless quick-reply fast
  // path and Evia falsely claimed the interview was cancelled without ever
  // calling this tool. Now runtime-enforced like the other destructive tools.
  it("flags cancel_interview regardless of input", () => {
    expect(isHighRisk("cancel_interview", { interviewId: "iv1" })).toBe(true);
  });

  // cancel_subscription + reactivate_subscription merged into
  // set_subscription_status (2026-09-02, freed a tool slot for delete_account)
  // — cancel stays high-stakes (was ALWAYS_CONFIRM pre-merge), reactivate
  // stays ungated, matching each tool's pre-merge behavior exactly.
  it("conditionally flags set_subscription_status on cancel, not reactivate", () => {
    expect(isHighRisk("set_subscription_status", { clientId: "x", action: "cancel" })).toBe(true);
    expect(isHighRisk("set_subscription_status", { clientId: "x", action: "reactivate" })).toBe(false);
  });

  it("does NOT flag reversible tools", () => {
    expect(isHighRisk("get_senior_profile",       { seniorId: "x" })).toBe(false);
    expect(isHighRisk("request_booking",          { caregiverId: "x" })).toBe(false);
    expect(isHighRisk("send_caregiver_message",   { caregiverId: "x", body: "hi" })).toBe(false);
  });

  it("conditionally flags manage_recurring_schedule only on cancel", () => {
    expect(isHighRisk("manage_recurring_schedule", { scheduleId: "x", action: "cancel" })).toBe(true);
    expect(isHighRisk("manage_recurring_schedule", { scheduleId: "x", action: "pause" })).toBe(false);
    expect(isHighRisk("manage_recurring_schedule", { scheduleId: "x", action: "resume" })).toBe(false);
  });

  // block_user + unblock_user + report_user merged into set_block_status
  // (2026-08-31, freed tool slots for delete_conversation/mark_messages_read)
  // — block and report stay high-stakes (both were ALWAYS_CONFIRM pre-merge),
  // unblock stays ungated, matching each tool's pre-merge behavior exactly.
  it("conditionally flags set_block_status on block and report, not unblock", () => {
    expect(isHighRisk("set_block_status", { targetUserId: "x", action: "block" })).toBe(true);
    expect(isHighRisk("set_block_status", { targetUserId: "x", action: "report" })).toBe(true);
    expect(isHighRisk("set_block_status", { targetUserId: "x", action: "unblock" })).toBe(false);
  });

  it("conditionally flags respond_to_job_application only on reject", () => {
    expect(isHighRisk("respond_to_job_application", { applicationId: "x", decision: "reject" })).toBe(true);
    expect(isHighRisk("respond_to_job_application", { applicationId: "x", decision: "accept" })).toBe(false);
  });

  it("requires confirmation for update_care_plan fields that change what's requested", () => {
    expect(isHighRisk("update_care_plan", { clientId: "c1", field: "careNeeds",         value: ["mobility"], action: "set"    })).toBe(true);
    expect(isHighRisk("update_care_plan", { clientId: "c1", field: "emergencyContacts", value: [{ name: "Sam" }], action: "append" })).toBe(true);
    expect(isHighRisk("update_care_plan", { clientId: "c1", field: "accessCodes",       value: "1234", action: "set" })).toBe(true);
  });

  it("fails safe when update_care_plan field is missing or unknown", () => {
    expect(isHighRisk("update_care_plan", { clientId: "c1" })).toBe(true);
    expect(isHighRisk("update_care_plan", { clientId: "c1", field: "medications", value: ["penicillin"], action: "append" })).toBe(true);
  });

  it("does NOT gate the harmless note-like update_care_plan field", () => {
    expect(isHighRisk("update_care_plan", { clientId: "c1", field: "notes", value: "Prefers tea in the morning", action: "set" })).toBe(false);
  });
});

describe("buildActionPreview", () => {
  it("produces human-readable previews for known tools", async () => {
    expect(await buildActionPreview("set_subscription_status", { action: "cancel" })).toBe("Cancel Evia subscription");
    expect(await buildActionPreview("set_subscription_status", { action: "reactivate" })).toBe("Reactivate Evia subscription");
    expect(await buildActionPreview("remove_family_member", { memberPhone: "+15551234567" })).toBe("Remove family member +15551234567");
    expect(await buildActionPreview("manage_recurring_schedule", { action: "cancel", scheduleId: "sched_1" })).toContain("cancel recurring schedule sched_1");
  });

  it("falls back to a generic preview for unknown tools", async () => {
    expect(await buildActionPreview("future_irreversible_tool", { foo: "bar" })).toBe("future_irreversible_tool (irreversible)");
  });

  it("handles missing ID fields gracefully", async () => {
    expect(await buildActionPreview("remove_family_member", {})).toBe("Remove family member ?");
  });

  // 2026-09-12 live incident: schedule_interview resolved and confirmed with
  // a DIFFERENT caregiver than the one the family named, even though Evia's
  // own context correctly paired the right id with the right name. Runtime-
  // enforced confirmation only closes that gap if the preview shows the REAL
  // resolved name — echoing back the raw id wouldn't have caught anything.
  describe("schedule_interview — shows the REAL resolved caregiver name (2026-09-12)", () => {
    it("resolves caregiverId to the caregiver's real name from publicCaregiverProfiles", async () => {
      hoisted.caregiverProfiles.set("cg_imran", { name: "Imran" });
      const preview = await buildActionPreview("schedule_interview", {
        caregiverId: "cg_imran", preferredDate: "2026-09-13", preferredTime: "10:00",
      });
      expect(preview).toBe("Schedule an interview with Imran for 2026-09-13 at 10:00");
    });

    it("falls back gracefully when the caregiverId doesn't resolve to a profile", async () => {
      const preview = await buildActionPreview("schedule_interview", { caregiverId: "cg_missing" });
      expect(preview).toBe("Schedule an interview with caregiver cg_missing");
    });
  });

  // 2026-09-13: the preview is the deterministic backstop shown alongside
  // the agent's own conversational recap before a family confirms — it must
  // carry the SAME full picture the website's "Send Booking Request" modal
  // shows (care needs, emergency contact, lifestyle tags), not just
  // rate/schedule/location, since these are auto-pulled server-side and the
  // agent may not otherwise have surfaced them accurately in conversation.
  describe("request_booking — full recap includes care needs/emergency contact/lifestyle (2026-09-13)", () => {
    it("includes care needs, emergency contact, and lifestyle tags when present", async () => {
      hoisted.caregiverProfiles.set("cg1", { name: "Maria" });
      const preview = await buildActionPreview("request_booking", {
        caregiverId: "cg1", agreedRate: 30, careLocation: "9 Oak Ave, Springfield, IL, 62701",
        dates: ["2026-07-01"], startTime: "09:00", endTime: "17:00",
        careNeeds: ["Mobility", "Meal prep"],
        lifestylePreferences: ["Pets in home"],
        emergencyContact: { name: "Jane Doe", phone: "+15551234567" },
      });
      expect(preview).toContain("Mobility, Meal prep");
      expect(preview).toContain("Pets in home");
      expect(preview).toContain("Jane Doe");
      expect(preview).toContain("+15551234567");
    });

    it("omits those sections cleanly when none are on file", async () => {
      hoisted.caregiverProfiles.set("cg1", { name: "Maria" });
      const preview = await buildActionPreview("request_booking", {
        caregiverId: "cg1", agreedRate: 30, careLocation: "9 Oak Ave, Springfield, IL, 62701",
        dates: ["2026-07-01"], startTime: "09:00", endTime: "17:00",
      });
      expect(preview).not.toContain("care needs");
      expect(preview).not.toContain("emergency contact");
    });
  });
});

describe("proposePendingAction", () => {
  it("writes a doc with awaiting status, a 15-min TTL, and the action preview", async () => {
    const before = Date.now();
    const action = await proposePendingAction({
      phone:     "+15550001111",
      userId:    "user-1",
      toolName:  "remove_family_member",
      toolInput: { memberPhone: "+15559876543" },
    });
    const after = Date.now();

    expect(action.id).toMatch(/^pa_/);
    expect(action.phone).toBe("+15550001111");
    expect(action.userId).toBe("user-1");
    expect(action.toolName).toBe("remove_family_member");
    expect(action.status).toBe("awaiting");
    expect(action.preview).toBe("Remove family member +15559876543");

    const expiresAt = new Date(action.expiresAt).getTime();
    const proposedAt = new Date(action.proposedAt).getTime();
    expect(expiresAt - proposedAt).toBe(PENDING_ACTION_TTL_MS);
    expect(proposedAt).toBeGreaterThanOrEqual(before);
    expect(proposedAt).toBeLessThanOrEqual(after);
  });
});

describe("getLatestPending", () => {
  it("returns null when nothing awaiting", async () => {
    expect(await getLatestPending("+15550001111")).toBeNull();
  });

  it("returns the most-recent awaiting action for the phone", async () => {
    await proposePendingAction({ phone: "+15550001111", toolName: "remove_family_member",  toolInput: { memberPhone: "a1" } });
    await new Promise((r) => setTimeout(r, 5)); // ensure timestamps differ
    const newer = await proposePendingAction({ phone: "+15550001111", toolName: "cancel_subscription", toolInput: {} });

    const got = await getLatestPending("+15550001111");
    expect(got?.id).toBe(newer.id);
    expect(got?.toolName).toBe("cancel_subscription");
  });

  it("returns null and lazily expires a stale awaiting doc", async () => {
    const action = await proposePendingAction({
      phone:     "+15550001111",
      toolName:  "remove_family_member",
      toolInput: { memberPhone: "a1" },
    });
    // Manually expire by overwriting expiresAt to the past
    const snap = hoisted.snapshot();
    const [id, data] = snap.find(([k]) => k === action.id)!;
    hoisted.seed([[id, { ...data, expiresAt: new Date(Date.now() - 1000).toISOString() }]]);

    const got = await getLatestPending("+15550001111");
    expect(got).toBeNull();

    const after = hoisted.snapshot().find(([k]) => k === action.id)![1];
    expect(after.status).toBe("expired"); // lazily marked
  });

  it("does not return actions for a different phone", async () => {
    await proposePendingAction({ phone: "+15550009999", toolName: "remove_family_member", toolInput: {} });
    expect(await getLatestPending("+15550001111")).toBeNull();
  });
});

describe("getAllPending", () => {
  it("returns an empty array when nothing awaiting", async () => {
    expect(await getAllPending("+15550001111")).toEqual([]);
  });

  it("returns ALL awaiting actions for the phone, newest first", async () => {
    const first = await proposePendingAction({ phone: "+15550001111", toolName: "remove_family_member",  toolInput: { memberPhone: "a1" } });
    await new Promise((r) => setTimeout(r, 5)); // ensure timestamps differ
    const second = await proposePendingAction({ phone: "+15550001111", toolName: "cancel_subscription", toolInput: {} });
    await proposePendingAction({ phone: "+15550009999", toolName: "cancel_job_post", toolInput: { jobId: "j1" } });

    const got = await getAllPending("+15550001111");
    expect(got.map((a) => a.id)).toEqual([second.id, first.id]);
  });

  it("lazily expires stale docs and excludes them from the result", async () => {
    const live  = await proposePendingAction({ phone: "+15550001111", toolName: "remove_family_member", toolInput: { memberPhone: "a1" } });
    const stale = await proposePendingAction({ phone: "+15550001111", toolName: "cancel_job_post",    toolInput: { jobId: "r1" } });
    const snap = hoisted.snapshot();
    hoisted.seed(snap.map(([id, data]) =>
      id === stale.id
        ? [id, { ...data, expiresAt: new Date(Date.now() - 1000).toISOString() }] as [string, any]
        : [id, data] as [string, any],
    ));

    const got = await getAllPending("+15550001111");
    expect(got.map((a) => a.id)).toEqual([live.id]);

    const after = hoisted.snapshot().find(([k]) => k === stale.id)![1];
    expect(after.status).toBe("expired"); // lazily marked
  });
});

describe("resolvePendingAction", () => {
  it("marks awaiting -> executed and stores executionPreview", async () => {
    const a = await proposePendingAction({
      phone: "+15550001111", toolName: "remove_family_member", toolInput: { memberPhone: "x" },
    });
    await resolvePendingAction(a.id, "executed", { executionPreview: "{ ok: true }" });

    const snap = hoisted.snapshot().find(([k]) => k === a.id)![1];
    expect(snap.status).toBe("executed");
    expect(snap.executionPreview).toBe("{ ok: true }");
    expect(snap.resolvedAt).toBeTruthy();
  });

  it("is a no-op when the doc no longer exists", async () => {
    await expect(resolvePendingAction("pa_nonexistent", "executed")).resolves.toBeUndefined();
  });

  it("logs a warning and skips when status conflicts with the requested change", async () => {
    const a = await proposePendingAction({
      phone: "+15550001111", toolName: "remove_family_member", toolInput: {},
    });
    await resolvePendingAction(a.id, "executed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolvePendingAction(a.id, "rejected"); // conflict
    expect(warnSpy).toHaveBeenCalled();
    const snap = hoisted.snapshot().find(([k]) => k === a.id)![1];
    expect(snap.status).toBe("executed"); // not overwritten
    warnSpy.mockRestore();
  });
});

describe("buildPendingActionStub", () => {
  it("produces a Claude-readable stub with action id, preview, and TTL", () => {
    const action: PendingAction = {
      id:         "pa_42",
      phone:      "+15550001111",
      toolName:   "remove_family_member",
      toolInput:  {},
      preview:    "Remove family member +15559876543",
      proposedAt: new Date(Date.now()).toISOString(),
      expiresAt:  new Date(Date.now() + 14 * 60_000).toISOString(),
      status:     "awaiting",
    };
    const stub = buildPendingActionStub(action);
    expect(stub._pending_action).toBe(true);
    expect(stub.actionId).toBe("pa_42");
    expect(stub.toolName).toBe("remove_family_member");
    expect(stub.preview).toBe("Remove family member +15559876543");
    expect(stub.expires_in_minutes).toBeGreaterThanOrEqual(13);
    expect(stub.expires_in_minutes).toBeLessThanOrEqual(15);
    expect(stub.guidance.toLowerCase()).toContain("confirm");
  });
});
