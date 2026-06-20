import { z } from "zod";
import {
  createBrowserSession,
  closeBrowserSession,
  withSessionTimeout,
  searchWeb,
  fetchPage,
  logBrowserSession,
  BrowserSession,
} from "./browserbaseClient";

// Field-fill login (H-U10): the password NEVER enters a Stagehand act()
// instruction (which is sent to the model and can surface in session
// recordings). We locate the fields with best-effort selectors and fill them
// via Playwright directly, then submit without echoing the secret. Per-portal
// selector tuning is expected (see the healthcare-action runbook).
async function loginWithFieldFill(
  session: BrowserSession,
  credentials: { username: string; password: string },
): Promise<void> {
  const page = session.page as unknown as {
    fill: (sel: string, val: string) => Promise<void>;
  };
  const userSel =
    'input[autocomplete="username"], input[type="email"], input[name*="user" i], ' +
    'input[id*="user" i], input[name*="email" i], input[id*="email" i]';
  const passSel = 'input[type="password"], input[autocomplete="current-password"]';
  await page.fill(userSel, credentials.username);
  await page.fill(passSel, credentials.password);
  // Submit semantically — no credential values in the instruction.
  await session.stagehand.act("Submit the login form");
}
import {
  getCredential,
  markCredentialUsed,
  PortalService,
  insurerToServiceKey,
} from "./credentialVault";

// ── ACTION 1: Search for a healthcare provider ────────────────────────────────
// "Find Dr. Peterson's phone number"
// "What are the hours for CVS on Peachtree?"
// "Does Northside Hospital accept United Healthcare?"

export async function searchHealthcareProvider(params: {
  userId: string;
  phone: string;
  query: string;
  city?: string;
}): Promise<{
  found: boolean;
  results: Array<{ name: string; url?: string }>;
  summary: string;
}> {
  const startTime = Date.now();
  const sessionId = "search_" + Date.now();

  try {
    const searchQuery = params.city
      ? `${params.query} ${params.city}`
      : params.query;

    const results = await searchWeb(searchQuery, 5);

    let pageContent = "";
    if (results[0]?.url) {
      const fetched = await fetchPage(results[0].url).catch(() => null);
      if (fetched && fetched.statusCode === 200) {
        pageContent = fetched.content.slice(0, 2000);
      }
    }

    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId,
      action: "search_healthcare_provider",
      success: true,
      result: `Found ${results.length} results for: ${searchQuery}`,
      durationMs: Date.now() - startTime,
    });

    return {
      found: results.length > 0,
      results: results.map(r => ({ name: r.title, url: r.url })),
      summary: pageContent || results.map(r => r.title).join(", "),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId,
      action: "search_healthcare_provider",
      success: false,
      error: message,
      durationMs: Date.now() - startTime,
    });
    throw err;
  }
}

// ── ACTION 2: Get pharmacy information ────────────────────────────────────────
// "What are the CVS hours near mom's house?"
// "Does Walgreens on Peachtree have mom's blood pressure medication?"

export async function getPharmacyInfo(params: {
  userId: string;
  phone: string;
  pharmacy: string;
  query: string;
  city?: string;
  zip?: string;
}): Promise<{
  found: boolean;
  info: string;
  url?: string;
}> {
  const startTime = Date.now();
  const sessionId = "search_" + Date.now();

  try {
    const searchQuery = [params.pharmacy, params.query, params.city, params.zip]
      .filter(Boolean)
      .join(" ");

    const results = await searchWeb(searchQuery, 3);

    let info = "";
    if (results[0]?.url) {
      const fetched = await fetchPage(results[0].url, true).catch(() => null);
      if (fetched?.statusCode === 200) {
        info = fetched.content.slice(0, 1500);
      }
    }

    if (!info && results.length > 0) {
      info = results.map(r => `${r.title}: ${r.url}`).join("\n");
    }

    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId,
      action: "get_pharmacy_info",
      success: true,
      result: `Found pharmacy info for: ${searchQuery}`,
      durationMs: Date.now() - startTime,
    });

    return {
      found: !!info,
      info: info || "No information found",
      url: results[0]?.url,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId,
      action: "get_pharmacy_info",
      success: false,
      error: message,
      durationMs: Date.now() - startTime,
    });
    throw err;
  }
}

// ── ACTION 3: Fetch a healthcare portal page ──────────────────────────────────
// Read any publicly accessible healthcare page for context.

