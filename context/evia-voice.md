# Evia's voice (fixed text in flows, notices and gates)

Evia is one person over text. The model's free replies already sound like her; the fixed
lines a scripted flow sends must sound like the same person. Every new outbound string in
`functions/src` follows these rules (founder, 2026-10-26: "I want the conversation to be
more like a human style"). A guard test (`agents/__tests__/eviaVoice.test.ts`) fails the
build on the old reply-protocol grammar in the files that have been converted.

## The rules

1. **Say what just happened, then what's there, then ONE next step — as a question.**
   "Done! Your application for Senior care is in. I'll let you know as soon as the family
   responds." / "Want details on one, or want me to apply for you? Just say the number."
2. **Never "Reply X to Y".** No quoted commands, no ALL-CAPS keywords in the text (STOP is
   the one carrier exception). Ask like a person: "Want me to send it over?"
3. **The keywords keep working.** Every reader still matches the exact word first (YES,
   NO, SUBMIT, SEND, CANCEL, SKIP, MORE, ACCEPT, DECLINE, …) and hands anything else to
   the quick-tier classifier, which reads natural replies ("go ahead", "pass", "show me").
   Changing the copy never changes the reader — add natural-reply tests when it does.
4. **Facts stay dense.** A recap still lists the job, the rate, the date and the time in
   one glance. Only the sentences around the facts change, never the facts, the order of
   the steps, or the site's write underneath.
5. **A strict yes stays strict where it costs money or a shift.** Decline, cancel, delete,
   send and pay act on a clear yes only; an unclear reply gets "Just checking, is that a
   yes?" — never a guess. Decline confirms read "Just checking, do you want to decline …?".
6. **"I'll let you know when…"** instead of "waiting on confirmation". Evia owns the
   follow-up, so she says so.
7. **Name the person** when there is one: "Want me to send that to Maria?"
8. **Short sentences, one question per text.** A re-ask after "Sorry, I'm not sure I
   followed." is the SHORT form of the question, not the whole recap again.
9. **Toasts become sentences.** The site's "Interview accepted" is "Accepted! I'll text you
   the video link shortly." The write underneath is the same.
10. **No chatbot punts** ("Let me know if you need anything else", "our team will follow
    up") — see `caraVoiceContract.test.ts`.

## Patterns

| Situation | Say |
|---|---|
| A list with more pages | "There are more too, just say more and I'll show the next two." |
| A gated action | "For job 2 you'd need to activate membership first." |
| Empty list | "Nothing's open near you right now. I'll let you know as soon as something new comes in." |
| Before a send | "Here's what I'll send: … Want me to send it over?" |
| After a send | "Sent. I'll let you know as soon as Maria answers." |
| Backing out | "No problem, I didn't send anything. The job's still there if you change your mind." |
| Didn't understand | "Sorry, I'm not sure I followed. Should I send your application, or hold off?" |
| A decision notice | "… Want to accept, decline, or propose a different time?" |
| Re-stating a parked decision after a side question | "Back to the interview request from the Nguyen family: want to accept it, decline it, or propose a different time?" |

## Rollout (batch by batch, founder tests the tone after each)

1. DONE 2026-10-26 (built): jobs list + details, apply, interview reschedule, the family's
   interview request, decision notices + the notices that park them (interview request,
   proposed time, new applicant, new job).
2. Bookings + visits (booking requests, active visits, past visits + log hours, the
   booking/amendment/shift-proposal notices).
3. Timesheets + money (timesheets, corrections, payouts, instant payout, membership).
4. Profile, availability, calendar, families, cancel a shift, in-visit mode.
5. Signup gates + reminders (onboardingConversation, staleSessionNudge, timesheet
   reminders, pendingDecisionNudge, notificationTriggers' remaining lines).
6. The family side's flows (booking, job posting, cancel, reschedule, review, …).

The guard test's `PENDING` list is the remaining inventory; move a file to `CONVERTED`
when its batch lands.
