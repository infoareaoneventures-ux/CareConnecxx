# Childcare first-smoke — 20-minute scripted pass (founder-run)

Childcare went functionally live 2026-07-29. **No real person has ever completed
a childcare signup.** This is the scripted pass that proves the funnels work
before marketing sends anyone in. Use a **fresh phone number** (or reset one:
`node scripts/delete-phone.mjs <phone> --confirm`).

Rollback at any point:
`node scripts/seed-childcare-flags.mjs --emergency-off --apply --project=careconnex-d4c8b`
(flags cache 60s — allow a minute).

## Pass 1 — childcare FAMILY (SMS)

| # | Text this | Expect | Red flag |
|---|-----------|--------|----------|
| 1 | `Hi, I need a babysitter for my 2 kids` | Childcare-classified reply — asks about childcare, NOT "who is the senior" | Any senior framing (mom/dad/senior questions) |
| 2 | Answer its questions | It does NOT collect child names/ages/details over SMS — it should push you to the secure web link for child profiles | It asks for child details in the SMS thread |
| 3 | Open the link it sends | Web signup with childcare framing; child profile form is on the web, not SMS | Link 404s, or lands on senior signup |
| 4 | Complete signup + membership payment | $29.95/mo checkout succeeds | `pricing_unset` error, wrong price, or checkout failure |
| 5 | After payment | Job post / matching proceeds; check `job_posts` doc has `careVertical:"child"` | Doc missing the vertical stamp, or senior-shaped fields |

## Pass 2 — childcare CAREGIVER (SMS)

| # | Text this | Expect | Red flag |
|---|-----------|--------|----------|
| 1 | `I'm a babysitter looking for childcare jobs` | Caregiver+childcare classified; asks childcare questions (age groups, childcare experience) | Senior-caregiver questions (dementia, CNA) |
| 2 | Complete the funnel (~13 asks for a new caregiver) | Includes adult-age attestation and transport question | Skips the age attestation |
| 3 | Ask: `am I approved for childcare jobs?` | Explicit answer from live status ("not yet discoverable" until screening clears) | Vague/invented answer, or senior background-check talk |
| 4 | Membership + background check | $54.99/yr; shared Checkr package invite arrives | Wrong price; no Checkr invite |

## Pass 3 — senior regression (2 minutes, existing test number)

| # | Text this | Expect |
|---|-----------|--------|
| 1 | `My mom needs help with bathing` | Senior flow, exactly as before — NO "adult or kids?" question (keywords resolve it) |
| 2 | Any mid-flow question | Normal senior behavior; no childcare framing anywhere |

## After the pass

- Check `admin_alerts` for `type == "childcare_canary"` rows — any red signal sets
  the rollout hold.
- If anything failed: emergency-off (above), then send me the transcript — the
  conversation rows + session doc are enough to diagnose.
- If all green: this file's job is done; record the date here → **first clean
  smoke: ____**

## Known-open (not tested by this pass)

- `incidentContacts` is still empty — an injury report classifies correctly but
  pages nobody. Fill via `docs/runbooks/childcare-ca-approvals.template.json`.
- Proactive outbound childcare SMS is OFF by design.
- Governance refs (counsel/insurance/consents) unpopulated — runtime-irrelevant,
  checklist reports it, founder owes the values.
- Verify Checkr dashboard webhook URL points at `v1-checkrWebhook` (the
  unprefixed stale copy 500s).