export async function fetchHealthcarePage(params: {
  userId: string;
  phone: string;
  url: string;
}): Promise<{
  content: string;
  statusCode: number;
}> {
  const startTime = Date.now();
  const sessionId = "fetch_" + Date.now();

  try {
    const result = await fetchPage(params.url, true);

    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId,
      action: "fetch_healthcare_page",
      success: result.statusCode === 200,
      result: `Fetched ${params.url}: ${result.statusCode}`,
      durationMs: Date.now() - startTime,
    });

    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId,
      action: "fetch_healthcare_page",
      success: false,
      error: message,
      durationMs: Date.now() - startTime,
    });
    throw err;
  }
}

// ── ACTION 4: Full browser action via Stagehand ───────────────────────────────
// Poke-style AI browser navigation for tasks requiring a real browser session.
// For launch: public sites only (no login required).

export async function performBrowserAction(params: {
  userId: string;
  phone: string;
  task: string;
  url?: string;
  requiresLogin?: boolean;
}): Promise<{
  success: boolean;
  result: string;
  sessionId: string;
  debugUrl?: string;
}> {
  const startTime = Date.now();
  let session: BrowserSession | null = null;

  if (params.requiresLogin) {
    return {
      success: false,
      result:
        "I can't log into websites automatically yet — that feature is coming soon. " +
        "I can find the right link and walk you through it step by step.",
      sessionId: "not_started",
    };
  }

  try {
    session = await createBrowserSession({ proxies: true, solveCaptchas: true });
    const page = session.page;

    if (params.url) {
      await page.goto(params.url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    }

    await session.stagehand.act(params.task);
    await page.waitForTimeout(2000);

    const extracted = await session.stagehand.extract(
      `Extract the key information relevant to: ${params.task}`,
      z.object({
        summary: z.string(),
        keyInfo: z.string().optional(),
      })
    );

    const result = extracted?.summary ?? "Task completed.";

    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId: session.sessionId,
      action: "perform_browser_action",
      success: true,
      result: result.slice(0, 200),
      durationMs: Date.now() - startTime,
    });

    return {
      success: true,
      result,
      sessionId: session.sessionId,
      debugUrl: `https://www.browserbase.com/sessions/${session.sessionId}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[performBrowserAction] error:", err);

    await logBrowserSession({
      userId: params.userId,
      phone: params.phone,
      sessionId: session?.sessionId ?? "error",
      action: "perform_browser_action",
      success: false,
      error: message,
      durationMs: Date.now() - startTime,
    });

    return {
      success: false,
      result:
        "I ran into a problem completing that task. " +
        "Let me find the right link for you instead.",
      sessionId: session?.sessionId ?? "error",
    };
  } finally {
    if (session) await closeBrowserSession(session);
  }
}

// ── ACTION 5: Schedule a doctor appointment ───────────────────────────────────
// Logs into MyChart / athenahealth / FollowMyHealth and books an appointment.
// Returns needsCredentials: true if login hasn't been stored yet.

const DOCTOR_PORTAL_URLS: Record<string, string> = {
  mychart:        "https://mychart.com",
  athenahealth:   "https://www.athenahealth.com/patients",
  followmyhealth: "https://www.followmyhealth.com",
};

export interface AppointmentSlot {
  provider: string;
  datetime: string; // ISO or portal-native date/time string
  location?: string;
}

// PASS 1 (H-U3): read-only discovery. Log in, navigate, find the doctor, and
// extract a concrete candidate slot — WITHOUT submitting. The returned slot is
// what the family approves; nothing is committed here. Stops cleanly before any
// step that could soft-hold a slot.
export async function findAppointmentSlots(params: {
  userId:          string;
  phone:           string;
  doctorName:      string;
  specialty?:      string;
  preferredDate?:  string;
  portalService?:  PortalService;
  portalUrl?:      string;
}): Promise<{
  success:          boolean;
  needsCredentials?: boolean;
  slot?:            AppointmentSlot;
  ambiguous?:       boolean;
  result:           string;
  sessionId?:       string;
}> {
  const startTime = Date.now();
  let session: BrowserSession | null = null;
  const service = params.portalService ?? "mychart";

  const credentials = await getCredential(params.userId, service);
  if (!credentials) return { success: false, needsCredentials: true, result: "credentials_required" };

  try {
    session = await createBrowserSession({ proxies: true, solveCaptchas: true });
    const sess = session;
    const portalUrl = params.portalUrl ?? credentials.portalUrl ?? DOCTOR_PORTAL_URLS[service] ?? "https://mychart.com";

    const slot = await withSessionTimeout(sess, async () => {
      await sess.page.goto(portalUrl, { waitUntil: "domcontentloaded" });
      await sess.page.waitForTimeout(2000);
      await loginWithFieldFill(sess, credentials);
      await sess.page.waitForTimeout(3000);
      await sess.stagehand.act("Navigate to the appointments or scheduling section");
      await sess.page.waitForTimeout(2000);
      await sess.stagehand.act(`Find and select ${params.doctorName}${params.specialty ? ` (${params.specialty})` : ""}`);
      await sess.page.waitForTimeout(2000);
      const dateContext = params.preferredDate ? `closest to ${params.preferredDate}` : "the soonest available";
      // Extract a concrete candidate slot WITHOUT selecting/submitting.
      return sess.stagehand.extract(
        `List the single best available appointment slot for ${params.doctorName} ${dateContext}. ` +
          "Do NOT select or book anything. Return provider, an ISO-like datetime, and location.",
        z.object({ provider: z.string(), datetime: z.string(), location: z.string().optional() }),
      );
    });

    await markCredentialUsed(params.userId, service, true);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: sess.sessionId,
      action: "find_appointment_slots", success: !!slot?.datetime,
      result: slot?.datetime ? `Found ${slot.provider} ${slot.datetime}` : "no slot",
      durationMs: Date.now() - startTime,
    });

    if (!slot?.datetime) return { success: false, result: "no_slots_available", sessionId: sess.sessionId };
    return { success: true, slot, result: "slot_found", sessionId: sess.sessionId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markCredentialUsed(params.userId, service, false);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session?.sessionId ?? "error",
      action: "find_appointment_slots", success: false, error: message, durationMs: Date.now() - startTime,
    });
    return {
      success: false,
      result: `I couldn't reach the ${service} scheduling page. Reply "update my ${service} login" if your password changed.`,
      sessionId: session?.sessionId,
    };
  } finally {
    if (session) await closeBrowserSession(session);
  }
}

