import * as admin from "firebase-admin";
import { quickComplete } from "../utils/openaiClient";
import { safeParseJson } from "../utils/jsonUtils";
import { generateCaraMessage } from "../utils/caraMessage";
import {
  searchHealthcareProvider,
  findAppointmentSlots,
} from "../browser/careWebActions";
import { hasCredential } from "../browser/credentialVault";
import { proposePendingAction } from "./pendingActions";
import type { AgentSession } from "../linq/client";

// Route a healthcare write action through the SAME propose→confirm→execute gate
// the MCP path uses (R1: NEVER auto-commit from this conversational flow). Builds
// a pending action keyed to the account holder and sends them the confirmation;
// their YES is handled by the inbound approvalHandler, which dispatches the gated
// commit (bookAppointmentSlot / requestPharmacyRefill). Fails closed.
async function proposeHealthcareAction(params: {
  phone: string;
  userId: string;
  sendMessage: (msg: string) => Promise<unknown>;
  toolInput: Record<string, unknown>;
}): Promise<void> {
  // H-U9: ship dark — flag-off never proposes or commits.
  const { realWorldHealthcareActionsEnabled } = await import("../config/featureFlags");
  if (!realWorldHealthcareActionsEnabled()) {
    await params.sendMessage(
      "I can look up info and find the right links for you — taking action directly on your healthcare portals is coming soon.",
    );
    return;
  }
  let action;
  try {
    action = await proposePendingAction({
      phone: params.phone, userId: params.userId,
      toolName: "perform_web_action", toolInput: params.toolInput,
    });
  } catch (err) {
    console.error("healthcareHandler: proposePendingAction failed (fail-closed)", {
      phone: params.phone,
      err: err instanceof Error ? err.message : String(err),
    });
    await params.sendMessage(
      "I couldn't verify the primary account holder for this, so I can't proceed. " +
      "Please have the account holder text me directly.",
    );
    return;
  }
  const approver = action.approverPhone ?? params.phone;
  const confirmMsg = `${action.preview}? Reply YES to approve or NO to decline.`;
  if (approver === params.phone) {
    await params.sendMessage(confirmMsg);
  } else {
    const { sendViaInteractionAgent } = await import("./caraAgent");
    // Fail closed: if the approver notification doesn't go out, let the error
    // propagate so we DON'T tell the requester it was sent when it wasn't.
    await sendViaInteractionAgent(approver, {
      content: confirmMsg, urgency: "immediate", sourceAgent: "healthcare_approval", canDrop: false,
    });
    await params.sendMessage("I've sent this to the primary account holder to approve — I'll let you know once it's confirmed.");
  }
}

const db = admin.firestore();

async function parseWithClaude(prompt: string, userText: string): Promise<string> {
  try {
    return await quickComplete(prompt, userText, { maxTokens: 200 });
  } catch {
    return "__parse_error__";
  }
}

async function isQuestionOrOther(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    "Reply YES if this is a general question or off-topic comment unrelated to answering the current question. " +
    "Reply NO if it is a direct answer. Only reply YES or NO.",
    text
  );
  return result.toUpperCase().startsWith("Y");
}

async function answerMidFlow(text: string, context: string): Promise<string> {
  return (await quickComplete(
    `You are Cara, a warm AI care assistant. A client is in the middle of a healthcare request. ` +
      `Context: ${context}. Answer their question briefly (1–2 sentences).`,
    text,
    { maxTokens: 120 },
  )).trim();
}

// ── Flow data ─────────────────────────────────────────────────────────────────

export interface HealthcareFlowData {
  intent: string;
  // Provider search
  query?: string;
  location?: string;
  providerType?: string;
  specialty?: string;
  // Appointment booking
  doctorName?: string;
  appointmentType?: string;
  preferredDate?: string;
  portalService?: string;
  // Prescription refill
  pharmacyService?: string;
  medicationName?: string;
  rxNumber?: string;
  // New prescription
  condition?: string;
}

// ── Firestore state helpers ───────────────────────────────────────────────────

async function setFlowState(
  phone: string,
  step: string,
  data: HealthcareFlowData,
  ttlMs = 20 * 60 * 1000
): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    healthcareFlowStep: step,
    healthcareFlowData: data,
    stateExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
}

