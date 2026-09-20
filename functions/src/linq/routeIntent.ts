import * as admin from "firebase-admin";
import { sendMessage, startTyping, stopTyping, AgentSession } from "./client";
import { classifyIntentDetailed, isCaregiverSearchMisroutedAsProviderSearch } from "../agents/intentClassifier";

import { buildHelpSmsReply, type DiscoveryRole } from "../agents/capabilityDiscovery";
import { buildOperationalRecipeLead, loadCaraOperationalContext } from "../agents/operationalContext";
import { staleConfirmFlags, hasActiveSmsFlow, PENDING_MATCHES_TTL_MS } from "../utils/sessionState";
import { getLatestPending } from "../agents/pendingActions";
import { isBareDateOrTimeAnswer, isBareYesNoAnswer } from "../utils/bareDateTimeAnswer";
import { handleCompletionNudgeReply, freshCompletionNudgeInterviewId } from "../agents/completionNudgeReply";
import { handleReviewPromptReply } from "../agents/reviewPrompt";
import { handleEmailChangeReply } from "../agents/emailChangeReply";
import { runQaAgent, runQuickReply, isTrivialQuickReply } from "../agents/qaAgent";
import { intentToShadowFlow, shadowTap } from "../agents/routingShadowTap";
import { updatePermissionFromText } from "../agents/permissionsConversation";
import { startJobPostingFlow } from "../agents/jobPostingFlow";
import { handleEarningsView } from "../agents/earningsHandler";
import { handleAvailabilityUpdate } from "../agents/availabilityHandler";
import { handleCaregiverSwapRequest } from "../agents/caregiverSwapHandler";
import { handleCaregiverCancelShift } from "../agents/caregiverCancelShiftHandler";
import { handleCaregiverProfileUpdate, profileFieldFromIntent, ProfileUpdateField } from "../agents/caregiverProfileHandler";
import { generateCaraMessage } from "../utils/caraMessage";
import { businessTodayStr } from "../utils/scheduledTime";
import { handleJobResponse } from "../triggers/jobNotifications";
import {
  searchZepMemory,
  getZepUserId,
} from "../memory/zepClient";
import { quickComplete } from "../utils/openaiClient";
import { buildNonMedicalDeflection } from "../agents/medicalBoundary";

const db = admin.firestore();

function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

async function extractFamilyMember(text: string): Promise<{ name: string | null; phone: string | null }> {
  const extractionRaw = await quickComplete(
    "Extract the family member name and phone number from this message. " +
      "Reply with JSON only: {\"name\":\"...\",\"phone\":\"+1...\"}. " +
      "If no name is present, name=null. If no phone is present, phone=null.",
    text,
    { maxTokens: 80 },
  ).catch(() => "{}");

  try {
    const parsed = JSON.parse(extractionRaw || "{}");
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      phone: normalizeE164(typeof parsed.phone === "string" ? parsed.phone : null),
    };
  } catch {
    // JSON parse failed (malformed LLM output). Only fall back to treating the
    // raw text as a phone number when it actually LOOKS like one — digits plus
    // common phone punctuation. Prose with stray digits (addresses, "3 days a
    // week", etc.) must not be coerced into a bogus E.164 number.
    const trimmed = text.trim();
    const phoneLike = /^[+(]?[\d\s().+-]{8,}$/.test(trimmed) && trimmed.replace(/\D/g, "").length >= 10;
    return { name: null, phone: phoneLike ? normalizeE164(text) : null };
  }
}

export interface IntentRouteContext {
  phone: string;
  chatId: string;
  text: string;
  norm: string;
  session: AgentSession;
  /**
   * The Linq webhook wrapper's deduplicated event key (event_id / message_id /
   * synthetic hash) — the stable source-turn key for completed-turn memory
   * persistence (memory-grounding plan U3, R9). Optional: agent/test callers
   * without one get no idempotency promise (typed `missing_source_key`).
   */
  eventId?: string;
}

async function handleAddFamilyMemberIntent(
  phone: string,
  chatId: string,
  text: string,
  session: AgentSession
): Promise<void> {
  if ((session as any).isSecondaryMember) {
    await sendMessage(chatId, await generateCaraMessage({
      audience: "family",
      language: session.preferredLanguage === "es" ? "es" : "en",
      context: "This person is a secondary member of the care group and asked to add someone new. Warmly explain you're happy to help with updates here, but only the primary account holder can add people to the care group.",
      fallback: "I can help with updates here, but only the primary account holder can add people to this care group.",
      maxTokens: 70,
    }));
    return;
  }

  const pendingAdd = (session as any).pendingAddFamilyMember as { name?: string | null; phone?: string | null } | undefined;
  const extracted = await extractFamilyMember(text);
  const memberName  = extracted.name  ?? pendingAdd?.name  ?? null;
  const memberPhone = extracted.phone ?? pendingAdd?.phone ?? null;

  if (!memberPhone) {
    await db.collection("agent_sessions").doc(phone).update({
      pendingAddFamilyMember: { name: memberName, phone: null },
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }).catch(() => {});
    await sendMessage(chatId, "I can add them. What phone number should I use?");
    return;
  }
  if (!memberName) {
    await db.collection("agent_sessions").doc(phone).update({
      pendingAddFamilyMember: { name: null, phone: memberPhone },
      stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }).catch(() => {});
    await sendMessage(chatId, "Got the number. What name should I use for them?");
    return;
  }

  const clientId = session.userId;
  const seniorId = (session as any).seniorId ?? session.userId;
  if (!clientId || !seniorId) {
    await sendMessage(chatId, "I need to finish linking your account before I can add someone to this care group.");
    return;
  }

  await db.collection("agent_sessions").doc(phone).update({
    pendingAddFamilyMember: admin.firestore.FieldValue.delete(),
    stateExpiresAt: admin.firestore.FieldValue.delete(),
  }).catch(() => {});

  const { handleToolCall } = await import("../mcp/server");
  const result = await handleToolCall("add_family_member", {
    seniorId,
    name: memberName,
    memberPhone,
    clientId,
  }) as any;

  if (result?._toolError) {
    await sendMessage(chatId, result.message ?? "I couldn't add them yet. Please check the number and try again.");
    return;
  }

  await sendMessage(
    chatId,
    result?.notification?.sent === false
      ? `I added ${memberName} to the care group, but the welcome text did not go through. Please check the number.`
      : `Done - ${memberName} is in the care group, and I texted them the welcome message.`,
  );
}

