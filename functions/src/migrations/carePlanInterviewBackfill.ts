import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";

const db = admin.firestore();

/**
 * One-time backfill: start the care-plan interview for EXISTING paid clients
 * whose job post is live but whose care plan is incomplete (care-plan interview
 * wave, 2026-07-15 — these families' caregivers are working from the loose
 * signup free-text only).
 *
 * DRY-RUN BY DEFAULT: lists every eligible client (name, phone, senior,
 * what's missing) and sends NOTHING.
 *
 * APPLY MODE requires BOTH:
 *   ?apply=true
 *   &phones=+14085551234,+16505555678   ← the founder NAMES the recipients
 * Only phones that are BOTH named AND independently eligible get the kickoff —
 * a typo'd or ineligible phone is reported, never texted. This enforces the
 * standing named-consent rule for proactive prod sends.
 *
 * Protect with header: x-admin-secret: <MIGRATION_ADMIN_SECRET env var>.
 * Idempotent: startCarePlanInterview refuses when the interview is already
 * active or completed, and skips plans that are already complete.
 */
export const carePlanInterviewBackfill = functions.https.onRequest(async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"];
  if (!adminSecret || adminSecret !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const apply = req.query.apply === "true";
  const namedPhones = new Set(
    String(req.query.phones ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  if (apply && namedPhones.size === 0) {
    res.status(400).json({
      error: "apply=true requires &phones=<comma-separated phone list> — proactive sends must name their recipients.",
    });
    return;
  }

  const { carePlanInterviewEnabled } = await import("../config/featureFlags");
  if (apply && !carePlanInterviewEnabled()) {
    res.status(400).json({ error: "CARE_PLAN_INTERVIEW_ENABLED is not 'true' in this environment — flip the flag first." });
    return;
  }

  const { getCarePlanCompleteness, startCarePlanInterview } = await import("../agents/carePlanInterview");

  const results = {
    mode:      apply ? "APPLY" : "DRY_RUN",
    scanned:   0,
    eligible:  [] as Array<{ phone: string; firstName: string; seniorName: string; missing: string[]; named: boolean }>,
    skipped:   [] as Array<{ phone: string; reason: string }>,
    started:   [] as string[],
    namedButIneligible: [] as string[],
    errors:    [] as string[],
  };

  try {
    // Open job posts are the anchor: a family with no live post has nothing
    // for caregivers to work from, so the interview has no audience yet.
    const jobsSnap = await db.collection("job_posts").where("status", "==", "open").get();

    for (const jobDoc of jobsSnap.docs) {
      results.scanned++;
      const clientId = (jobDoc.data().clientId ?? jobDoc.id) as string;
      try {
        const userSnap = await db.collection("users").doc(clientId).get();
        const u = (userSnap.data() ?? {}) as Record<string, unknown>;
        const phone = String(u.phone ?? jobDoc.data().phone ?? "");
        if (!phone) { results.skipped.push({ phone: `(client ${clientId})`, reason: "no phone" }); continue; }
        const paid = u.subscriptionActive === true || u.membershipStatus === "active";
        if (!paid) { results.skipped.push({ phone, reason: "membership not active" }); continue; }

        const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
        const s = (sessionSnap.data() ?? {}) as Record<string, unknown>;
        if (!sessionSnap.exists)                     { results.skipped.push({ phone, reason: "no agent session" }); continue; }
        if (s.optedOut === true)                     { results.skipped.push({ phone, reason: "opted out" }); continue; }
        if (s.optedIn !== true)                      { results.skipped.push({ phone, reason: "not opted in (TCPA)" }); continue; }
        if (s.userType !== "client")                 { results.skipped.push({ phone, reason: `userType=${String(s.userType)}` }); continue; }
        if (s.onboardingStep !== "complete")         { results.skipped.push({ phone, reason: `mid-onboarding (${String(s.onboardingStep)})` }); continue; }
        if (s.carePlanInterviewActive === true)      { results.skipped.push({ phone, reason: "interview already active" }); continue; }
        if (s.carePlanInterviewCompletedAt)          { results.skipped.push({ phone, reason: "interview already completed" }); continue; }
        if (!s.chatId)                               { results.skipped.push({ phone, reason: "no chatId" }); continue; }

        const c = await getCarePlanCompleteness(clientId, s.onboardingData as Record<string, unknown> | undefined);
        if (c.complete) { results.skipped.push({ phone, reason: "care plan already complete" }); continue; }

        const d = (s.onboardingData ?? {}) as Record<string, unknown>;
        results.eligible.push({
          phone,
          firstName:  String(d.firstName ?? u.firstName ?? ""),
          seniorName: String(d.seniorName ?? ""),
          missing:    c.missing,
          named:      namedPhones.has(phone),
        });

        if (apply && namedPhones.has(phone)) {
          const ok = await startCarePlanInterview(
            phone,
            String(s.chatId),
            { ...s, userId: s.userId ?? clientId },
            { source: "backfill" },
          );
          if (ok) results.started.push(phone);
          else results.skipped.push({ phone, reason: "startCarePlanInterview declined (flag/state changed under us)" });
        }
      } catch (err) {
        results.errors.push(`client ${clientId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (apply) {
      const eligiblePhones = new Set(results.eligible.map((e) => e.phone));
      results.namedButIneligible = [...namedPhones].filter((p) => !eligiblePhones.has(p));
    }

    res.json(results);
  } catch (err) {
    console.error("[carePlanInterviewBackfill] failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), partial: results });
  }
});