async function clearFlowState(phone: string): Promise<void> {
  await db.collection("agent_sessions").doc(phone).update({
    healthcareFlowStep: admin.firestore.FieldValue.delete(),
    healthcareFlowData: admin.firestore.FieldValue.delete(),
    stateExpiresAt:     admin.firestore.FieldValue.delete(),
  });
}

// ── Provider search execution ─────────────────────────────────────────────────

function formatProviderResults(
  results: Array<{ name: string; url?: string }>,
  summary: string,
  providerType: string,
  location: string
): string {
  if (results.length === 0) {
    return (
      `I couldn't find any ${providerType}s near ${location}. ` +
      `Try a different zip code or city name.`
    );
  }

  const lines: string[] = [];
  for (let i = 0; i < Math.min(results.length, 5); i++) {
    lines.push(`${i + 1}. ${results[i].name}`);
    if (results[i].url) lines.push(`   ${results[i].url}`);
  }

  // Include the fetched snippet if it has useful text (not just URLs)
  const snippet =
    summary && summary.length > 30 && !summary.startsWith("http")
      ? `\n\n${summary.slice(0, 400)}`
      : "";

  return `Here are ${providerType}s near ${location}:\n\n${lines.join("\n")}${snippet}`;
}

async function doProviderSearch(
  phone: string,
  sendMessage: (msg: string) => Promise<unknown>,
  data: HealthcareFlowData,
  userId: string
): Promise<void> {
  const location = data.location ?? "";
  const providerType = data.specialty || data.providerType || "healthcare provider";

  await sendMessage("Give me a moment — searching nearby...");

  const result = await searchHealthcareProvider({
    userId,
    phone,
    query: `${providerType} near ${location}`,
    city: location,
  });

  await clearFlowState(phone);
  await sendMessage(formatProviderResults(result.results, result.summary, providerType, location));
}

// ── Appointment booking execution ─────────────────────────────────────────────

async function executeAppointmentBooking(
  phone: string,
  sendMessage: (msg: string) => Promise<unknown>,
  data: HealthcareFlowData,
  userId: string
): Promise<void> {
  const portal = (data.portalService ?? "mychart") as
    "mychart" | "athenahealth" | "followmyhealth";

  const hasCred = await hasCredential(userId, portal);
  if (!hasCred) {
    await clearFlowState(phone);
    const portalLabel =
      portal === "mychart" ? "MyChart" :
      portal === "athenahealth" ? "athenahealth" : "FollowMyHealth";
    await sendMessage(
      `To book for you automatically I need your ${portalLabel} login. ` +
      `Reply "save my ${portal} login" and I'll walk you through storing it securely.`
    );
    return;
  }

  await sendMessage(`Finding an appointment with ${data.doctorName ?? "your doctor"} — give me a minute...`);

  // PASS 1 (H-U3): read-only discovery — find a concrete slot. We do NOT book.
  // Always clear the flow state, even if discovery throws, so a failed lookup
  // can't leave stale flow state stranded in the session.
  let found;
  try {
    found = await findAppointmentSlots({
      userId,
      phone,
      doctorName:    data.doctorName ?? "your doctor",
      preferredDate: data.preferredDate,
      portalService: portal,
    });
  } finally {
    await clearFlowState(phone);
  }

  if (found.needsCredentials) {
    await sendMessage(`I need your ${portal} portal login to book for you. Reply "save my ${portal} login" to set it up.`);
    return;
  }
  if (!found.success || !found.slot) {
    await sendMessage(`I couldn't find an available slot with ${data.doctorName ?? "your doctor"}. Want me to try a different date?`);
    return;
  }

  // Propose the discovered slot for the account holder's approval (R1).
  await proposeHealthcareAction({
    phone, userId, sendMessage,
    toolInput: { loginAction: "schedule_appointment", chosenSlot: found.slot, portalService: portal, doctorName: data.doctorName },
  });
}

// ── Prescription refill execution ─────────────────────────────────────────────

