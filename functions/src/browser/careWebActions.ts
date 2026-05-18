import { z } from "zod";
import {
  createBrowserSession,
  closeBrowserSession,
  searchWeb,
  fetchPage,
  logBrowserSession,
  BrowserSession,
} from "./browserbaseClient";
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

export async function scheduleDoctorAppointment(params: {
  userId:          string;
  phone:           string;
  doctorName:      string;
  specialty?:      string;
  preferredDate?:  string;
  appointmentType?: string;
  portalService?:  PortalService;
  portalUrl?:      string;
}): Promise<{
  success:            boolean;
  result:             string;
  needsCredentials?:  boolean;
  appointmentDetails?: {
    date:                string;
    time:                string;
    doctor?:             string;
    location?:           string;
    confirmationNumber?: string;
  };
  sessionId?: string;
}> {
  const startTime = Date.now();
  let session: BrowserSession | null = null;
  const service = params.portalService ?? "mychart";

  const credentials = await getCredential(params.userId, service);
  if (!credentials) {
    return { success: false, result: "credentials_required", needsCredentials: true };
  }

  try {
    session = await createBrowserSession({ proxies: true, solveCaptchas: true });
    const page      = session.page;
    const portalUrl = params.portalUrl ?? credentials.portalUrl ?? DOCTOR_PORTAL_URLS[service] ?? "https://mychart.com";

    await page.goto(portalUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    await session.stagehand.act(
      `Log in with username "${credentials.username}" and password "${credentials.password}"`
    );
    await page.waitForTimeout(3000);

    await session.stagehand.act("Navigate to the appointments or scheduling section");
    await page.waitForTimeout(2000);

    await session.stagehand.act(
      `Find and select ${params.doctorName}${params.specialty ? ` (${params.specialty})` : ""}`
    );
    await page.waitForTimeout(2000);

    if (params.appointmentType) {
      await session.stagehand.act(`Select appointment type: ${params.appointmentType}`);
      await page.waitForTimeout(2000);
    }

    const dateContext = params.preferredDate ? `closest to ${params.preferredDate}` : "as soon as possible";
    await session.stagehand.act(`Find and select an available appointment slot ${dateContext}`);
    await page.waitForTimeout(2000);

    await session.stagehand.act("Confirm and submit the appointment");
    await page.waitForTimeout(3000);

    const details = await session.stagehand.extract(
      "Extract the appointment confirmation: date, time, doctor name, location, and confirmation number",
      z.object({
        date:               z.string(),
        time:               z.string(),
        doctor:             z.string().optional(),
        location:           z.string().optional(),
        confirmationNumber: z.string().optional(),
      })
    );

    await markCredentialUsed(params.userId, service, true);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session.sessionId,
      action: "schedule_doctor_appointment", success: true,
      result: `Scheduled with ${params.doctorName} on ${details?.date ?? "unknown date"}`,
      durationMs: Date.now() - startTime,
    });

    return {
      success:            true,
      result:             `Appointment scheduled with ${params.doctorName}`,
      appointmentDetails: details ?? undefined,
      sessionId:          session.sessionId,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markCredentialUsed(params.userId, service, false);
    await logBrowserSession({
      userId: params.userId, phone: params.phone, sessionId: session?.sessionId ?? "error",
      action: "schedule_doctor_appointment", success: false,
      error: message, durationMs: Date.now() - startTime,
    });
    return {
      success: false,
      result:
        `I ran into a problem scheduling with ${params.doctorName}. ` +
        `The portal may have changed or your login may need updating. ` +
        `Reply "update my ${service} login" to refresh your credentials.`,
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

    await session.stagehand.act(
      `Log in with email "${credentials.username}" and password "${credentials.password}"`
    );
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

    await session.stagehand.act(
      `Log in with username "${credentials.username}" and password "${credentials.password}"`
    );
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
