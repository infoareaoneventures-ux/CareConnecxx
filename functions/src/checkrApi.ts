// Shared Checkr REST helpers — the ONE place that talks to the Checkr API.
//
// Checkr's contract: an invitation REQUIRES an existing candidate. Create the
// candidate first (POST /candidates — email required), then create the
// invitation with its candidate_id. An invitation POST without a candidate_id
// is rejected — that malformed call was the launch-blocking "I can't generate
// the background check link right now" bug (2026-07-07): three inline call
// sites in onboardingConversation.ts each POSTed /v1/invitations with only
// {package, first_name, last_name}. Every Checkr call goes through here now.
//
// Kept dependency-light (fetch helper only) so it can be imported from the
// agents/ modules without dragging in the checkr.ts webhook/callable graph.

import { fetchWithTimeout } from "./utils/httpTimeout";

export class CheckrApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "CheckrApiError";
  }
}

function basicAuth(apiKey: string): string {
  return "Basic " + Buffer.from(apiKey + ":").toString("base64");
}

export async function checkrPost(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string
): Promise<any> {
  // CHECKR_KEY is preferred — avoids legacy Secret Manager binding on CHECKR_API_KEY
  const apiKey = (process.env.CHECKR_KEY || process.env.CHECKR_API_KEY || "").trim();
  if (!apiKey) {
    throw new CheckrApiError("Checkr API Key not configured.");
  }
  const headers: Record<string, string> = {
    "Authorization": basicAuth(apiKey),
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  const baseUrl = process.env.CHECKR_API_URL || "https://api.checkr.com/v1";
  const keySource = process.env.CHECKR_KEY ? "CHECKR_KEY" : "CHECKR_API_KEY";
  console.log(`Checkr POST ${baseUrl}${path} key=${apiKey.slice(0, 8)}... (from ${keySource})`);
  const res = await fetchWithTimeout(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Checkr ${path} failed: ${res.status} ${errBody}`);
    throw new CheckrApiError("Checkr request failed.", res.status);
  }
  return res.json();
}

export interface CheckrInvitationArgs {
  firstName: string;
  lastName:  string;
  /** Required by Checkr for candidate creation. Empty string fails loudly here
   *  instead of as an opaque Checkr 400. */
  email:     string;
  zipCode?:  string;
  /** Checkr package slug, e.g. "checkrdirect_essential_criminal". */
  packageSlug: string;
  /** Stable caller id (e.g. Firebase uid) — becomes Checkr custom_id and the
   *  idempotency-key base. Falls back to name+email. */
  customId?: string;
  /** Reuse an existing candidate (renewals / re-invites) instead of creating one. */
  candidateId?: string;
  /** work_locations (required by Checkr for US checks) — built when state is known. */
  workState?: string;
  workCity?:  string;
}

export interface CheckrInvitationResult {
  invitationUrl: string;
  candidateId:   string;
}

export async function createCheckrInvitation(args: CheckrInvitationArgs): Promise<CheckrInvitationResult> {
  // Date-scoped idempotency key prevents duplicate candidates on same-day retries
  // (same idiom as initiateCheckrCandidate in checkr.ts).
  const dateKey = new Date().toISOString().slice(0, 10);
  const idBase  = (args.customId || `${args.firstName}-${args.lastName}-${args.email}`)
    .toLowerCase().replace(/[^a-z0-9@._-]+/g, "-").slice(0, 80);

  const workLocations = args.workState
    ? [{ country: "US", state: args.workState.toUpperCase(), ...(args.workCity ? { city: args.workCity } : {}) }]
    : [];

  let candidateId = args.candidateId;
  if (!candidateId) {
    if (!args.email) {
      throw new CheckrApiError("Checkr candidate creation requires an email.");
    }
    const candidateBody: Record<string, unknown> = {
      first_name: args.firstName,
      last_name:  args.lastName,
      email:      args.email,
      ...(args.zipCode ? { zipcode: args.zipCode } : {}),
      ...(args.customId ? { custom_id: args.customId } : {}),
      // Do NOT send no_middle_name — locks the field on the Checkr invitation form (official guide p.10)
    };
    if (workLocations.length) candidateBody.work_locations = workLocations;

    const candidate = await checkrPost("/candidates", candidateBody, `${idBase}-candidate-${dateKey}`);
    candidateId = candidate?.id as string | undefined;
    if (!candidateId) {
      throw new CheckrApiError("Checkr candidate created without an id.");
    }
  }

  const invitationBody: Record<string, unknown> = {
    candidate_id: candidateId,
    package:      args.packageSlug,
  };
  if (workLocations.length) invitationBody.work_locations = workLocations;

  const invitation = await checkrPost("/invitations", invitationBody, `${idBase}-invitation-${dateKey}`);
  const invitationUrl = invitation?.invitation_url as string | undefined;
  if (!invitationUrl) {
    throw new CheckrApiError("Checkr invitation created without invitation_url.");
  }
  return { invitationUrl, candidateId };
}