async function executePharmacyRefill(
  phone: string,
  sendMessage: (msg: string) => Promise<unknown>,
  data: HealthcareFlowData,
  userId: string
): Promise<void> {
  const pharmacy = (data.pharmacyService ?? "cvs") as "cvs" | "walgreens" | "riteaid";

  const hasCred = await hasCredential(userId, pharmacy);
  if (!hasCred) {
    await clearFlowState(phone);
    await sendMessage(
      `To request the refill for you I need your ${pharmacy.toUpperCase()} account login. ` +
      `Reply "save my ${pharmacy} login" and I'll securely store it.`
    );
    return;
  }

  await clearFlowState(phone);

  // Propose for the account holder's approval (R1) — never auto-submit. The
  // gated commit (requestPharmacyRefill) runs on their YES via approvalHandler.
  await proposeHealthcareAction({
    phone, userId, sendMessage,
    toolInput: { loginAction: "pharmacy_refill", pharmacyService: pharmacy, medicationName: data.medicationName, rxNumber: data.rxNumber },
  });
}

// ── Entry: start a new healthcare flow ────────────────────────────────────────

export async function startHealthcareFlow(
  phone: string,
  chatId: string,
  text: string,
  session: AgentSession,
  intent: string,
  sendMessage: (msg: string) => Promise<unknown>
): Promise<void> {
  const userId = session.userId ?? phone;

  // ── FIND_NEARBY_PROVIDER ──────────────────────────────────────────────────
  if (intent === "FIND_NEARBY_PROVIDER") {
    const parsed = await parseWithClaude(
      `Extract from this message:
1. providerType: one of "doctor", "clinic", "pharmacy", "urgent care", "dentist", "specialist" — default "doctor"
2. specialty: e.g. "cardiologist", "dermatologist", "pediatrician" — or "" if not specified
3. location: city name, neighborhood, or zip code — or "" if not mentioned

Reply as JSON only: {"providerType":"...","specialty":"...","location":"..."}`,
      text
    );

    let providerType = "doctor";
    let specialty    = "";
    let location     = "";
    const p = safeParseJson<{ providerType?: string; specialty?: string; location?: string }>(parsed, "healthcareHandler.providerSearch", null, "object");
    if (p) {
      providerType = p.providerType || "doctor";
      specialty    = p.specialty    || "";
      location     = p.location     || "";
    }

    const data: HealthcareFlowData = {
      intent,
      query:        specialty || providerType,
      providerType: specialty || providerType,
      specialty,
      location,
    };

    if (!location) {
      await setFlowState(phone, "hc_search_location", data);
      const msg = await generateCaraMessage({
        audience: "family",
        context:  `Cara is helping find a nearby ${specialty || providerType}. Ask for the city or zip code to search near.`,
        fallback: `What city or zip code should I search near?`,
        maxTokens: 60,
      });
      await sendMessage(msg);
      return;
    }

    await doProviderSearch(phone, sendMessage, data, userId);
    return;
  }

  // ── BOOK_DOCTOR_APPOINTMENT ───────────────────────────────────────────────
  if (intent === "BOOK_DOCTOR_APPOINTMENT") {
    const parsed = await parseWithClaude(
      `Extract from this message:
1. doctorName: doctor's name or "" if not mentioned
2. appointmentType: one of "checkup", "follow-up", "urgent", "new patient" — or "" if not specified
3. preferredDate: preferred date in natural language or "" if not mentioned
4. portalService: one of "mychart", "athenahealth", "followmyhealth" — or "" if not mentioned

Reply as JSON only: {"doctorName":"...","appointmentType":"...","preferredDate":"...","portalService":"..."}`,
      text
    );

    let doctorName      = "";
    let appointmentType = "";
    let preferredDate   = "";
    let portalService   = "";
    const p = safeParseJson<{ doctorName?: string; appointmentType?: string; preferredDate?: string; portalService?: string }>(parsed, "healthcareHandler.appointment", null, "object");
    if (p) {
      doctorName      = p.doctorName      || "";
      appointmentType = p.appointmentType || "";
      preferredDate   = p.preferredDate   || "";
      portalService   = p.portalService   || "";
    }

    const data: HealthcareFlowData = { intent, doctorName, appointmentType, preferredDate, portalService };

    if (!doctorName) {
      await setFlowState(phone, "hc_appt_doctor", data);
      const msg = await generateCaraMessage({
        audience: "family",
        context:  "Cara is helping book a doctor appointment. Ask for the doctor's name.",
        fallback: "Which doctor would you like to book with?",
        maxTokens: 60,
      });
      await sendMessage(msg);
      return;
    }
    if (!appointmentType) {
      await setFlowState(phone, "hc_appt_type", data);
      await sendMessage(`What type of visit with ${doctorName}? (checkup, follow-up, urgent, or new patient)`);
      return;
    }
    if (!preferredDate) {
      await setFlowState(phone, "hc_appt_date", data);
      const msg = await generateCaraMessage({
        audience: "family",
        context:  `Cara is booking a ${appointmentType} with ${doctorName}. Ask what date works best.`,
        fallback: "What date works best for you?",
        maxTokens: 60,
      });
      await sendMessage(msg);
      return;
    }
    if (!portalService) {
      await setFlowState(phone, "hc_appt_portal", data);
      await sendMessage("Which patient portal do you use — MyChart, athenahealth, or FollowMyHealth?");
      return;
    }

    await executeAppointmentBooking(phone, sendMessage, data, userId);
    return;
  }

  // ── PRESCRIPTION_REFILL ───────────────────────────────────────────────────
  if (intent === "PRESCRIPTION_REFILL") {
    const parsed = await parseWithClaude(
      `Extract from this message:
1. pharmacyService: one of "cvs", "walgreens", "riteaid" — or "" if not mentioned
2. medicationName: medication name or "" if not mentioned
3. rxNumber: Rx prescription number or "" if not mentioned

Reply as JSON only: {"pharmacyService":"...","medicationName":"...","rxNumber":"..."}`,
      text
    );

    let pharmacyService = "";
    let medicationName  = "";
    let rxNumber        = "";
    const p = safeParseJson<{ pharmacyService?: string; medicationName?: string; rxNumber?: string }>(parsed, "healthcareHandler.refill", null, "object");
    if (p) {
      pharmacyService = p.pharmacyService || "";
      medicationName  = p.medicationName  || "";
      rxNumber        = p.rxNumber        || "";
    }

    const data: HealthcareFlowData = { intent, pharmacyService, medicationName, rxNumber };

    if (!pharmacyService) {
      await setFlowState(phone, "hc_rx_pharmacy", data);
      await sendMessage("Which pharmacy — CVS, Walgreens, or Rite Aid?");
      return;
    }

    await executePharmacyRefill(phone, sendMessage, data, userId);
    return;
  }

  // ── NEW_PRESCRIPTION ──────────────────────────────────────────────────────
  if (intent === "NEW_PRESCRIPTION") {
    // Detect if this is actually a refill in disguise
    const kind = await parseWithClaude(
      "Is this about renewing/refilling an existing medication the person already takes, " +
      "or a brand-new prescription for a condition they haven't been treated for yet? " +
      'Reply "refill" or "new" only.',
      text
    );

    if (kind.toLowerCase() === "refill") {
      await startHealthcareFlow(phone, chatId, text, session, "PRESCRIPTION_REFILL", sendMessage);
      return;
    }

    const condition = await parseWithClaude(
      "What condition or symptom needs this new prescription? Extract just the condition in a few words. Reply 'general' if unclear.",
      text
    );

    // If we couldn't pin down a condition from the initial message, ask for it
    // explicitly instead of silently storing "general" and moving on. Avoids the
    // case where Cara later sends the doctor a vague "needs a new prescription for
    // general" request.
    const isUnclear = condition === "__parse_error__" || condition.toLowerCase() === "general";
    if (isUnclear) {
      await setFlowState(phone, "hc_newrx_condition", { intent });
      await sendMessage(
        "Happy to help. What condition or symptom is this new prescription for?"
      );
      return;
    }

    const data: HealthcareFlowData = {
      intent,
      condition,
    };

    await setFlowState(phone, "hc_newrx_hasdoctor", data);
    const msg = await generateCaraMessage({
      audience: "family",
      context:  `Client needs a new prescription for ${data.condition}. Ask if they have a doctor they'd like to see for this.`,
      fallback: "Do you already have a doctor you'd like to book for this?",
      maxTokens: 80,
    });
    await sendMessage(msg);
    return;
  }
}

