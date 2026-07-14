---
name: draft-care-update
description: "Draft a fresh natural-language update for the family about how their senior is doing, drawing on recent care journal entries, completed visits, and any flagged health signals. Trigger when the family asks how their loved one is doing in any form (\"how is mom\", \"how's dad been\", \"any news on grandma\", \"what's the latest on mom's care\", \"how did this week go\"), or asks for a recap of recent visits, or asks for a wellness snapshot. Do NOT trigger when the family is asking about scheduling, billing, or a specific caregiver."
---

# Drafting a Care Update

When the family asks how their senior is doing, compose **one warm-but-clinical paragraph** (3-5 sentences) drawn from real data. Do not invent details.

## Inputs you should look up FIRST (in this order)

1. `get_care_journal` — last 7-14 entries. The journal is the primary source of truth for day-to-day observations.
2. `get_upcoming_appointments` and the recent completed visits in the care team data — to confirm continuity (or surface gaps).
3. `get_health_signals` — only if the journal hints at a pattern worth flagging (3+ entries with low appetite, repeated mood dips, missed meds).

Do not call `task / journal_summarizer` here — you have the data, and the family wants Evia's voice, not a separate sub-agent's.

## Drafting rules

- **Lead with the trend, not the dates.** "Mom's been more talkative this week" beats "On 5/24 mom was talkative."
- **Pick one concrete moment** from the most recent entry — a specific food eaten, a comment made, an activity enjoyed. Names of caregivers belong here when relevant.
- **Surface concerns plainly.** If the journal shows three+ consecutive days of low appetite or mood dips, name it: "Worth flagging — appetite has been low three days running." Don't bury it in caveats.
- **Close with what's next** — the next scheduled visit, or an offer ("want me to check in with [caregiver] before Thursday's visit?").
- **Never invent.** If the journal is empty or stale, say so plainly: "No entries since Tuesday — let me ping the caregiver."

## Tone

Warm but not saccharine. The family is an adult getting a care report, not a child being reassured. Match the voice mirror's signals — if they've been terse, be terse back.

## Anti-patterns

- Bullet points or headers (this is SMS — one paragraph).
- "Mom is doing well!" with no specifics — meaningless to a family that worries.
- Listing every entry chronologically — the family wants the takeaway, not the log.
- Hedging language ("might be," "seems like") when the journal is concrete. Trust the data.

## Example output shape

> Mom's had a steady week — Maria's notes show she's been eating better since Monday and was in good spirits at yesterday's visit (she asked about the grandkids again). One thing to keep an eye on: she skipped meds Tuesday morning, though Wednesday and today were fine. Next visit is Thursday at 10am — want me to give Maria a heads-up to double-check the morning meds?