// ── Intent routing — extracted verbatim from webhooks.ts handleInbound ───────
// Covers: pendingRematch, the pending agent_task lookup, intent classification
// and ALL intent branches through the QA-agent fallback. The try/catch/finally
// error boundary (agent_error_log + admin_alerts + deflection message + final
// stopTyping) stays in handleInbound — any throw from here is handled there.
export async function routeIntentAndRespond(ctx: IntentRouteContext): Promise<void> {
  const { phone, chatId, text, norm, session } = ctx;

  if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {/* non-critical */});

    if ((session as any).pendingAddFamilyMember) {
      await handleAddFamilyMemberIntent(phone, chatId, text, session);
      return;
    }

    // intentDegraded = the classifier errored/timed out and "QUESTION" is a
    // guess — when set, skip the quick-reply bypass and take the full QA path.
    const { intent, degraded: intentDegraded } = await classifyIntentDetailed(text, false);

    // ── /help: capability discovery ──────────────────────────────────────────
    // Static, side-effect-free reply listing what Evia can do for this role.
    // Reached only via the exact-string command bypass in classifyIntentDetailed.
    if (intent === "HELP") {
      const role: DiscoveryRole = session.userType === "caregiver"
        ? "caregiver"
        : (session as any).isSecondaryMember
          ? "family-secondary"
          : "client";
      const ops = await loadCaraOperationalContext({
        phone,
        userId: session.userId,
        caregiverId: session.caregiverId,
      }).catch(() => null);
      await sendMessage(chatId, buildHelpSmsReply(
        role,
        ops ? buildOperationalRecipeLead(ops, role) : undefined,
      ));
      return;
    }

    // ── U7/U8/U9: convergence shadow tap ─────────────────────────────────────
    // Dark unless this flow is enabled in ROUTING_CONVERGENCE_SHADOW. Fire-and-
    // forget so the live turn's latency is unaffected; runs the MCP loop in shadow
    // mode (U11 → zero side effects, nothing sent) and records the loop's outcome
    // to routing_shadow for the convergence pilot. Never shadows safety/onboarding
    // intents (they're absent from the intent→flow map).
    const shadowFlow = intentToShadowFlow(intent);
    if (shadowFlow) {
      void shadowTap({
        flow: shadowFlow, intent, text, phone, chatId,
        userId:   session.userId as string | undefined,
        seniorId: session.seniorId as string | undefined,
        userType: (session.userType as "client" | "caregiver") ?? "client",
        session:  session as unknown as Record<string, unknown>,
      }).catch(() => {});
    }

    // ── Stale high-stakes confirmation sweep ─────────────────────────────────
    // Any HIGH_STAKES_CONFIRM_FLAGS entry is checked by a YES/NO branch, so a
    // stale flag
    // (set long ago, never resolved) can intercept a YES meant for a newer
    // question. The global stateExpiresAt sweep in webhooks.ts only fires when a
    // stateExpiresAt is present — flags set without one never expire. Clear any
    // confirm flag older than its TTL here (and any flag with no age stamp, the
    // dangerous never-expires case), in DB and on the in-memory session, so the
    // branches only ever act on a fresh confirmation.
    {
      const stale = staleConfirmFlags(session as unknown as Record<string, unknown>);
      if (stale.length > 0) {
        const expired: Record<string, admin.firestore.FieldValue> = {};
        for (const flag of stale) {
          expired[flag] = admin.firestore.FieldValue.delete();
          expired[`${flag}SetAt`] = admin.firestore.FieldValue.delete();
          (session as any)[flag] = undefined;
        }
        await db.collection("agent_sessions").doc(phone).update(expired).catch(() => {});
      }
    }

    // ── HIRE_CAREGIVER — "let's go with Maria", "hire James", "I want to
    // book Sarah" ────────────────────────────────────────────────────────
    // 2026-09-13 live-testing find: this used to reply "Who would you like
    // to hire?" UNCONDITIONALLY, even when the family's own message already
    // named the caregiver (the classifier's own prompt example for this
    // intent IS "I want to book Sarah") — the name was thrown away and the
    // conversation dead-ended right here every time, never reaching
    // request_booking in that turn. Mirrors the FIND_CAREGIVER fix pattern
    // (2026-09-09/13, same file, below): only ask the generic question when
    // there's genuinely no caregiver context to resolve a name against;
    // otherwise fall through to runQaAgent, which already has the context
    // injection (pendingMatches/shownCaregiverIds) to resolve "her"/a named
    // caregiver and take the real next step (schedule_interview or
    // request_booking) itself.
    if (intent === "HIRE_CAREGIVER") {
      const sessionSnapHire      = await db.collection("agent_sessions").doc(phone).get();
      const sessionDataHire      = sessionSnapHire.data() ?? {};
      const pendingMatchesHire   = sessionDataHire.pendingMatches as Array<unknown> | undefined;
      const pendingMatchesSetAt  = sessionDataHire.pendingMatchesSetAt as string | undefined;
      const pendingMatchesFresh  = !!pendingMatchesHire && pendingMatchesHire.length > 0 &&
        (!pendingMatchesSetAt || pendingMatchesSetAt > new Date(Date.now() - PENDING_MATCHES_TTL_MS).toISOString());
      const shownCaregiverIdsHire  = sessionDataHire.shownCaregiverIds as Array<string> | undefined;
      const hasShownCaregiversHire = !!shownCaregiverIdsHire && shownCaregiverIdsHire.length > 0;
      if (!pendingMatchesFresh && !hasShownCaregiversHire) {
        await sendMessage(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
        return;
      }
      // Fresh pendingMatches, or a caregiver already shown this session —
      // fall through to normal routing / runQaAgent below.
    }

    // ── CAREGIVER_DECLINE_JOB — natural language job decline from caregiver ──
    if (intent === "CAREGIVER_DECLINE_JOB" && session.userType === "caregiver") {
      if ((session as any).pendingJobId) {
        await handleJobResponse(phone, "NO", chatId, session as any);
      } else {
        const noJobMsg = await generateCaraMessage({
          audience: "caregiver",
          context: "Caregiver responded to a job offer but there was no pending job in session. Evia acknowledges and lets them know it will reach out when something comes up.",
          fallback: "No worries — I'll reach out when something comes up.",
          maxTokens: 60,
        });
        await sendMessage(chatId, noJobMsg);
      }
      return;
    }

    // ── HIRE — post-interview decision ────────────────────────────────────────
    // 2026-09-09: this used to resolve a pendingInterviewOutcome flag (set only
    // by interviewAgent.ts's now-removed sendPostInterviewFollowUp) into a
    // hireMode handoff. Nothing sets that flag anymore since schedule_interview/
    // video_interviews became the only interview path (2026-09-07) — the fit
    // decision after a live interview now goes through submit_interview_feedback
    // (mcp/server.ts) instead. The fallback below is what always ran regardless.
    if (norm === "HIRE") {
      await sendMessage(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
      return;
    }

    // ── Caregiver selection (numbers after match presentation) ────────────────
    // 2026-09-07 (Hamse decision): a bare-number/name reply picking a caregiver
    // off the match list used to short-circuit here into handleInterviewSelection
    // (interviewAgent.ts) — a whole separate flow where EVIA asks the CAREGIVER
    // for their availability first, then confirms a mutual time with the family,
    // writing video_interviews directly instead of through the shared
    // requestVideoInterview() the website's own "Request Interview" modal uses.
    // That flow has NO website equivalent at all (the site always collects a
    // specific date/time from the client upfront) and was never brought under
    // the same eligibility/rate-limit protections requestVideoInterview() has.
    // Removed the interception entirely: qaAgent.ts already has purpose-built
    // handling for exactly this reply (see its "CAREGIVERS YOU JUST SHOWED THIS
    // FAMILY" context block) — it resolves a number/name/pronoun against
    // pendingMatches and calls schedule_interview (requestVideoInterview,
    // matching the site) after asking for a date/time if needed. A number reply
    // now simply falls through to normal routing/runQaAgent like a name reply
    // already did, so both go through the one flow that matches the site.
    // 2026-09-09: interviewAgent.ts (handleInterviewSelection and the rest of
    // the interview_requests-based negotiation flow it belonged to) has since
    // been deleted outright — the collection is retired, this was its only
    // remaining code path, and there was nothing left in flight to preserve.
    const stalePendingMatches = (session as any).pendingMatches as Array<unknown> | undefined;
    if (stalePendingMatches && stalePendingMatches.length > 0) {
      const setAt = (session as any).pendingMatchesSetAt as string | undefined;
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const isFresh = !setAt || setAt > twoHoursAgo;

      // ── Mid-match refilter ─────────────────────────────────────────────
      // "show me cheaper ones", "any with dementia experience", "anyone Saturday?"
      // — detect criterion changes and re-run matching with the new filters.
      if (isFresh) {
        const { detectMatchRefilter } = await import("../utils/matchRefilterDetector");
        // Load Evia's last message so the detector can tell a search-criteria
        // change ("show me cheaper ones") apart from the family simply ANSWERING
        // a question Evia just asked (e.g. "What date/time works best?" → "Today
        // at 11am"). Without it, a scheduling-time reply was being misread as an
        // availability refilter and triggering a fresh caregiver search.
        const lastAssistantMessage = await db
          .collection("agent_conversations").doc(phone).collection("messages")
          .where("role", "==", "assistant").orderBy("timestamp", "desc").limit(1).get()
          .then(s => (s.empty ? undefined : (s.docs[0].data().content as string | undefined)))
          .catch(() => undefined);
        const refilter = await detectMatchRefilter(text, lastAssistantMessage).catch(() => null);
        if (refilter) {
          // Map the spoken change onto the Find Caregivers page's own filter
          // panel (utils/matchRefilterDetector.ts → agents/caregiverSearch.ts).
          const prior = ((session as any).lastCaregiverSearchFilters ?? {}) as Record<string, unknown>;
          const nextFilters: Record<string, unknown> = { ...prior };
          if (refilter.skills?.length) nextFilters.specialties = Array.from(new Set([...(Array.isArray(prior.specialties) ? prior.specialties as string[] : []), ...refilter.skills]));
          if (refilter.languages?.length) nextFilters.languages = Array.from(new Set([...(Array.isArray(prior.languages) ? prior.languages as string[] : []), ...refilter.languages]));
          if (refilter.rate) nextFilters.sortBy = refilter.rate.direction === "lower" ? "price-low" : "price-high";
          if (refilter.distance) nextFilters.maxDistanceMiles = refilter.distance.direction === "wider" ? Math.max(Number(prior.maxDistanceMiles) || 25, 25) * 2 : 10;
          if (refilter.experienceYears?.min) nextFilters.minExperienceYears = refilter.experienceYears.min;

          await db.collection("agent_sessions").doc(phone).update({
            pendingMatches:      admin.firestore.FieldValue.delete(),
            pendingMatchesSetAt: admin.firestore.FieldValue.delete(),
            lastRefilterSummary: refilter.summary,
            lastCaregiverSearchFilters: nextFilters,
          }).catch(() => {});

          const { presentCaregiverSearch } = await import("../agents/caregiverSearch");
          await presentCaregiverSearch({ phone, chatId, clientId: session.userId as string | undefined, filters: nextFilters, source: "routeIntent:refilter" });
          return;
        }
      }

      // User isn't picking from the list — if their intent is to start a new
      // search (REBOOK_REQUEST, POST_JOB) or the list is stale, clear the
      // lingering state so it doesn't keep hijacking unrelated messages.
      // 2026-09-09 live incident: FIND_CAREGIVER used to be in this list too.
      // A fresh reoffer ("want me to send their profiles again, or keep
      // looking?") got its own answer ("Can you send me their profiles")
      // misclassified back into FIND_CAREGIVER, which cleared pendingMatches
      // right here and then re-ran the deterministic search below — repeating
      // the identical canned question instead of ever reaching the agent
      // (which has resend_caregiver_profile and could see what was just
      // shown). Removed: the FIND_CAREGIVER branch below now makes its own
      // freshness-aware decision instead of relying on this clearing early.
      const isFreshSearchIntent = intent === "REBOOK_REQUEST" || intent === "POST_JOB";
      if (!isFresh || isFreshSearchIntent) {
        await db.collection("agent_sessions").doc(phone).update({
          pendingMatches:      admin.firestore.FieldValue.delete(),
          pendingMatchesSetAt: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
        (session as any).pendingMatches = undefined;
      }
      // Otherwise fall through to normal intent routing.
    }

    // ── Permission update ─────────────────────────────────────────────────────
    if (intent === "PERMISSION_UPDATE") {
      const userId   = session.userId ?? session.caregiverId ?? phone;
      const userType = session.userType ?? "client";
      const handled = await updatePermissionFromText(userId, userType, phone, chatId, text);
      if (handled) return;
      // Classifier/parser failures fall through to the QA agent so the user
      // still gets a response instead of a silent terminal turn.
    }

    if (intent === "MEMORY_QUERY") {
      const zepUserId = getZepUserId(phone);
      const memUserId = session.userId ?? session.caregiverId ?? phone;
      // U4a (KTD9): the app userId keys reader-level reconciliation suppression
      // inside searchZepMemory — a mid-reconciliation Zep edge never reaches
      // the memory-query answer.
      const zepFacts  = await searchZepMemory(zepUserId, text, memUserId).catch(() => "");
      const { handleMemoryQuery } = await import("../memory/memoryFiles");
      // 2026-07-22 incident: pass the role so caregiver recall answers ground
      // on live account facts with caregiver framing, and RECORD the full turn
      // pair — this path used to skip the user turn entirely, so the next turn
      // had amnesia about it. Send skips the transport recorder and the pair
      // is saved once here (same record-exactly-once pattern as runQuickReply).
      const reply = await handleMemoryQuery(
        memUserId,
        chatId,
        (id, msg) => sendMessage(id, msg, { skipHistoryRecord: true }),
        text,
        zepFacts || undefined,
        { userType: session.userType, caregiverId: session.caregiverId ?? undefined },
      );
      if (reply) {
        const { recordSideChannelTurn } = await import("../agents/qaAgent");
        await recordSideChannelTurn(phone, text, reply);
      }
      return;
    }

    if (intent === "ADD_FAMILY_MEMBER") {
      await handleAddFamilyMemberIntent(phone, chatId, text, session);
      return;


      // Both pieces are now in hand — clear the partial-capture state.
    }

    if (intent === "REMOVE_FAMILY_MEMBER") {
      if ((session as any).isSecondaryMember) {
        await sendMessage(chatId, await generateCaraMessage({
          audience: "family",
          language: session.preferredLanguage === "es" ? "es" : "en",
          context: "This person is a secondary member of the care group and asked to remove someone. Warmly explain you're happy to help with updates here, but only the primary account holder can remove people from the care group.",
          fallback: "I can help with updates here, but only the primary account holder can remove people from this care group.",
          maxTokens: 70,
        }));
        return;
      }

      const { name: targetName, phone: extractedPhone } = await extractFamilyMember(text);
      let targetPhone: string | null = extractedPhone;

      if (!targetPhone && targetName) {
        const memberSnap = await db.collection("family_group_members")
          .where("primaryPhone", "==", phone)
          .get();
        // Exact (normalized) name match, not substring — substring would let
        // "Ann" resolve to "Joanna" and remove the wrong person. If more than
        // one member shares the name, ask for the phone to disambiguate rather
        // than guessing on a destructive action.
        const target = targetName.toLowerCase().trim();
        const matches = memberSnap.docs.filter(d =>
          (d.data().memberName as string ?? "").toLowerCase().trim() === target
        );
        if (matches.length > 1) {
          await sendMessage(chatId, `I have more than one ${targetName} in your care group. What's their phone number so I remove the right person?`);
          return;
        }
        if (matches.length === 1) targetPhone = matches[0].data().memberPhone as string;
      }

      if (!targetPhone) {
        await sendMessage(chatId, "I can remove them, but I need their phone number so I remove the right person.");
        return;
      }

      const seniorId: string = (session as any).seniorId ?? session.userId ?? phone;
      const clientId = session.userId;
      if (!clientId) {
        await sendMessage(chatId, "I need to finish linking your account before I can remove someone from this care group.");
        return;
      }

      const { handleToolCall } = await import("../mcp/server");
      const result = await handleToolCall("remove_family_member", {
        seniorId,
        memberPhone: targetPhone,
        phone,
        clientId,
        userId: clientId,
      }) as any;

      if (result?._pending_action) {
        await sendMessage(chatId, `Before I remove ${targetName ?? targetPhone} from the care group, please reply YES to confirm.`);
      } else if (result?._toolError) {
        await sendMessage(chatId, result.message ?? `I couldn't remove ${targetName ?? targetPhone} yet.`);
      } else {
        await sendMessage(chatId, `Done - ${targetName ?? targetPhone} has been removed from your care group.`);
      }
      return;
    }
    // ── CANCEL — a visit, a whole booking, or a pending request ─────────────
    // 2026-09-17: replaced the legacy path, which looked in the retired
    // `appointments` collection and parked a pendingCancelConfirm flag for
    // the YES/NO router to turn into an appointments write nothing on the
    // site reads. The scripted cancelFlow reads what the My Bookings page
    // can actually cancel right now (visits, whole bookings, pending booking/
    // replacement/schedule-change requests), asks which, confirms with the
    // site's own dialog wording, and makes the site's own write.
    if ((intent === "CANCEL_REQUEST" || norm === "CANCEL") && session.userType !== "caregiver") {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const { startCancelFlow } = await import("../agents/cancelFlow");
        await startCancelFlow(phone, chatId, session, { initialText: text });
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── REBOOK_REQUEST — "resend the booking" / "book Basra again" ───────────
    // 2026-09-17 (live-caught): the legacy path queried the retired
    // `appointments` collection, found nothing, and told a family with a real
    // cancelled request "we don't have a record of a previous caregiver". The
    // site has two buttons for this, both on Care Requests > Interviews:
    // Resend (a declined/cancelled request → the SAME request goes back to
    // pending) and Re-book (an accepted booking whose visits are all done → a
    // fresh booking from the completed interview). Same order here: a
    // resendable request wins, else the booking flow (whose interview
    // eligibility already treats a finished booking as re-bookable).
    if (intent === "REBOOK_REQUEST" && session.userType !== "caregiver") {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const { findResendableBookingRequests, startResendBookingFlow, startBookingFlow } = await import("../agents/bookingFlow");
        const rebookClientId = session.userId as string | undefined;
        const resendable = rebookClientId ? await findResendableBookingRequests(rebookClientId) : [];
        if (resendable.length > 0) await startResendBookingFlow(phone, chatId, session, {});
        else await startBookingFlow(phone, chatId, session, {});
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // Personal reminders (SCHEDULE_REQUEST/TRIGGER_MANAGEMENT) were removed
    // 2026-09-05 — no site equivalent. Both intents now fall through to the
    // default QA agent below, same as any other unhandled intent.

    // ── POST_JOB — start the conversational job posting state machine ────────
    if (intent === "POST_JOB" && session.userType !== "caregiver") {
      await startJobPostingFlow(phone, chatId, session);
      return;
    }

    // ── RESCHEDULE_REQUEST (caregiver) — natural language reschedule, mirrors RESCHEDULE keyword ──
    if (intent === "RESCHEDULE_REQUEST" && session.userType === "caregiver") {
      await db.collection("agent_sessions").doc(phone).update({
        caregiverRescheduling: true,
        stateExpiresAt:        new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      const rescheduleNlMsg = await generateCaraMessage({
        audience: "caregiver",
        context: "Caregiver wants to reschedule a visit. Evia is asking them to suggest 2–3 times that work and will relay them to the family.",
        fallback: "No problem — text me 2–3 times that work for you and I'll let the family know right away.",
        maxTokens: 80,
      });
      await sendMessage(chatId, rescheduleNlMsg);
      return;
    }

    // ── RESCHEDULE_REQUEST — move an existing visit to a new date/time ──────
    // 2026-09-15 (live-caught): left to the free-form agent loop this asserted
    // a visit on a day that had none, moved the WRONG visit, and the family's
    // plain "9/17 10am to 3pm" reply got hijacked by the memory-correction
    // detector. Now the website's Reschedule button as a scripted flow
    // (rescheduleFlow.ts): the family's REAL scheduled visits are read fresh,
    // their own words are parsed against that list, and every later reply is
    // captured by routeClient's pre-intent dispatch. Falls back to the agent
    // only when the flow could not start (it has already told the family why).
    if (intent === "RESCHEDULE_REQUEST" && session.userType !== "caregiver") {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const { startRescheduleFlow } = await import("../agents/rescheduleFlow");
        await startRescheduleFlow(phone, chatId, session, { initialText: text });
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── FIND_REPLACEMENT — cover a visit the caregiver cancelled ──────────────
    // The website's Find Replacement button (replacementFlow.ts). Exactly one
    // visit waiting on a replacement → start the flow on it directly, no agent
    // turn in between (2026-09-15, live-caught: the agent ran a general
    // caregiver search here instead). Zero or several → the agent, which has
    // get_upcoming_appointments + start_replacement_flow to sort out which.
    if (intent === "FIND_REPLACEMENT" && session.userType !== "caregiver" && session.userId) {
      const needing = await db.collection("shifts")
        .where("clientId", "==", session.userId)
        .where("status", "in", ["needs_replacement"])
        .where("date", ">=", businessTodayStr())
        .orderBy("date", "asc")
        .limit(5)
        .get();
      if (needing.docs.length === 1) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          const { startReplacementFlow } = await import("../agents/replacementFlow");
          await startReplacementFlow(phone, chatId, session, { shiftId: needing.docs[0].id });
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return;
      }
      await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
      });
      return;
    }

    // ── SWAP_REQUEST — caregiver looking for coverage on one of their shifts ──
    if (intent === "SWAP_REQUEST" && session.userType === "caregiver") {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const cgDoc = session.caregiverId
          ? await db.collection("caregivers").doc(session.caregiverId).get()
          : null;
        await handleCaregiverSwapRequest(
          session.caregiverId ?? phone,
          cgDoc?.data()?.name ?? "Caregiver",
          phone,
          text,
          // Session has no swapStep yet — handler defaults to "identify_shift"
          session as unknown as Record<string, unknown>,
          chatId
        );
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── CANCEL_SHIFT — caregiver proactively cancels one of their shifts ───
    if (intent === "CANCEL_SHIFT" && session.userType === "caregiver") {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const cgDoc = session.caregiverId
          ? await db.collection("caregivers").doc(session.caregiverId).get()
          : null;
        await handleCaregiverCancelShift(
          session.caregiverId ?? phone,
          cgDoc?.data()?.name ?? "Caregiver",
          phone,
          text,
          session as unknown as Record<string, unknown>,
          chatId,
        );
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── Caregiver profile updates (rate / skills / bio / photo / pause / reactivate) ──
    {
      const profileField = profileFieldFromIntent(intent) as ProfileUpdateField | undefined;
      if (profileField && session.userType === "caregiver" && session.caregiverId) {
        if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
        try {
          // Seed the session state with the requested field and entry step so the
          // handler enters "collect" cleanly.
          await db.collection("agent_sessions").doc(phone).update({
            profileUpdateStep:  "collect",
            profileUpdateField: profileField,
            stateExpiresAt:     new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
          const enrichedSession = {
            ...(session as unknown as Record<string, unknown>),
            profileUpdateStep:  "collect",
            profileUpdateField: profileField,
          };
          await handleCaregiverProfileUpdate(
            session.caregiverId,
            phone,
            text,
            enrichedSession,
            chatId,
            profileField,
          );
        } finally {
          if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
        }
        return;
      }
    }

    // ── INSTANT_PAYOUT — PAYOUT keyword / "cash out now" / etc. ────────────
    if (intent === "INSTANT_PAYOUT" && session.userType === "caregiver" && session.caregiverId) {
      if (session.service === "iMessage") await startTyping(chatId).catch(() => {});
      try {
        const { startInstantPayout } = await import("../agents/instantPayoutHandler");
        await startInstantPayout(session.caregiverId, phone, chatId);
      } finally {
        if (session.service === "iMessage") await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── UPDATE_PAYMENT_METHOD — generate Stripe billing portal link ───────────
    if (intent === "UPDATE_PAYMENT_METHOD" && session.userType !== "caregiver") {
      const clientId = session.userId ?? phone;
      try {
        const { handleToolCall } = await import("../mcp/server");
        const result = await handleToolCall("get_payment_update_link", { clientId }) as {
          success?: boolean; url?: string; action?: string; cardOnFile?: { brand?: string | null; last4?: string | null } | null;
        };
        if (result?.success && result?.url) {
          // The Payment Method tab's two buttons: "Add a card" (no billing account yet →
          // the membership page) or "Manage payment method" (Stripe Billing Portal).
          const onFile = result.cardOnFile?.last4
            ? ` (currently ${result.cardOnFile.brand ?? "card"} ending ${result.cardOnFile.last4})`
            : "";
          await sendMessage(chatId, result.action === "add_card"
            ? `You don't have a card on file yet. Add one here — it's the same page as the website's "Add a card" button:\n\n${result.url}`
            : `Here's a secure link to manage your card${onFile}:\n\n${result.url}\n\n` +
              `This link expires in 5 minutes. Once updated, your next payment will use the new card.`
          );
        } else {
          await sendMessage(chatId,
            "I wasn't able to generate a payment update link right now. Please visit the app settings to update your billing, or reply again and I'll try once more."
          );
        }
      } catch (err) {
        console.error("UPDATE_PAYMENT_METHOD error:", err);
        await sendMessage(chatId,
          "I ran into an issue generating your billing link. You can update your payment method in the app under Settings → Billing."
        );
      }
      return;
    }

    if (
      (intent === "VIEW_INVOICE" && session.userType !== "caregiver") ||
      (intent === "VIEW_CARE_PLAN_HISTORY" && session.userType !== "caregiver")
    ) {
      // runQaAgent delivers its own reply via sendSplit(chatId); do NOT double-send
      // through sendViaInteractionAgent (proactive-send path). Matches default QA path.
      await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
      });
      return;
    }

    if (intent === "VIEW_EARNINGS" && session.userType === "caregiver") {
      if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
      try {
        const cgId = (session.caregiverId ?? session.userId ?? phone) as string;
        await handleEarningsView(cgId, (msg: string) => sendMessage(chatId, msg));
      } finally {
        if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── UPDATE_AVAILABILITY — caregiver updates their schedule ───────────────
    if (intent === "UPDATE_AVAILABILITY" && session.userType === "caregiver") {
      if (session.service === "iMessage" && !session.groupChatId) await startTyping(chatId).catch(() => {});
      try {
        const cgId = (session.caregiverId ?? session.userId ?? phone) as string;
        await handleAvailabilityUpdate(
          cgId,
          phone,
          text,
          { ...session as unknown as Record<string, unknown>, availabilityStep: "start" },
          (msg: string) => sendMessage(chatId, msg)
        );
      } finally {
        if (session.service === "iMessage" && !session.groupChatId) await stopTyping(chatId).catch(() => {});
      }
      return;
    }

    // ── Platform-action intents — routed to QA agent with new MCP tools ─────
    if (
      intent === "VIEW_MY_JOBS"    ||
      intent === "VIEW_APPLICANTS" ||
      intent === "VIEW_JOURNAL"    ||
      intent === "BROWSE_JOB_BOARD"
    ) {
      // runQaAgent delivers its own reply via sendSplit(chatId); do NOT double-send
      // through sendViaInteractionAgent (proactive-send path). Matches default QA path.
      await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    session.userType    ?? "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
      });
      return;
    }

    // ── Credential management — "what logins do you have", "remove my CVS login" ─
    if (intent === "CREDENTIAL_MANAGEMENT" && session.userType !== "caregiver") {
      // runQaAgent delivers its own reply via sendSplit(chatId); do NOT double-send
      // through sendViaInteractionAgent (proactive-send path). Matches default QA path.
      await runQaAgent({
        text,
        phone,
        chatId,
        userId:      session.userId      ?? "",
        seniorId:    session.seniorId    ?? session.userId ?? "",
        userType:    "client",
        caregiverId: session.caregiverId,
        zepThreadId: (session as unknown as Record<string, unknown>).zepThreadId as string | undefined,
        session:     session as unknown as Record<string, unknown>,
        intent,
        ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
      });
      return;
    }

    // ── Find caregiver — post-onboarding matching request ────────────────────
    // isCaregiverSearchMisroutedAsProviderSearch is the safety net for when
    // the classifier mistakes a caregiver search for a medical-provider
    // search (see its own doc comment) — a live family hit exactly this.
    if (
      (intent === "FIND_CAREGIVER" || isCaregiverSearchMisroutedAsProviderSearch(intent, text)) &&
      session.userType !== "caregiver"
    ) {
      const sessionSnap2 = await db.collection("agent_sessions").doc(phone).get();
      const sessionData  = sessionSnap2.data() ?? {};
      // 2026-09-09 live incident: a fresh re-offer ("want me to send their
      // profiles again, or keep looking?") got its own answer ("Can you send
      // me their profiles") misclassified back into FIND_CAREGIVER, which
      // blindly re-ran this deterministic search and repeated the identical
      // canned question — the agent (which has resend_caregiver_profile and
      // can see exactly who was just shown, via pendingMatches) never got a
      // turn. When pendingMatches is still fresh, defer to the agent instead
      // of guessing from the intent label alone — it has both tools
      // available and can decide whether to resend or search again.
      const pendingMatches      = sessionData.pendingMatches as Array<unknown> | undefined;
      const pendingMatchesSetAt = sessionData.pendingMatchesSetAt as string | undefined;
      const pendingMatchesFresh = !!pendingMatches && pendingMatches.length > 0 &&
        (!pendingMatchesSetAt || pendingMatchesSetAt > new Date(Date.now() - PENDING_MATCHES_TTL_MS).toISOString());
      // 2026-09-13 live incident: "can you setup interview with Basra Yousuf"
      // (a caregiver just shown via find_nearby_caregivers, which only writes
      // shownCaregiverIds — never pendingMatches) classified as FIND_CAREGIVER
      // and sailed past pendingMatchesFresh, restarting a brand-new matching/
      // intake flow ("how often would the help be needed...") instead of
      // letting the agent recognize the named caregiver it already knows
      // about and call schedule_interview. shownCaregiverIds has no freshness
      // timestamp (it only ever grows via arrayUnion), so treat any caregiver
      // already shown this session the same as fresh pendingMatches — the
      // agent still has find_nearby_caregivers itself and can kick off a real
      // new search when that's actually what's being asked for; it just
      // shouldn't be pre-empted by this deterministic shortcut once there's
      // already caregiver context in play.
      const shownCaregiverIds  = sessionData.shownCaregiverIds as Array<string> | undefined;
      const hasShownCaregivers = !!shownCaregiverIds && shownCaregiverIds.length > 0;
      if (!pendingMatchesFresh && !hasShownCaregivers) {
        // The website's Find Caregivers page, texted as cards (agents/caregiverSearch.ts).
        const { presentCaregiverSearch } = await import("../agents/caregiverSearch");
        await presentCaregiverSearch({ phone, chatId, clientId: session.userId as string | undefined, source: "routeIntent:FIND_CAREGIVER" });
        return;
      }
      // Fresh pendingMatches, or a caregiver already shown this session —
      // fall through to normal routing / runQaAgent below.
    }

    // ── Healthcare intents — provider search, appointment booking, Rx ────────
    // Real-world healthcare/browser-automation actions were removed 2026-09-05
    // (client-tool capability audit: the site has zero medical-appointment/
    // pharmacy feature of any kind). Always deflect — never route to a
    // healthcare-action flow.
    // 2026-09-09 (live-caught): classifyIntentDetailed sees only the raw text,
    // no conversation history, so "Can you schedule interview with Basra
    // Yousuf" was misclassified as BOOK_DOCTOR_APPOINTMENT — its own few-shot
    // examples ("book an appointment with Dr. Smith", "schedule a checkup for
    // mom") superficially match schedule/book + a person's name. The word
    // "interview" is never used for a real medical appointment, so its
    // presence rules out this deflection regardless of what the classifier said.
    if (
      (intent === "FIND_NEARBY_PROVIDER" ||
       intent === "BOOK_DOCTOR_APPOINTMENT" ||
       intent === "PRESCRIPTION_REFILL" ||
       intent === "NEW_PRESCRIPTION") &&
      session.userType !== "caregiver" &&
      !/\binterview/i.test(text)
    ) {
      await sendMessage(chatId, buildNonMedicalDeflection(intent, text));
      return;
    }

    // ── Fact correction — user is correcting or retracting a known fact ──────
    // U4a (R11/R12/R15, KTD9/KTD10): typed detection over the bounded active-
    // fact candidate reader + transactional cross-store staging. A staged,
    // ambiguous, or unmatched request gets its deterministic acknowledgement
    // copy and ENDS the turn — pending forget never claims completion,
    // ambiguity asks one clarifying question and changes nothing, and no-match
    // is an honest "cannot identify that memory". The deterministic turn is
    // deliberately not persisted as a completed turn, so it is never passively
    // extracted (R23). not_correction/failed fall through to the QA agent.
    // 2026-09-05: classifyIntentDetailed sees ONLY the raw text, no conversation
    // history, so a mid-flow pushback ("you don't know their availability at
    // all") can read exactly like a fact correction out of context and misfire
    // into the honest-but-nonsensical "cannot identify that memory" copy —
    // live-caught mid a caregiver-interview flow. Same guard as the trivial
    // quick-reply bypass below: any turn inside an active guarded flow defers
    // to the full grounded agent instead, which has the actual conversation
    // context to answer correctly (and can still stage a real fact correction
    // itself via its own tools).
    // 2026-09-09: that guard only covers SCRIPTED flows (a tracked session
    // flag) — it doesn't cover a free-form agent-loop conversation like
    // schedule_interview's "what date/time?" ask, which sets no flag at all.
    // Live-caught there: bare "9/11", "9/12", "12pm" answers misfired into
    // FACT_CORRECTION, once even claiming a (nonexistent) correction was
    // staged. A message that is ENTIRELY just a date or time cannot carry a
    // real correction's explanatory language, so skip this branch for that
    // narrow shape regardless of hasActiveSmsFlow.
    // 2026-09-12: same misfire, a THIRD shape — the family corrected which
    // caregiver a PENDING confirmation (e.g. schedule_interview's "confirm
    // Imran?") referred to ("no i said basra"). handlePendingApprovals
    // (webhooks.ts) already judged this reply too complex to be a clean
    // YES/NO and fell through here so the full agent could use the pending
    // action's context to fix the mistake — but FACT_CORRECTION intercepted
    // first and tried to stage "basra" as a corrected MEMORY FACT about the
    // care situation, producing the nonsensical "I've updated that" ack
    // instead of ever touching the still-awaiting pending action. A reply
    // while a confirmation is awaiting is a correction to THAT action, never
    // a stored fact — skip this branch whenever one exists.
    const pendingDuringFactCheck = intent === "FACT_CORRECTION"
      ? await getLatestPending(phone).catch(() => null)
      : null;
    // 2026-09-18: a FOURTH shape — a timesheet is waiting in the family's
    // Needs Review tab and they text a corrected clock-in/out ("can you
    // change the clock in time to 10:03"). That is a correction to the
    // timesheet (review_shift_hours), never a stored fact — skip this branch
    // while one awaits them and let the agent propose the correction.
    let timesheetAwaitingDuringFactCheck = false;
    if (intent === "FACT_CORRECTION" && session.userType !== "caregiver" && session.userId) {
      try {
        const { hasTimesheetAwaitingClient } = await import("../agents/timesheetsPage");
        timesheetAwaitingDuringFactCheck = await hasTimesheetAwaitingClient(String(session.userId));
      } catch { timesheetAwaitingDuringFactCheck = false; }
    }
    if (
      intent === "FACT_CORRECTION" &&
      !pendingDuringFactCheck &&
      !timesheetAwaitingDuringFactCheck &&
      !hasActiveSmsFlow(session as unknown as Record<string, unknown>) &&
      !isBareDateOrTimeAnswer(text) &&
      !isBareYesNoAnswer(text)
    ) {
      const { detectAndStageFactChange, factChangeAckCopy } = await import("../memory/learnedFacts");
      const factUserId = session.userType === "caregiver"
        ? (session.caregiverId ?? session.userId ?? phone)
        : (session.userId ?? phone);
      const outcome = await detectAndStageFactChange({
        userId: factUserId,
        text,
        phone,
        // The intent classifier already judged this a correction/forget, so an
        // empty fact store yields the honest no_match copy, not silence (R15).
        assumeChangeIntent: true,
      }).catch((err) => ({
        kind: "failed" as const,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      }));

      const ack = factChangeAckCopy(outcome);
      if (ack) {
        await sendMessage(chatId, ack);
        return;
      }
      // not_correction / failed → fall through to the QA agent.
    }

    // ── Update onboarding — already-onboarded user wants to review/fix profile ─
    // PARTIAL users (no userId/seniorId) hit the onboarding offer earlier in
    // this handler and never reach here. For ONBOARDED users, flip a session
    // flag and fall through to runQaAgent — qaAgent reads the flag and runs a
    // structured profile-review sub-prompt (read current state, confirm in
    // prose, patch fields one at a time via update_care_plan). 20-minute TTL
    // prevents stale flags surviving across
    // unrelated future conversations.
    if (intent === "UPDATE_ONBOARDING" && session.userType !== "caregiver") {
      const ttlMs = 20 * 60 * 1000;
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await db.collection("agent_sessions").doc(phone).update({
        profileReviewMode:      true,
        profileReviewExpiresAt: expiresAt,
      }).catch((err) => console.warn("profileReviewMode set failed", err));
      // Mutate the in-memory session too so the directive fires THIS turn.
      (session as any).profileReviewMode      = true;
      (session as any).profileReviewExpiresAt = expiresAt;
      // Fall through to runQaAgent below.
    }

    // ── Default: QA agent ─────────────────────────────────────────────────────
    // Completed-session turn memory — Zep transcript, client learned-fact
    // extraction, and durable history sync — is owned by ONE boundary:
    // persistCompletedTurn → memory_operations → memoryOperationWorker
    // (memory-grounding plan 2026-07-17-002 U3, R8-R10). The old direct
    // addUserMessageToZep / addAssistantMessageToZep / extractAndStoreFacts
    // tail that lived here is superseded — do NOT re-add per-callsite writes.
    // Pre-completion onboarding Zep writes (webhooks.ts) and structured
    // business-event writes are separate paths and remain in place (R10).
    const zepThreadId = (session as any).zepThreadId as string | undefined;

    // ── Trivial quick-reply bypass — short generic greetings/thanks ─────────
    // For QUESTION-intent messages with no entity content, skip the full
    // tool-use loop and answer with gpt-4o-mini in ~1s. Conservative heuristic:
    // anything ambiguous falls through to runQaAgent below. A degraded
    // classification (classifier error → guessed QUESTION) never qualifies —
    // the full agent path with its supervisor is the fail-safe.
    //
    // Found 2026-09-04: a short in-flow reply ("yeah", "anyone else", "which
    // one", a bare first name like "Amina") classifies as QUESTION with no
    // entity content and passed isTrivialQuickReply — routing to
    // runQuickReply, which has NO tool access and answers purely from the
    // last few turns of chat history. Mid a caregiver-matching flow
    // (pendingMatches set), that produced fabricated caregiver names/details
    // never backed by any real Firestore record — a hallucinated match, not
    // a stale one. hasActiveSmsFlow (pendingMatches + every other guarded
    // state-machine flag, sessionState.ts) is the existing, already-tested
    // signal for "a multi-turn flow is in progress here" — any turn inside
    // one of those needs real grounding, so it must never take the no-tool
    // fast path regardless of how trivial the text looks in isolation.
    // 2026-09-18 (live-caught): the interview check-in ("did it happen? I can
    // mark it complete") is a yes/no question, but a bare "yes" classified as
    // QUESTION, passed isTrivialQuickReply, and the no-tools quick reply
    // answered "Got it, noted." — the interview stayed Accepted. A bare yes/no
    // to a fresh check-in is the interview card's button: YES = the site's
    // Mark as Completed write; NO = offer Reschedule / Cancel. Anything else
    // goes to the full agent (which gets the interview id in its prompt) —
    // never to the quick reply while the check-in is fresh.
    const nudgeReply = await handleCompletionNudgeReply({ phone, chatId, text, session: session as unknown as Record<string, unknown> });
    if (nudgeReply) {
      await persistDefaultQaTurn(ctx, nudgeReply);
      return;
    }
    // 2026-09-19: the first-visit review prompt ("reply with 1 to 5 stars") on
    // the completion recap. A star count / yes starts reviewFlow.ts (the site's
    // Leave a Review modal) with the rating prefilled; "no thanks" clears it;
    // anything else is not ours and routes as normal. LLM-classified, fresh 24h.
    // 2026-09-20: "Reply APPROVE to use this phone as your proof, or NO" after a
    // recovery-email change request (accountRecovery.ts sets the anchor).
    if (await handleEmailChangeReply({ phone, chatId, text, session: session as unknown as Record<string, unknown> })) return;
    if (await handleReviewPromptReply({ phone, chatId, text, session: session as unknown as Record<string, unknown> })) return;
    if (
      intent === "QUESTION" &&
      !intentDegraded &&
      isTrivialQuickReply(text) &&
      !hasActiveSmsFlow(session as unknown as Record<string, unknown>) &&
      !freshCompletionNudgeInterviewId(session as unknown as Record<string, unknown>)
    ) {
      const quickReply = await runQuickReply({
        text,
        phone,
        chatId,
        userId:      session.userId ?? "",
        seniorId:    session.seniorId ?? session.userId ?? "",
        userType:    session.userType ?? "client",
        caregiverId: session.caregiverId,
        session:     session as unknown as Record<string, unknown>,
      });
      await persistDefaultQaTurn(ctx, quickReply ?? "");
      return;
    }

    const qaReply = await runQaAgent({
      text,
      phone,
      chatId,
      userId:      session.userId   ?? "",
      seniorId:    session.seniorId ?? session.userId ?? "",
      userType:    session.userType ?? "client",
      caregiverId: session.caregiverId,
      zepThreadId,
      session:     session as unknown as Record<string, unknown>,
      intent,
      // U4: Linq turn identity for lifecycle checkpoints.
      ...(ctx.eventId ? { sourceTurn: { conversationId: chatId, messageId: ctx.eventId } } : {}),
    });

    await persistDefaultQaTurn(ctx, qaReply ?? "");
}

// ── Completed-turn memory persistence (memory-grounding plan U3, R8/R9) ──────
// One call per completed default QA/quick turn. qaAgent already wrote the
// durable history pair (saveConversationTurn) and delivered the reply;
// persistCompletedTurn ADOPTS those rows, creates the reference-only turn_sync
// operation, and the one-minute memoryOperationWorker dispatches the Zep
// transcript write and (client-only) learned-fact extraction with retries.
// A persistence failure is a typed outcome + aggregate log — it must never
// throw into a turn whose tools and reply already committed (R8).
async function persistDefaultQaTurn(ctx: IntentRouteContext, assistantText: string): Promise<void> {
  // Empty reply = the agent held/skipped the turn (DND, handoff hold, empty
  // guard) — not a completed turn; the agent layer's judgment is authoritative.
  if (!assistantText?.trim()) return;
  const { phone, text, session } = ctx;
  try {
    const { persistCompletedTurn } = await import("../memory/conversationMemory");
    const outcome = await persistCompletedTurn({
      channel:       "linq",
      sourceKey:     ctx.eventId ?? "",
      phone,
      userId:        session.userId ?? "",
      userText:      text,
      assistantText,
      // R8: family-fact extraction stays CLIENT-only — the exact eligibility
      // the removed direct tail used (non-caregiver role + linked userId).
      extractFacts:  session.userType !== "caregiver" && Boolean(session.userId),
      adoptExistingRows: true,
    });
    if (!outcome.ok) {
      // R21: aggregate/enum-only log — channel + error class, no content/phone.
      console.warn(JSON.stringify({
        memory_turn_persistence_skipped: true,
        channel:     "linq",
        error_class: outcome.errorClass,
        timestamp:   new Date().toISOString(),
      }));
    }
  } catch (err) {
    // persistCompletedTurn is contractually non-throwing; belt-and-suspenders
    // so a memory failure can never fail a turn that already replied (R8).
    console.error(JSON.stringify({
      memory_turn_persistence_skipped: true,
      channel:     "linq",
      error_class: err instanceof Error ? err.constructor.name : typeof err,
      timestamp:   new Date().toISOString(),
    }));
  }
}