// PASS 2 (H-U3 + H-U6): commit the APPROVED slot. Re-locate it, extract-verify
// EXACTLY ONE slot matches {provider, datetime, location} (0 → slot_unavailable,
// >1 → slot_ambiguous, never a silent re-pick), submit, then verification
// read-back. Never reports "booked" without a confirmation/accepted state.
export async function bookAppointmentSlot(params: {
  userId:         string;
  phone:          string;
  chosenSlot:     AppointmentSlot;
  portalService?: PortalService;
  portalUrl?:     string;
}): Promise<{
  status:             "verified_success" | "unverified" | "failed" | "slot_unavailable" | "slot_ambiguous";
  result:             string;
  confirmationNumber?: string;
  sessionId?:         string;
}> {
  const startTime = Date.now();
  let session: BrowserSession | null = null;
  const service = params.portalService ?? "mychart";
  const { provider, datetime, location } = params.chosenSlot;

  const credentials = await getCredential(params.userId, service);
  if (!credentials) return { status: "failed", result: "credentials_required" };

  try {
    session = await createBrowserSession({ proxies: true, solveCaptchas: true });
    const sess = session;
    const portalUrl = params.portalUrl ?? credentials.portalUrl ?? DOCTOR_PORTAL_URLS[service] ?? "https://mychart.com";

    const outcome = await withSessionTimeout(sess, async () => {
      await sess.page.goto(portalUrl, { waitUntil: "domcontentloaded" });
      await sess.page.waitForTimeout(2000);
      await loginWithFieldFill(sess, credentials);
      await sess.page.waitForTimeout(3000);
      await sess.stagehand.act("Navigate to the appointments or scheduling section");
      await sess.page.waitForTimeout(2000);
      await sess.stagehand.act(`Find ${provider}'s available appointment slots`);
      await sess.page.waitForTimeout(2000);

      // Re-identify the approved slot — a rendered slot is NOT a stable handle.
      const match = await sess.stagehand.extract(
        `Count how many available slots EXACTLY match provider "${provider}", datetime "${datetime}"` +
          (location ? `, location "${location}"` : "") + ". Return the integer count.",
        z.object({ matchCount: z.number() }),
      );
      const count = match?.matchCount ?? 0;
      if (count === 0) return { status: "slot_unavailable" as const };
      if (count > 1) return { status: "slot_ambiguous" as const };

      await sess.stagehand.act(`Select the slot for ${provider} at ${datetime}${location ? ` (${location})` : ""}`);
      await sess.page.waitForTimeout(2000);
      await sess.stagehand.act("Confirm and submit the appointment");
      await sess.page.waitForTimeout(3000);

      // Verification read-back — proof of commit before we claim success.
      const confirm = await sess.stagehand.extract(
        "Extract the booking confirmation number and confirmed status, if shown.",
        z.object({ confirmationNumber: z.string().optional(), confirmed: z.boolean().optional() }),
      );
      if (confirm?.confirmationNumber) {
        return { status: "verified_success" as const, confirmationNumber: confirm.confirmationNumber };
      }
      return { status: "unverified" as const };
    });

    // Only a verified confirmation read-back marks the credential as
    // successfully used. "unverified" means we submitted but the portal never
    // confirmed — the booking may have failed, so don't record it as a success
    // (which would mask a credential/portal problem).
    const success = outcome.status === "verified_success";
    await markCredentialUsed(params.userId, service, success);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: sess.sessionId,
      action: "book_appointment_slot", success, result: outcome.status,
      durationMs: Date.now() - startTime,
    });

    const messages: Record<string, string> = {
      verified_success: `Booked with ${provider} for ${datetime}${outcome.status === "verified_success" && "confirmationNumber" in outcome ? ` — confirmation #${outcome.confirmationNumber}` : ""}.`,
      unverified:       `Submitted the appointment with ${provider} for ${datetime} — awaiting the portal's confirmation.`,
      slot_unavailable: `That ${datetime} slot with ${provider} is no longer available. Want me to find another?`,
      slot_ambiguous:   `I found more than one slot matching that time with ${provider}, so I didn't book — want me to re-check the options?`,
      failed:           `I couldn't complete the booking with ${provider}. Reply "update my ${service} login" if your password changed.`,
    };
    return {
      status:             outcome.status,
      result:             messages[outcome.status],
      confirmationNumber: "confirmationNumber" in outcome ? outcome.confirmationNumber : undefined,
      sessionId:          sess.sessionId,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markCredentialUsed(params.userId, service, false);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session?.sessionId ?? "error",
      action: "book_appointment_slot", success: false, error: message, durationMs: Date.now() - startTime,
    });
    return {
      status: "failed",
      result: `I ran into a problem booking with ${provider}. Reply "update my ${service} login" if your password changed.`,
      sessionId: session?.sessionId,
    };
  } finally {
    if (session) await closeBrowserSession(session);
  }
}