// ── Resume: handle replies to in-progress flows ───────────────────────────────

export async function resumeHealthcareFlow(
  phone: string,
  chatId: string,
  text: string,
  session: AgentSession,
  sendMessage: (msg: string) => Promise<unknown>
): Promise<void> {
  const step = (session as any).healthcareFlowStep as string;
  const data = ((session as any).healthcareFlowData ?? {}) as HealthcareFlowData;
  const userId = session.userId ?? phone;

  // ── hc_search_location: waiting for city/zip ──────────────────────────────
  if (step === "hc_search_location") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client is providing their location for a provider search");
      await sendMessage(answer);
      await sendMessage("What city or zip code should I search near?");
      return;
    }
    const location = await parseWithClaude(
      "Extract just the city name, neighborhood, or zip code from this message. Reply with only the location.",
      text
    );
    const updated = { ...data, location: location === "__parse_error__" ? text.trim() : location };
    await setFlowState(phone, "hc_search_location", updated);
    await doProviderSearch(phone, sendMessage, updated, userId);
    return;
  }

  // ── hc_appt_doctor: waiting for doctor name ───────────────────────────────
  if (step === "hc_appt_doctor") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client is booking a doctor appointment");
      await sendMessage(answer);
      await sendMessage("Which doctor would you like to book with?");
      return;
    }
    const doctorName = await parseWithClaude(
      "Extract the doctor's name from this message. Reply with the name only.",
      text
    );
    const updated = { ...data, doctorName: doctorName === "__parse_error__" ? text.trim() : doctorName };
    await setFlowState(phone, "hc_appt_type", updated);
    await sendMessage(`What type of visit with ${updated.doctorName}? (checkup, follow-up, urgent, or new patient)`);
    return;
  }

  // ── hc_appt_type: waiting for appointment type ────────────────────────────
  if (step === "hc_appt_type") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client is choosing appointment type");
      await sendMessage(answer);
      await sendMessage("What type of visit is this? (checkup, follow-up, urgent, or new patient)");
      return;
    }
    const raw = await parseWithClaude(
      '"checkup" or "annual" or "routine" or "physical" → checkup. ' +
      '"follow up" or "follow-up" or "return" → follow-up. ' +
      '"urgent" or "sick" or "asap" → urgent. ' +
      '"new patient" or "first time" or "new" → new patient. ' +
      "Reply with exactly one of: checkup, follow-up, urgent, new patient.",
      text
    );
    const apptType = ["checkup", "follow-up", "urgent", "new patient"].includes(raw) ? raw : "checkup";
    const updated = { ...data, appointmentType: apptType };
    await setFlowState(phone, "hc_appt_date", updated);
    const msg = await generateCaraMessage({
      audience: "family",
      context:  `Cara is booking a ${apptType} with ${updated.doctorName ?? "the doctor"}. Ask what date works best.`,
      fallback: "What date works best for you?",
      maxTokens: 60,
    });
    await sendMessage(msg);
    return;
  }

  // ── hc_appt_date: waiting for preferred date ──────────────────────────────
  if (step === "hc_appt_date") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client is picking an appointment date");
      await sendMessage(answer);
      await sendMessage("What date works best?");
      return;
    }
    const updated = { ...data, preferredDate: text.trim() }; // keep natural language for Stagehand

    if (!updated.portalService) {
      await setFlowState(phone, "hc_appt_portal", updated);
      await sendMessage("Which patient portal do you use — MyChart, athenahealth, or FollowMyHealth?");
      return;
    }
    await executeAppointmentBooking(phone, sendMessage, updated, userId);
    return;
  }

  // ── hc_appt_portal: waiting for portal choice ─────────────────────────────
  if (step === "hc_appt_portal") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client is choosing their patient portal");
      await sendMessage(answer);
      await sendMessage("Which portal do you use — MyChart, athenahealth, or FollowMyHealth?");
      return;
    }
    const raw = await parseWithClaude(
      '"mychart" or "my chart" → mychart. ' +
      '"athena" or "athenahealth" or "athena health" → athenahealth. ' +
      '"followmyhealth" or "follow my health" or "fmh" → followmyhealth. ' +
      "Reply with exactly one of: mychart, athenahealth, followmyhealth.",
      text
    );
    const portal = ["mychart", "athenahealth", "followmyhealth"].includes(raw) ? raw : "mychart";
    await executeAppointmentBooking(phone, sendMessage, { ...data, portalService: portal }, userId);
    return;
  }

  // ── hc_rx_pharmacy: waiting for pharmacy choice ───────────────────────────
  if (step === "hc_rx_pharmacy") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client is choosing their pharmacy for a refill");
      await sendMessage(answer);
      await sendMessage("Which pharmacy — CVS, Walgreens, or Rite Aid?");
      return;
    }
    const raw = await parseWithClaude(
      '"cvs" or "CVS" → cvs. ' +
      '"walgreens" or "walgreen" → walgreens. ' +
      '"rite aid" or "riteaid" or "rite-aid" → riteaid. ' +
      "Reply with exactly one of: cvs, walgreens, riteaid.",
      text
    );
    const pharmacy = ["cvs", "walgreens", "riteaid"].includes(raw) ? raw : "cvs";
    await executePharmacyRefill(phone, sendMessage, { ...data, pharmacyService: pharmacy }, userId);
    return;
  }

  // ── hc_newrx_condition: ask explicitly what the prescription is for ───────
  // Reached when the initial intent message didn't carry a clear condition.
  if (step === "hc_newrx_condition") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client needs a new prescription and Cara asked what condition it's for");
      await sendMessage(answer);
      await sendMessage("What condition or symptom is this new prescription for?");
      return;
    }
    const condition = text.trim().slice(0, 200);
    await setFlowState(phone, "hc_newrx_hasdoctor", { ...data, condition });
    const msg = await generateCaraMessage({
      audience: "family",
      context:  `Client needs a new prescription for ${condition}. Ask if they have a doctor they'd like to see for this.`,
      fallback: "Got it. Do you already have a doctor you'd like to book for this?",
      maxTokens: 80,
    });
    await sendMessage(msg);
    return;
  }

  // ── hc_newrx_hasdoctor: do they have a doctor for this? ───────────────────
  if (step === "hc_newrx_hasdoctor") {
    if (await isQuestionOrOther(text)) {
      const answer = await answerMidFlow(text, "client needs a new prescription and Cara asked if they have a doctor");
      await sendMessage(answer);
      await sendMessage("Do you already have a doctor you'd like to book for this?");
      return;
    }
    const raw = await parseWithClaude(
      "Does the user say YES they have a doctor, or NO they don't? Reply YES or NO only.",
      text
    );
    const hasDoctor = raw.toUpperCase().startsWith("Y");

    if (hasDoctor) {
      // Pivot to appointment booking flow
      const bookingData: HealthcareFlowData = {
        intent:          "BOOK_DOCTOR_APPOINTMENT",
        appointmentType: "follow-up",
      };
      await setFlowState(phone, "hc_appt_doctor", bookingData);
      const msg = await generateCaraMessage({
        audience: "family",
        context:  `Client needs a prescription for ${data.condition ?? "a condition"}. They have a doctor. Ask for the doctor's name to book.`,
        fallback: "Which doctor would you like to see for this?",
        maxTokens: 70,
      });
      await sendMessage(msg);
    } else {
      // Search for nearby providers based on condition
      const specialty = await parseWithClaude(
        `Given this medical condition: "${data.condition ?? "general"}". ` +
        `What type of doctor treats this? Reply with just the specialty (e.g. "cardiologist", "dermatologist", "primary care doctor"). ` +
        `Default to "primary care doctor" if unsure.`,
        data.condition ?? "general"
      );
      const providerType = specialty === "__parse_error__" ? "primary care doctor" : specialty;
      const searchData: HealthcareFlowData = {
        intent:       "FIND_NEARBY_PROVIDER",
        query:        providerType,
        providerType,
        specialty:    providerType,
      };
      await setFlowState(phone, "hc_search_location", searchData);
      const msg = await generateCaraMessage({
        audience: "family",
        context:  `Client needs a ${providerType} for ${data.condition ?? "a new condition"} and doesn't have one. Ask for city or zip to find nearby options.`,
        fallback: `Let me find a ${providerType} near you. What city or zip code?`,
        maxTokens: 80,
      });
      await sendMessage(msg);
    }
    return;
  }

  // Unrecognized step — clear and apologize
  await clearFlowState(phone);
  const msg = await generateCaraMessage({
    audience: "family",
    context:  "There was an issue with a healthcare request. Cara is apologizing and offering to help again.",
    fallback: "Something went wrong with that request — let's start over. What can I help you with?",
    maxTokens: 60,
  });
  await sendMessage(msg);
}
