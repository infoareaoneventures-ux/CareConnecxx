---
name: explain-bill
description: "Walk a family member through a recent charge or invoice in plain language — what they were billed for, why each line item is on there, and what (if anything) they should do about it. Trigger when the family asks about a charge (\"what was the $X charge for\", \"why is my bill so high this month\", \"can you explain this invoice\", \"what's this for on my card\", \"did I get charged twice\"), or asks for a breakdown of a specific invoice, or expresses surprise/confusion about an amount. Do NOT trigger when the family is asking to update payment method, request a refund, or download a tax summary — those are different flows."
---

# Explaining a Bill

When the family asks about a charge, they want the answer in **one short paragraph** (not a line-item table). Pull the invoice, name the charge in plain language, and offer the next step.

## Inputs you should look up FIRST

1. `get_invoice_history` — last 3-5 invoices. Pick the one the family is asking about (most recent if they don't specify; match the dollar amount if they mention one).
2. `get_invoice_details` on that invoice — to see the line items.
3. Only call `get_billing_summary` if the family asks about the SUBSCRIPTION amount specifically (the monthly $29.95 or the caregiver $54.99 annual — legacy caregiver subscriptions from before 2026-07-14 bill $66.49).

## Explaining rules

- **Lead with the amount + period.** "The $X charge from [date] covers..."
- **Name line items in care-language**, not billing-language. "Three care visits and the monthly platform fee" beats "Subscription + 3x service line items."
- **Explain anything non-obvious** — a prorated month, an extra-hour shift, a recurring monthly fee they may have forgotten.
- **Confirm nothing's wrong** before offering action. Most "why was I charged?" turns are just a memory gap, not a dispute.
- **If the family says it's wrong**, do NOT auto-file a refund — confirm the specific line item that's wrong first, then offer to file a refund request through the regular flow.

## Tone

Matter-of-fact. The family is anxious about an unexpected number — confidence calms them more than apology.

## Anti-patterns

- Line-item tables in SMS (won't render).
- "I see you were charged $X" — they know they were charged. Tell them what FOR.
- Hedging on what the charge was when the invoice is right there. Read it and say it.
- Filing a refund without explicit confirmation.

## Example output shape

> The $267 charge from May 24 covers three care visits that week (May 19, 21, and 23 — eight hours total at $32/hr) plus the monthly platform fee. Nothing unusual — those are the same three visits Maria did. Want me to pull up the visit notes, or is something off about one of them?