// ── ACTION 6: Request a pharmacy refill ──────────────────────────────────────

const PHARMACY_URLS: Record<string, string> = {
  cvs:       "https://www.cvs.com/account/login",
  walgreens: "https://www.walgreens.com/login",
  riteaid:   "https://www.riteaid.com/account/login",
};

export async function requestPharmacyRefill(params: {
  userId:           string;
  phone:            string;
  pharmacyService:  "cvs" | "walgreens" | "riteaid";
  medicationName?:  string;
  rxNumber?:        string;
  seniorName?:      string;
}): Promise<{
  success:          boolean;
  result:           string;
  needsCredentials?: boolean;
  refillDetails?:   {
    medication:      string;
    rxNumber?:       string;
    estimatedReady?: string;
    pickupLocation?: string;
  };
  sessionId?: string;
}> {
  const startTime = Date.now();
  let session: BrowserSession | null = null;
  const service = params.pharmacyService as PortalService;

  const credentials = await getCredential(params.userId, service);
  if (!credentials) {
    return { success: false, result: "credentials_required", needsCredentials: true };
  }

  try {
    session = await createBrowserSession({ proxies: true, solveCaptchas: true });
    const page      = session.page;
    const portalUrl = credentials.portalUrl ?? PHARMACY_URLS[service] ?? "https://www.cvs.com/account/login";

    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    await loginWithFieldFill(session, credentials); // H-U10: no password in act()
    await page.waitForTimeout(3000);

    await session.stagehand.act("Navigate to prescriptions or refill section");
    await page.waitForTimeout(2000);

    const medTarget = params.rxNumber
      ? `prescription with Rx number ${params.rxNumber}`
      : params.medicationName
        ? `${params.medicationName}${params.seniorName ? ` for ${params.seniorName}` : ""}`
        : "the most recently filled prescription";

    await session.stagehand.act(`Find and select ${medTarget}`);
    await page.waitForTimeout(2000);

    await session.stagehand.act("Request a refill for this prescription");
    await page.waitForTimeout(3000);

    const details = await session.stagehand.extract(
      "Extract the refill details: medication name, Rx number, estimated ready date, and pickup location",
      z.object({
        medication:     z.string(),
        rxNumber:       z.string().optional(),
        estimatedReady: z.string().optional(),
        pickupLocation: z.string().optional(),
      })
    );

    await markCredentialUsed(params.userId, service, true);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session.sessionId,
      action: "pharmacy_refill", success: true,
      result: `Refill requested for ${details?.medication ?? params.medicationName ?? "prescription"}`,
      durationMs: Date.now() - startTime,
    });

    return {
      success:       true,
      result:        `Refill requested for ${details?.medication ?? params.medicationName ?? "prescription"}`,
      refillDetails: details ?? undefined,
      sessionId:     session.sessionId,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markCredentialUsed(params.userId, service, false);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session?.sessionId ?? "error",
      action: "pharmacy_refill", success: false,
      error: message, durationMs: Date.now() - startTime,
    });
    return {
      success: false,
      result:
        `I ran into a problem with the ${service} refill. ` +
        `Reply "update my ${service} login" if your password changed.`,
      sessionId: session?.sessionId,
    };
  } finally {
    if (session) await closeBrowserSession(session);
  }
}

