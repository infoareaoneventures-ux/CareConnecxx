import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the EXACT request shape Checkr requires — candidate first (with email),
// then invitation carrying candidate_id. The 2026-07-07 launch blocker was an
// invitation POST with only {package, first_name, last_name}: Checkr rejected
// every one, and no test noticed because the old tests mocked the HTTP
// *response* and never inspected the *request*.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("./utils/httpTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => fetchMock(...a) }));

import { createCheckrInvitation, CheckrApiError } from "./checkrApi";

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function sentBody(callIndex: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as { body: string };
  return JSON.parse(init.body);
}
function sentUrl(callIndex: number): string {
  return fetchMock.mock.calls[callIndex][0] as string;
}

beforeEach(() => {
  fetchMock.mockReset();
  process.env.CHECKR_KEY = "test_checkr_key";
  delete process.env.CHECKR_API_URL;
});

describe("createCheckrInvitation — candidate-first contract", () => {
  it("creates the candidate (with email, zipcode, work_locations) THEN the invitation with candidate_id", async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ id: "cand_123" }))
      .mockResolvedValueOnce(okJson({ invitation_url: "https://apply.checkr.com/invite/abc" }));

    const result = await createCheckrInvitation({
      firstName:   "Jane",
      lastName:    "Doe",
      email:       "jane@x.com",
      zipCode:     "95112",
      workState:   "CA",
      workCity:    "San Jose",
      packageSlug: "checkrdirect_essential_criminal",
    });

    expect(result).toEqual({ invitationUrl: "https://apply.checkr.com/invite/abc", candidateId: "cand_123" });

    expect(sentUrl(0)).toBe("https://api.checkr.com/v1/candidates");
    expect(sentBody(0)).toEqual({
      first_name: "Jane",
      last_name:  "Doe",
      email:      "jane@x.com",
      zipcode:    "95112",
      work_locations: [{ country: "US", state: "CA", city: "San Jose" }],
    });

    expect(sentUrl(1)).toBe("https://api.checkr.com/v1/invitations");
    expect(sentBody(1)).toEqual({
      candidate_id: "cand_123",
      package:      "checkrdirect_essential_criminal",
      work_locations: [{ country: "US", state: "CA", city: "San Jose" }],
    });
  });

  it("reuses an existing candidate (renewals): skips /candidates entirely", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ invitation_url: "https://apply.checkr.com/invite/renew" }));

    const result = await createCheckrInvitation({
      firstName:   "Jane",
      lastName:    "Doe",
      email:       "jane@x.com",
      candidateId: "cand_existing",
      workState:   "CA",
      packageSlug: "checkrdirect_essential_criminal",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl(0)).toBe("https://api.checkr.com/v1/invitations");
    expect(sentBody(0)).toMatchObject({ candidate_id: "cand_existing" });
    expect(result.candidateId).toBe("cand_existing");
  });

  it("fails loudly (no HTTP call) when a new candidate is needed but email is missing", async () => {
    await expect(createCheckrInvitation({
      firstName:   "Jane",
      lastName:    "Doe",
      email:       "",
      workState:   "CA",
      packageSlug: "checkrdirect_essential_criminal",
    })).rejects.toThrow(CheckrApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the invitation response carries no invitation_url", async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ id: "cand_123" }))
      .mockResolvedValueOnce(okJson({}));

    await expect(createCheckrInvitation({
      firstName: "Jane", lastName: "Doe", email: "jane@x.com",
      packageSlug: "checkrdirect_essential_criminal",
    })).rejects.toThrow(/invitation_url/);
  });

  it("throws CheckrApiError with the HTTP status on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad request", json: async () => ({}) });

    await expect(createCheckrInvitation({
      firstName: "Jane", lastName: "Doe", email: "jane@x.com",
      packageSlug: "checkrdirect_essential_criminal",
    })).rejects.toMatchObject({ name: "CheckrApiError", status: 400 });
  });
});
