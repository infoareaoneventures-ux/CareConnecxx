# Evia — Security & Privacy Posture (current state)

> Rewritten 2026-10-07 from an aspirational HIPAA checklist (every box unchecked, and it documented
> field-level PII encryption that had been removed) into a statement of what IS and IS NOT in place.
> Update this file when a line changes. Nothing here is a compliance claim.

## The open question (counsel)
HIPAA binds covered entities and their business associates. Evia is a **non-medical** care
marketplace: it does not provide medical care and does not collect medical records, medication
lists or diagnoses (forms decline them since 2026-10-04). Whether HIPAA applies at all is a legal
determination that has not been made. Until it is, the product makes **no** HIPAA claim anywhere
(site pages, Evia's answers, marketing) — see the 2026-10-07 claim removal in the progress tracker.

## In place (verified in code, 2026-10-07)
- **Access control:** Firestore rules scope care plans and senior profiles to the owning family + admins; caregiver identity PII sits in a private subcollection no client can write; admin is a server-checked role (`users.userType == 'admin'`).
- **Audit trail:** health-data reads, profile changes, messages and bookings are written to `agent_audit_log` with a 6-year TTL (`functions/src/observability/auditLog.ts`).
- **Minimum necessary:** medications / dosages / diagnoses / conditions are refused at every free-text save on both channels (`utils/medicationInstruction.ts` + the shared Evia rule); emergency contacts and door codes are fetched on demand, never pre-loaded into Evia's prompt; a caregiver never sees a family's address or phone before a confirmed booking.
- **Encryption:** Google Cloud default encryption at rest and TLS in transit for Firestore, Functions, Storage. (No application-level / field-level encryption — the former CryptoJS helpers were removed; `utils/encryption.ts` only masks for display.)
- **Deletion:** a full account-deletion path (`deleteAccountForUser`) and TTLs on operational collections.
- **Error reporting:** Sentry masks all replay text and strips tokens from URLs.
- **Log hygiene (2026-10-07):** function logs redact phone numbers and emails at the console layer (`functions/src/observability/logRedaction.ts`); the Checkr client no longer prints any part of the API key.
- **Background checks:** SSN / DOB are entered on Checkr's hosted site, never stored by Evia; consent (FCRA disclosure + authorization) precedes every Checkr call.

## NOT in place
- **Business Associate Agreements: none signed.** Vendors in the data path: Google Cloud / Firebase, OpenAI (agent tier), Gemini and Anthropic (fallbacks), Zep (Evia memory), Linq (SMS), Resend (email), Sentry, Stripe (payments — no health data), Checkr (background checks — no health data). OpenAI's API BAA covers zero-data-retention endpoints only; our calls are not configured for ZDR.
- **SMS is an unencrypted channel.** Care details travel by text; under HIPAA that requires documented consent and minimum-necessary content.
- **No HIPAA program:** no risk assessment, no written policies, no breach-notification procedure (60-day rule), no training records, no access reviews, no named privacy/security officer.
- **Admin MFA:** built 2026-10-07 behind `VITE_REQUIRE_ADMIN_MFA` — requires Identity Platform + the TOTP provider enabled in the Firebase console before it can be turned on.
- **Field-level encryption:** none (platform encryption only). A risk assessment would say whether care plans warrant more.

## Vendor BAA requests
Templates: `BAA_REQUEST_TEMPLATES.md` (Google Cloud, Twilio, Stripe, Checkr). Add OpenAI (baa@openai.com — ZDR endpoints), Anthropic, Google (Gemini), Zep, Linq, Resend, Sentry if counsel decides HIPAA applies.

## Related records
- `AGENT_NATIVE_EXCLUSIONS.md` — what Evia's prompt carries and the provider decision record.
- `PRIVACY_POLICY.md`, `TERMS_OF_SERVICE.md` — DRAFTS carrying a STATUS banner; the live pages are `components/pages/PrivacyPolicyPage.tsx` and `TermsOfServicePage.tsx`.