// ── ACTION 7: Check insurance coverage / authorization / claim status ─────────

export async function checkInsuranceAuthorization(params: {
  userId:              string;
  phone:               string;
  insurer:             string;
  checkType:           "coverage" | "authorization" | "claim_status";
  serviceDescription?: string;
  referenceNumber?:    string;
  seniorName?:         string;
  insurerPortalUrl?:   string;
}): Promise<{
  success:          boolean;
  result:           string;
  needsCredentials?: boolean;
  details?:         {
    status?:              string;
    covered?:             boolean;
    authorizationNumber?: string;
    effectiveDate?:       string;
    notes?:               string;
  };
  sessionId?: string;
}> {
  const startTime = Date.now();
  let session: BrowserSession | null = null;
  const service = insurerToServiceKey(params.insurer);

  const credentials = await getCredential(params.userId, service);
  if (!credentials) {
    return { success: false, result: "credentials_required", needsCredentials: true };
  }

  try {
    session = await createBrowserSession({ proxies: true, solveCaptchas: true });
    const page = session.page;

    const portalUrl = params.insurerPortalUrl
      ?? credentials.portalUrl
      ?? `https://www.${params.insurer.toLowerCase().replace(/\s+/g, "")}.com/member`;

    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    await loginWithFieldFill(session, credentials); // H-U10: no password in act()
    await page.waitForTimeout(3000);

    const navTarget: Record<string, string> = {
      coverage:      "Navigate to benefits or coverage section",
      authorization: "Navigate to prior authorization or referrals section",
      claim_status:  "Navigate to claims or claim status section",
    };
    await session.stagehand.act(navTarget[params.checkType]);
    await page.waitForTimeout(2000);

    if (params.referenceNumber) {
      await session.stagehand.act(`Search for reference number ${params.referenceNumber}`);
      await page.waitForTimeout(2000);
    } else if (params.serviceDescription) {
      await session.stagehand.act(
        `Check ${params.checkType} for: ${params.serviceDescription}` +
        (params.seniorName ? ` for ${params.seniorName}` : "")
      );
      await page.waitForTimeout(2000);
    }

    const details = await session.stagehand.extract(
      `Extract the ${params.checkType} result: status, whether covered, authorization number, effective dates, and key notes`,
      z.object({
        status:              z.string(),
        covered:             z.boolean().optional(),
        authorizationNumber: z.string().optional(),
        effectiveDate:       z.string().optional(),
        notes:               z.string().optional(),
      })
    );

    await markCredentialUsed(params.userId, service, true);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session.sessionId,
      action: "insurance_check", success: true,
      result: `${params.checkType} check: ${details?.status ?? "complete"}`,
      durationMs: Date.now() - startTime,
    });

    return {
      success:  true,
      result:   `${params.insurer} ${params.checkType} check complete`,
      details:  details ?? undefined,
      sessionId: session.sessionId,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markCredentialUsed(params.userId, service, false);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session?.sessionId ?? "error",
      action: "insurance_check", success: false,
      error: message, durationMs: Date.now() - startTime,
    });
    return {
      success: false,
      result:
        `I ran into a problem checking ${params.insurer}. ` +
        `The portal may require updated credentials or be temporarily down.`,
      sessionId: session?.sessionId,
    };
  } finally {
    if (session) await closeBrowserSession(session);
  }
}
