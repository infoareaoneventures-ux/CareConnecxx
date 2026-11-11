# Evia: All Open Issues

**Updated:** November 7, 2026
**Covers:** the full codebase review (Nov 3), the AI and UI reviews (Nov 4), and live end-to-end testing on Nov 7 (family and care provider on the website, against the live backend).

The Notion doc "Evia: Codebase Review & Improvement Plan" has the same items with screenshots. Every item here is also in Notion (as of Nov 7).

**Status labels**
- Ticked: fixed in code (see the label for whether it's deployed).
- No label: open.
- _Committed fix, not yet deployed_: fixed in code on `dev`, not live yet.
- _Found in live testing, Nov 7_: found on Nov 7.

---

## 1. Code & infrastructure

### P0: Urgent

- [x] **Account-change requests can be viewed by anyone** — _Done in code (13a3bb00), not yet deployed_
    - **The issue:** When a user changes their phone number or email, or asks to delete their account, the app stores a short-lived "request" record. Our database rules let anyone on the internet list all of these records, even without logging in.
    - **Why it matters:** These records can include email addresses, phone numbers and one-time verification codes. Someone could use them to view personal information or attempt to take over an account.
    - **How we'll fix it:** Change the rule so that only someone who already knows a specific request's secret ID can open that one request, and nobody can browse the full list. We'll add an automated test that confirms the list stays locked.

- [x] **Families' job posts are visible to every logged-in user** — _Done in code (13a3bb00), not yet deployed. Live check Nov 7: new posts store only the ZIP-level location_
    - **The issue:** Any signed-in user can read every family's job posting, and those postings include the family's street address and ZIP code.
    - **Why it matters:** A family's home address is sensitive, especially when it is tied to an elderly or vulnerable person. It should only go to the people who need it.
    - **How we'll fix it:** Limit full job posts to the family who wrote them and to admins. Caregivers will see a public version that leaves out the exact address until a booking is confirmed.

- [x] **Some backend code is not fully checked before release** — _Done in code (13a3bb00), not yet deployed_
    - **The issue:** The automatic checks that run on every change verify the website's code, but they skip a key error check on the backend: the part that sends texts, takes payments and runs background checks.
    - **Why it matters:** A simple mistake in the backend could reach live users without being caught first. Those mistakes could affect payments or messages.
    - **How we'll fix it:** Add the missing backend check to the automatic checks, so a change with errors cannot be released.

- [x] **New-job texts reach care providers far outside their area** — _Found in live testing, Nov 7_
    - **The issue:** When a family posts a job, `onJobPostCreatedNotifyCaregivers` texts every care provider with a finished profile in range. A provider with no travel radius gets radius 0, and `withinCaregiverRadius` (`functions/src/agents/jobBoardPage.ts`) treats 0 (or a missing location) as "no limit". So that provider is texted about every job anywhere. The notice also doesn't check that the provider is approved or has an active membership, unlike the family-side search. Live: two test posts in Gilroy each texted a real provider in Santa Clara (about 30 miles away).
    - **Why it matters:** Care providers get texts for jobs they can't take, and providers who aren't cleared for families are told about families' jobs.
    - **How we'll fix it:** Treat a missing radius as a sensible default (for example 10 miles) and a missing location as out of range. Only notify providers who pass `isCaregiverBookable`. Add tests. (For testing, a 10-mile radius was added to that provider's record on Nov 7.)
    - **Done (Nov 9):** A text now needs the provider to have a location AND a travel distance above zero, a job with coordinates, and a bookable provider (background check approved, membership active, not paused/opted out). The job board's own rule is unchanged. The website bell is written even when no text goes out. Tests in newJobNotice.test.ts. Behaviour change to note: unpaid or not-yet-approved providers are no longer told about new jobs.

- [ ] **Anyone who knows a fixed code can sign in as the support line**
    - **The issue:** The public support number on the website, (650) 563-3842, is also set up in Firebase as a "test" phone number. It always accepts the same code and never sends a text. A second test number, +1 408-637-0483, works the same way.
    - **Why it matters:** Anyone who learns the code can sign in as whatever account uses that number, without having the phone.
    - **How we'll fix it:** Remove both numbers from Firebase's test list, and only use made-up numbers for testing. (Kept for now while testing continues; to be cleaned up after the fixes.)


### P1: High

- [ ] **Running the app on a developer's computer connects to live data by default**
    - **The issue:** Every setting points at the live (production) system. There is no built-in "practice mode" for developers.
    - **Why it matters:** A developer testing a feature could accidentally change real customer records, send real text messages, charge a real card, or order a real background check.
    - **How we'll fix it:** Set up a local "sandbox" that imitates the whole system on the developer's own computer with fake data, and make it the default. Nothing in it can reach real customers.

- [x] **Maintenance scripts can change live data without a safety prompt**
    - **The issue:** About 30 one-off maintenance scripts can edit or delete live data, and several do it immediately with no confirmation step.
    - **Why it matters:** One wrong command could change or erase real customer records.
    - **How we'll fix it:** Every script that touches live data will require an explicit "yes, this is live" flag and will offer a preview mode first. Scripts that are no longer needed will be removed.
    - **Done (Nov 9):** The 5 scripts that wrote live data with no guard (cleanup-user-data, fix-missing-user, seed-admin, runMigration, seed-test-caregivers seed/cleanup) now refuse to run without --live. The others already default to a preview and need --apply/--confirm/--execute. Removing scripts that are no longer needed is left for the clean-up wave.

- [x] **AI coding tools are pre-approved to publish to the live site**
    - **The issue:** A shared settings file lets AI coding assistants publish changes to the live system without asking a person first.
    - **Why it matters:** Changes could go live without anyone reviewing them.
    - **How we'll fix it:** Remove that file from the shared project so publishing to the live site always needs a person's approval.
    - **Done (Nov 9):** Removed every deploy permission (npx firebase *, npm run *, the two explicit deploy commands) from the tracked .claude/settings.local.json. Deploys now need a person's approval.

- [ ] **Releasing to the live site is a single command with no safety checks**
    - **The issue:** One command builds the app and publishes it straight to the live site.
    - **Why it matters:** It is easy to publish something by accident or before it is ready.
    - **How we'll fix it:** Require an explicit choice of target ("test" or "live") and a confirmation step, and remove the old duplicate release script.
    - **Partly done (Nov 9):** npm run deploy now needs a person at a terminal to type the project id and refuses to run otherwise. There is no separate test project, so there is no test target. The old duplicate script scripts/deploy.sh (it only builds) is still there; delete it when convenient.

- [ ] **No consistent code-quality rules**
    - **The issue:** The project has no automatic style or quality checker, so every developer writes code in their own way.
    - **Why it matters:** Bugs slip through more often, new developers take longer to get productive, and code reviews take longer.
    - **How we'll fix it:** Add standard automatic checkers that run every time code is saved and on every change, and fix what they find, starting with the most important areas.

- [ ] **Errors are often silently ignored**
    - **The issue:** In over 100 places, when something fails (for example, loading a page section or saving data), the app quietly ignores the error. Our error-tracking service (Sentry) only hears about a small fraction of problems.
    - **Why it matters:** Users can hit a broken screen or a save that didn't work, and nobody on the team ever finds out.
    - **How we'll fix it:** Add one standard way of handling errors that tells the user something went wrong and reports it to our error-tracking dashboard.

- [ ] **Screens talk to the database directly**
    - **The issue:** Many screens read and write the database on their own instead of going through one shared layer. Some of this data is saved without being cleaned first.
    - **Why it matters:** Rules such as "always clean user input" are applied inconsistently, the same logic is copied in many places, and changes are harder and riskier.
    - **How we'll fix it:** Gradually move database access into one organized layer, grouped by area (caregivers, bookings, payments, admin). An automated check will stop new screens from bypassing it.

- [ ] **The app does extra work every time something changes**
    - **The issue:** One central piece of the app causes about 40 screens to redraw whenever a small notification pops up. It also loads some data twice, and loads a caregiver list that is never shown.
    - **Why it matters:** The app is slower than it needs to be, especially on older phones, and it makes extra database reads that add to running costs.
    - **How we'll fix it:** Split that piece into smaller parts so only the affected screens update, and remove the duplicate and unused data loading.

- [ ] **The site's Stripe keys don't match: the page uses a test key, payments are live** — _Corrected Nov 7 (earlier note said "test mode")_
    - **The issue:** The website loads a test-mode Stripe publishable key (`pk_test_…`), but the backend creates **live** Checkout sessions (`cs_live_…`). Confirmed Nov 7: "Select a plan" from the local site, against the live backend, opened a live Stripe checkout for the test family.
    - **Why it matters:** Membership payments are real, so the earlier assumption that the site is in test mode is wrong. Anything on the page that uses the publishable key (Stripe Elements, card setup) would talk to the test account while the backend charges in live mode, so those flows break or disagree. Developers testing against the live backend can create real charges.
    - **How we'll fix it:** Pair the keys per environment (test page key with test secret key, live with live), check at start-up that the modes match, and test payments only in the sandbox with test keys.

- [ ] **Testing on a developer's computer still texts real people**
    - **The issue:** The local app uses the live backend, which sends texts, emails and alerts. During testing, two test job posts each texted the same real care provider (see "New-job texts reach care providers far outside their area" below for why).
    - **Why it matters:** Testing posting, messaging, booking or visits can reach real families and care providers.
    - **How we'll fix it:** Test those flows only in the sandbox (see the item above). Until then, keep test accounts outside the service area so no real person is matched.

- [~] **Text-message delivery receipts are thrown away** — _Found in live testing, Nov 7_
    - **The issue:** In the production logs, the Linq webhook rejects "message.sent" and "message.delivered" events with "linqWebhook: invalid signature — ignoring".
    - **Why it matters:** Evia can't tell whether a text reached the person, and any feature that relies on delivery status is blind. If incoming messages ever hit the same check, they would be dropped too.
    - **How we'll fix it:** Check the webhook signing secret in the functions env against the one in Linq, and how the signature is computed for these event types. Alert when signatures fail.
    - **Partly done (Nov 9):** Hardened, root cause NOT confirmed (needs Linq's dashboard / the logs): the check now accepts more than one signing secret (LINQ_WEBHOOK_SECRET_2, LINQ_WEBHOOK_SECRETS), a 'sha256='/'v1=' prefix and comma-separated signatures, still fail-closed; the log now names the failing event type; and a failure raises one high-severity ops alert per event kind per hour. Still to do outside the code: compare the secret on the message.sent / message.delivered subscription in Linq with the functions env and set LINQ_WEBHOOK_SECRET_2 if it differs.


- [ ] **Some notices are only sent if a text goes out** — _Found in live testing, Nov 7_
    - **The issue:** In `newJobNotice.ts` the in-app bell notice is written only after the text is sent. A care provider without an Evia text session gets neither a text nor a bell for a new job near them. During testing, the test care provider also got no bell for the family's interview request, the family's message, or the booking request, and the family got no bell for the care provider's reply.
    - **Why it matters:** Care providers who use only the website miss jobs, interviews and bookings.
    - **How we'll fix it:** Write the bell notice for every eligible recipient, whether or not the text goes. Check every "new X" event (interview request, booking request, new message) writes a bell for the other side.

### P2: Medium (design, usability & accessibility)

- [ ] **One central theme for colors, fonts and styles**
    - **The issue:** Colors are typed directly into each screen. Over 9,000 color settings are scattered across the app, and only about a quarter use the official brand colors.
    - **Why it matters:** Changing a brand color today means editing hundreds of files, and some screens look slightly off-brand.
    - **How we'll fix it:** Create one theme file that defines every brand color, font, corner style and shadow, then update every screen to use it. Afterwards, changing a color in that one file updates the whole app. The first pass will look exactly the same as today; visual changes come only after you approve them.

- [ ] **The brand font isn't showing**
    - **The issue:** Because of a small setup error, the app downloads the brand font (Plus Jakarta Sans) but never uses it. It shows the device's default font instead. A third font is also loaded and never used.
    - **Why it matters:** The app doesn't look the way it was designed, and it loads files it doesn't need.
    - **How we'll fix it:** Correct the setting so the brand font appears everywhere, and remove the unused font.

- [ ] **A shared library of building blocks (buttons, forms, pop-ups)**
    - **The issue:** The app has a small set of shared buttons and inputs, but most screens build their own. There are about 980 hand-made buttons and about 40 separately built pop-up windows.
    - **Why it matters:** Buttons, forms and pop-ups look and behave slightly differently from screen to screen, and every fix has to be repeated in many places.
    - **How we'll fix it:** Build a complete set of shared building blocks (buttons, form fields, cards, pop-ups, status labels, loading placeholders, empty-page messages) and switch every screen over to them. We'll also add an internal preview page where they can all be reviewed at once.

- [ ] **Pop-up windows don't work well with keyboards or screen readers**
    - **The issue:** Pop-up windows can't be closed with the Escape key, keyboard focus can escape behind them, and screen readers don't announce them as pop-ups.
    - **Why it matters:** This makes the app hard to use for people with disabilities and for keyboard users. Accessibility is also a legal expectation for consumer health services.
    - **How we'll fix it:** One shared pop-up component, built to accessibility standards, used everywhere.

- [ ] **Buttons without labels for screen readers**
    - **The issue:** About 84 icon-only buttons (such as an "X" to close or an arrow for "next week") have no text description. About 33 clickable areas aren't real buttons.
    - **Why it matters:** Blind and low-vision users can't tell what these buttons do, and keyboard users can't reach some of them.
    - **How we'll fix it:** Add descriptions to every icon button, turn clickable areas into proper buttons, and add a check that prevents unlabeled buttons in future.

- [ ] **Inconsistent loading, empty and error screens**
    - **The issue:** Some screens show a spinning icon while loading, some show placeholder shapes, and some show nothing. When a list is empty or something fails, the message varies by screen or is missing.
    - **Why it matters:** Users can't always tell whether the app is working, has nothing to show, or is broken.
    - **How we'll fix it:** Use one standard set of loading placeholders, "nothing here yet" messages, and error messages with a "try again" option.

- [ ] **Dates, times and prices are shown inconsistently**
    - **The issue:** Each screen formats dates, times, money and phone numbers in its own way, with over 300 separate formatting snippets.
    - **Why it matters:** The same price or date can look different on two screens, which looks unpolished and can confuse families reviewing bills.
    - **How we'll fix it:** One shared set of formatting tools used by every screen.


### P3: Low (clean-up & maintainability)

- [ ] **Very large screen files**
    - **The issue:** 20 screens are each more than 800 lines of code, and the largest is about 2,800.
    - **Why it matters:** Large files are slow and risky to change, and that slows down new features.
    - **How we'll fix it:** Break the largest screens into smaller, focused pieces, a few at a time.

- [ ] **Two near-identical calendars**
    - **The issue:** The family calendar and the caregiver calendar are almost copies of each other.
    - **Why it matters:** Every calendar fix has to be made twice, and the two drift apart over time.
    - **How we'll fix it:** Merge them into one shared calendar that both sides use.

- [ ] **Leftover and unused code**
    - **The issue:** About 12 files, one large unused library, two large unused images (1.5 MB) and several old project files are no longer used.
    - **Why it matters:** They add clutter, confuse new developers and slow down installs.
    - **How we'll fix it:** Remove everything that is confirmed unused.

- [ ] **More automated tests for screens and key journeys**
    - **The issue:** The backend is well tested, but only a handful of the website's screens have automated tests, and the full sign-up and booking journeys aren't tested automatically.
    - **Why it matters:** Problems in key journeys (sign-up, booking, payment) may only be found by users.
    - **How we'll fix it:** Add automated tests for the most important screens, and end-to-end tests for sign-up, job posting, booking and payment, all running in the sandbox from P1.

- [ ] **Faster loading**
    - **The issue:** The app loads two versions of the same database toolkit, which makes the download heavier than it needs to be.
    - **Why it matters:** First load is slower, especially on mobile data.
    - **How we'll fix it:** Switch to the modern, lighter version of the toolkit, and add a size limit that warns us if the app gets too heavy.

- [ ] **Page titles and search previews**
    - **The issue:** Every page in the app has the same browser tab title and the same link preview.
    - **Why it matters:** This hurts search visibility and makes shared links and open tabs harder to tell apart.
    - **How we'll fix it:** Give each page its own title and description.

- [ ] **Developer setup: local testing can't sign in** — _Partly done Nov 7: test phone numbers added, localhost allowed, `vite.config.ts` pre-bundles every dependency (uncommitted). Sandbox still to do_
    - **The issue:** Firebase rejected sign-ins from a developer's computer (`auth/invalid-app-credential`), and the local server sometimes loads two copies of React after re-bundling a library, which shows a blank page.
    - **Why it matters:** Developers can't test the logged-in app safely on their own machines, which pushes testing onto the live site.
    - **How we'll fix it:** Test phone numbers in Firebase (done for testing), pre-bundle every dependency at start-up (`optimizeDeps.entries` in `vite.config.ts`, done locally, uncommitted), and move local testing to the sandbox in the code plan.

- [ ] **The docs disagree with the product about the bio minimum** — _Found in live testing, Nov 7_
    - **The issue:** CLAUDE.md says the care provider bio needs at least 150 characters with no skip. On the site, a 2-character bio was accepted.
    - **Why it matters:** Either the rule is missing or the docs are wrong, and the team builds on the docs.
    - **How we'll fix it:** Confirm the intended rule with the founder, then fix whichever side is wrong.


---

## 2. AI (Evia)

### P0: Urgent (user safety)

- [x] **Emergency messages are missed in several situations**
    - **The issue:** Evia has a fast safety check that spots emergencies ("my mom isn't breathing") and replies straight away with 911 or 988 guidance. That check only runs late in the conversation flow. Before it runs, Evia may already have replied with something else in these cases:
        - a brand-new texter
        - someone answering the opt-in question
        - someone with an unfinished sign-up
        - an expired conversation
        - a conversation an admin has taken over
        - a message that is only a photo
    - **Why it matters:** A person in an emergency could get "Reply resume to continue your sign-up" instead of "Call 911."
    - **How we'll fix it:** Run the emergency check first, before any other reply, for every incoming message. Add an automated test that keeps it first.
    - **Done (Nov 9):** The emergency check now runs from every entry point: a first-ever text from a number with no session, the cold consent reply, and the web-signup consent reply (it used to sit after those). A number that opted out (STOP) still gets nothing. A number with no session gets the 911 text and a critical support alert, not a stored session. Tests in handleInbound.routing.test.ts. The other items listed under this issue were not part of this change.

- [x] **Everyday emergency wording isn't recognised** — _Done in code (8308ed73), not yet deployed_
    - **The issue:** The emergency check looks for exact phrases. iPhones type a curly apostrophe (’) by default, and the check doesn't treat it like a normal one. In our test, all of these were missed:
        - "I can’t breathe"
        - "my dad won’t wake up"
        - "I don’t want to be here anymore"
        - "thinking about suicide"
        - "she fell in the bathroom"
        - "he is bleeding a lot"
        - "i cant breathe" (no apostrophe)
    - **Why it matters:** Most English-speaking iPhone users describing an emergency would get no emergency response and no alert to the team.
    - **How we'll fix it:**
        - Treat curly and straight apostrophes the same, and also match with apostrophes removed.
        - Add the missing phrases.
        - Send every message that doesn't match a keyword to an AI emergency check as a backup. Today that backup only runs for non-English messages.
        - Make emergency cases a 100% pass requirement in the test suite.

- [x] **The AI can approve its own high-risk actions**
    - **The issue:** Actions like deleting an account, cancelling an interview or removing a job post are supposed to wait for the user to reply YES. A flaw in the approval check means the AI itself could submit the approval and skip the user's YES.
    - **Why it matters:** A confused AI, or someone hiding instructions in a profile bio or message, could trigger account deletion or cancellations without the user agreeing.
    - **How we'll fix it:** Strip approval codes out of anything the AI sends, accept an approval only after the user's real YES has been recorded, and never show approval codes to the AI.
    - **Done (Nov 9):** Only an action the user's own YES has claimed (status 'executing') can be confirmed; 'awaiting' and 'approved' no longer count. The confirmation id is stripped from anything the model sends, the pending-action stub no longer shows the model the id, and the second gate (runTool) now validates the id instead of trusting any value. Tests updated and added.

- [x] **The "tone filter" deletes words and reverses the meaning of messages** — _Done in code (8308ed73), not yet deployed_
    - **The issue:** A filter removes stiff phrases such as "I cannot" and "I'm not able to" from every outgoing text, without rewriting the sentence around them. For example:
        - "I'm not able to set up care in Austin just yet" reaches the family as "…so set up care in Austin just yet."
        - "I cannot give medical advice, but…" becomes "give medical advice, but…"
    - **Why it matters:** Families receive messages saying the opposite of what was meant, including text that reads as permission to give medical advice.
    - **How we'll fix it:** Stop deleting negative phrases. Reword those messages where they are written instead, and add a test that negatives always survive.


### P1: High (reliability, cost and correctness)

- [x] **Booking, cancelling and job posting stop if one AI provider goes down**
    - **The issue:** Evia normally switches to a backup AI provider when the main one fails. Eight conversation flows don't use that switch and call one provider directly: booking, cancel, reschedule, corrections, interviews, replacements, visit requests and job posting.
    - **Why it matters:** If that provider has an outage or runs out of credit, which happened on July 3, all of these flows stop working at once.
    - **How we'll fix it:** Route these flows through the shared AI helper, which already has retries and a backup provider.
    - **Done (Nov 10):** The eight scripted flows (booking, cancel, reschedule, corrections, interviews, replacements, visit requests, job posting) no longer call Anthropic directly. All 16 calls go through one helper, agents/flowModelCall.ts, which uses the shared fast path (OpenAI first, Anthropic Haiku automatically as the backup). A test fails if any flow goes back to a direct provider call.

- [x] **An unused AI endpoint is open to any signed-in user**
    - **The issue:** The backend has an AI relay that any signed-in user can call with any instructions, up to 30 times a minute, with no daily limit. The website no longer uses it.
    - **Why it matters:** Anyone who signs up could run up the AI bill or use it as a free AI service.
    - **How we'll fix it:** Remove it. If it's needed later, rebuild it with fixed prompts, size limits and a daily cap per user.
    - **Done (Nov 10):** Removed: the aiProxy function (functions/src/aiProxy.ts and its export), the dead site service that called it (services/ai.ts + test), and the CLAUDE.md line. Deploying will ask to delete the live v1-aiProxy function; say yes.

- [x] **No spending limit on text conversations during sign-up**
    - **The issue:** The per-phone limit on how fast someone can text is checked after the sign-up conversation has already been handled, so sign-up turns aren't limited. Each sign-up message can use up to 10 AI steps. There is also no daily cost limit per phone number.
    - **Why it matters:** A script texting the public number could drive unlimited AI costs.
    - **How we'll fix it:** Check the rate limit first for every message, and add a daily cost ceiling per phone number.
    - **Done (Nov 10):** The hourly abuse limit (120 msgs/hr) and the per-phone and global DAILY turn caps now run for EVERY turn before the sign-up branch (one helper, spendLimitsBlockTurn); they sit after the emergency check so an emergency still gets through. The daily caps still fail open. A true per-phone dollar ceiling is not added; the existing cap is in turns (CARA_DAILY_TURN_CAP, default 150).

- [x] **Users can get stuck on "Reply resume to continue"**
    - **The issue:** When someone has an unfinished sign-up, Evia only accepts exact words like RESUME or START OVER. Anything else ("yes", "continue please", "Resume.", or a question) gets the same prompt again, over and over.
    - **Why it matters:** People get stuck in a loop and can't sign up. This also blocks the emergency check (see P0).
    - **How we'll fix it:** Use the AI to understand the reply (resume, start over, or something else), and answer anything else normally.
    - **Done (Nov 10):** The reply is now read by the model (resume / start over / something else) instead of exact words: 'yes', 'continue please', 'Resume.' resume; 'begin again' restarts; a question or anything else is answered normally and the saved checkpoint is kept. The old prompt is no longer sent in a loop.

- [x] **Questions get saved as the emergency contact's name**
    - **The issue:** During family sign-up, if someone replies to "Who's your emergency contact?" with a short question like "what is this for" or "dont have one," Evia can save that text as the contact's name.
    - **Why it matters:** A wrong emergency contact ends up on the care plan.
    - **How we'll fix it:** Check for questions first and answer them, then re-ask. Never guess a name from leftover words.
    - **Done (Nov 10):** The family text intake now asks the model whether the reply is an answer, a question or a refusal. A question is answered and the question re-asked; 'dont have one' gets a plain reason we need one; neither is ever saved as a name. A short real name or initials still save.

- [~] **Two quick texts in a row can get lost or answered twice**
    - **The issue:** If a second text arrives while Evia is still answering the first, it waits only about 3 seconds before failing. A full answer can take a minute or more. A turn that fails after already replying may also run again and send a duplicate reply.
    - **Why it matters:** Replies get lost, delayed or duplicated, which is confusing when a family is coordinating care.
    - **How we'll fix it:** Queue messages that arrive mid-reply and answer them in order. Set a hard time limit on each answer, and make sure a retry never sends the same reply twice.
    - **Partly done (Nov 10):** A second text now waits for the first (up to 95s, just past the 90s lock lease, polling every 0.75s) instead of failing after about 3 seconds. NOT done: a true ordered queue (arrival order among several waiters is best-effort) and a guard against a retried turn sending a duplicate reply.

- [~] **The pre-release AI test gate doesn't test Evia's real conversations**
    - **The issue:** The test that runs before each release only checks emergency keywords and the tone filter. It skips 150 of its 205 cases, and only runs when releasing through one particular command. The live conversation test also uses a different AI model from production.
    - **Why it matters:** Releases look tested when Evia's actual replies aren't.
    - **How we'll fix it:**
    - **Partly done (Nov 10):** Emergency cases are now must-pass (one failure blocks regardless of the overall rate); five missed wordings (curly apostrophes, capitals) were added; the gate now runs on EVERY functions deploy (firebase.json predeploy) instead of only through npm run deploy. NOT done: 177 of 210 cases are still skipped because they need a live, non-production agent run, and the live test's model was not re-checked.
        - Make emergency cases must-pass, and add the missed wordings above.
        - Run the gate on every release.
        - Make the live test use the same AI model as production.
        - Run the full live suite regularly against a test environment.

- [x] **Medicine names slip past the medication check**
    - **The issue:** The check that blocks medication instructions only looks for general words such as "pill", "dose" or "medication". A care plan note saying "Give her 2 Tylenol at 8pm" was saved without any warning. The website and Evia's texts use the same check, so both miss it.
    - **Why it matters:** The rule is that medication instructions never reach a care provider. Instructions that name a medicine get through.
    - **How we'll fix it:** Add common medicine names and patterns such as "give her 2 …" to the check, with tests, on both the website and Evia.
    - **Done (Nov 9):** About 100 common medicine names (brand and generic) plus 'antibiotic', 'painkiller', 'blood thinner' and drops are now medication words in both copies. 'Give her 2 Tylenol at 8pm' is refused; 'She takes Lipitor every day' still passes (a stated fact). The list is not exhaustive; extend it when one is missed.

- [~] **Short AI checks may come back empty (needs confirmation)**
    - **The issue:** Some quick checks, including the backup emergency check, allow only a few words of output. The newer AI models can use that allowance "thinking," which may leave no answer. An empty answer is treated as "no emergency."
    - **Why it matters:** A backup safety check could silently fail.
    - **How we'll fix it:** Turn off the models' "thinking" on these quick checks, and alert the team whenever one comes back empty.
    - **Partly done (Nov 10):** An empty quick-check answer is now logged every time, retried once with extra room for reasoning models (so the hidden 'thinking' can't use up the allowance), then handed to the Anthropic backup, and raises an ops alert (throttled to one per 10 minutes). NOT done: turning the models' reasoning off, because the setting could not be verified against the production models.

- [~] **Conversation data may be going to an extra outside service (needs confirmation)**
    - **The issue:** The AI calls are wrapped by a monitoring tool (LangSmith). If its tracing is switched on in production, full conversations, including care needs, notes and addresses, are sent to that vendor too, and it isn't on the approved list of providers that may receive health information.
    - **Why it matters:** This could be a health-privacy (HIPAA) compliance gap.
    - **How we'll fix it:** Check the production setting. If tracing is on, enable data masking or turn it off, and add the vendor to the approved list if it stays.
    - **Partly done (Nov 10):** Code now forces LangSmith tracing OFF unless someone deliberately sets LANGSMITH_ALLOW_PHI_TRACING=true. Still to check outside the code: whether tracing was on in production (the functions env), and whether LangSmith should be added to the approved-vendor list.

- [x] **The main AI call gives up after 10 seconds (needs confirmation)**
    - **The issue:** Evia's main reasoning call uses the same 10-second time limit as the quick checks, even though its instructions are large.
    - **Why it matters:** Turns may often fall back to the backup provider, which is slower and costs more.
    - **How we'll fix it:** Give the main call its own 25–30 second limit, and track how often the backup is used.
    - **Done (Nov 10):** The main reasoning call (and its Gemini and Anthropic backups) now has its own 28-second limit instead of the quick checks' 10 or 15 seconds. The backup is raised as a provider alert each time it is used, as before.

- [ ] **The Terms of Service may describe checks that don't happen (needs confirmation)**
    - **The issue:** The Terms (section 3) say care providers go through "sex offender registry checks, reference checks, and credential verification." As far as we can see in the product, the background check covers criminal history, plus the driving record for providers who offer transportation.
    - **Why it matters:** Promising safety checks we don't perform is a legal and trust risk.
    - **How we'll fix it:** Confirm with the founder exactly which checks the Checkr package includes, then update the Terms so they match.


### P2: Medium (quality and consistency)

- [ ] **The AI model settings don't match the documentation**
    - **The issue:** Some checks run on the cheapest model rather than the documented one, the backup provider isn't documented, and the default models are older ones if a setting is missing.
    - **Why it matters:** Lower-quality answers on important checks, and confusion for whoever changes the setup next.
    - **How we'll fix it:** Point the safety checks at the right model, warn at startup when a setting is missing, and update the documentation.

- [ ] **Other users' text reaches the AI unchecked**
    - **The issue:** Profile bios, messages and job descriptions written by other users are passed to the AI as-is.
    - **Why it matters:** Someone could hide instructions in their bio to manipulate Evia. This makes the self-approval issue in P0 more serious.
    - **How we'll fix it:** Mark all user-written content as "data only, not instructions" before the AI sees it.

- [ ] **Some replies are interpreted with keyword matching instead of the AI**
    - **The issue:** A few places decide what the user meant by looking for words like "interview," which goes against the project's own rules.
    - **Why it matters:** Evia misreads messages such as "I don't want an interview."
    - **How we'll fix it:** Let the AI interpret these replies.

- [ ] **Personal details appear in system logs**
    - **The issue:** Snippets of messages and full phone numbers are written to the server logs.
    - **Why it matters:** Logs are widely accessible to the team and tools, so they should never contain health or contact details.
    - **How we'll fix it:** Log only masked phone numbers and message lengths.

- [ ] **False emergency alarms**
    - **The issue:** The emergency check matches "er now" inside "call her now," and "911" inside phone numbers. If the backup check is slow, it defaults to "yes, emergency."
    - **Why it matters:** Ordinary messages can get a 911 reply, which is alarming and erodes trust.
    - **How we'll fix it:** Match whole words only, and remove the overly broad phrases.


### P3: Low (polish)

- [ ] **The AI's instructions mention features that no longer exist**
    - **The issue:** The AI is still told about retired features such as health-portal logins and pharmacy bookings.
    - **Why it matters:** This wastes AI cost on every message and can send users the wrong way.
    - **How we'll fix it:** Remove the retired features from the instructions.

- [x] **Two automated tests fail because their dates are out of date** — _Done Nov 7 (dates moved to 2099), not yet committed_
    - **The issue:** Two tests use a fixed "paused until" date (November 1, 2026), which is now in the past.
    - **Why it matters:** Failing tests hide real problems and train the team to ignore failures.
    - **How we'll fix it:** Pin the test clock, or use far-future dates.

- [ ] **Undocumented choices**
    - **The issue:** There's no length limit on text replies, and the emergency message still says "reply NOTIFY," a style the voice guide otherwise avoids.
    - **Why it matters:** Neither is a problem today, but both should be written down as deliberate choices.
    - **How we'll fix it:** Document both in the Evia voice guide.


---

## 3. UI & product

### P0: Urgent (stops people from using the product)

- [x] **Sign-in stops working after one failed attempt** — _Done in code (8308ed73), not yet deployed_
    - **The issue:** If the first "Send code" attempt fails for any reason, such as a network blip, every retry on that page fails too with "Something went wrong. Please try again." The behind-the-scenes error is *"reCAPTCHA has already been rendered in this element"*: the page tries to reuse the hidden anti-bot check it just removed.
    - **Why it matters:** A family or care provider who hits one hiccup can't sign in at all unless they think to refresh the page. Most people will assume the site is broken.
    - **How we'll fix it:** Create a fresh anti-bot check for every attempt. Apply the same fix to the sign-up and phone re-verification screens, which share the code, and add an automated test that a retry works.


### P1: High (big usability or trust problems)

- [ ] **Error messages don't say what went wrong**
    - **The issue:** The sign-in screen recognises only five error types. Everything else shows "Something went wrong. Please try again." Many other screens fail silently.
    - **Why it matters:** Users don't know whether to retry, wait, or call support, and support can't diagnose the problem.
    - **How we'll fix it:** Show a plain-language message for each common error, always offer a next step ("Try again" or "Call us"), and send the technical details to our error-tracking dashboard.

- [ ] **The app looks like three different products**
    - **The issue:**
        - The public website uses a warm cream background with dark rounded buttons.
        - Once you sign in, the dashboard switches to a bright blue gradient with blue square-ish buttons.
        - The background-check and photo-upload pages are black with electric-blue buttons.
        - The logo also changes, from an outline mark to a filled dark square.
    - **Why it matters:** Families judge trust by consistency. A page that suddenly looks different, especially the one asking for background-check consent, feels like a different or unsafe site.
    - **How we'll fix it:** Set up one central theme (see "One central theme" in the code plan) and apply the same colours, buttons and logo across the website, the app and the texted-link pages.

- [ ] **Pop-ups cover the page as soon as it loads**
    - **The issue:**
        - An "Install Evia" box appears on the first visit to every page, including the background-check consent page.
        - After sign-in, a large "Stay Updated – Enable Notifications" box sits over the dashboard and hides the Bookings card.
        - The Install button is teal, a colour used nowhere else.
    - **Why it matters:** These boxes get in the way before the user has done anything, cover important content, and feel pushy on a consent page.
    - **How we'll fix it:**
        - Ask for install or notifications only after a meaningful moment, such as the first booking request.
        - Show the prompts as a small banner that doesn't cover content.
        - Never show them on sign-up, consent or payment pages, and remember when someone says "Not now."

- [ ] **Settings page is cramped and cut off on mobile**
    - **The issue:** Settings keeps a two-column "label | value" layout on phones. Values get squeezed into a narrow column, and the "Not confirmed yet" badge and email address run off the right edge of the screen.
    - **Why it matters:** People can't read or fix their own account details on a phone, which is where most families will use Evia.
    - **How we'll fix it:** Stack each label above its value on small screens, and let long values wrap.

- [ ] **The calendar is hard to use, especially on mobile**
    - **The issue:** The week view always opens at 12am, so the useful daytime hours are below the fold. On mobile it squeezes seven days into a phone screen and cuts off Thursday through Saturday.
    - **Why it matters:** Families and care providers can't see upcoming visits at a glance.
    - **How we'll fix it:** Scroll to 7am, or the first visit, when the calendar opens. Default phones to the List or Day view, and let people swipe between days.

- [ ] **Texted-link pages open with no valid link**
    - **The issue:** The background-check page and the photo-upload page show the full form even when someone opens them without the personal link Evia texts.
    - **Why it matters:** A person who opens an old or copied link fills in the form and only then hits an error, which is confusing and erodes trust on a legal consent step.
    - **How we'll fix it:** Check the link first. If it's missing or expired, show "This link has expired" with a "Text me a new link" button.

- [ ] **Find Care shows a blank spinner for several seconds**
    - **The issue:** Opening Find Care shows an empty page with a small spinner for 3 seconds or more before any results appear.
    - **Why it matters:** This is the most important page for families, and a blank screen feels slow or broken.
    - **How we'll fix it:** Show placeholder cards in the shape of the results straight away, and speed up the provider search.

- [ ] **The brand font isn't showing anywhere**
    - **The issue:** Because of a setup error, the site downloads the brand font (Plus Jakarta Sans) but displays the device's default font instead. Only the large headings use the brand serif font. A third, unused font is also downloaded.
    - **Why it matters:** The product doesn't look the way it was designed, and visitors download font files that are never used.
    - **How we'll fix it:** Correct the theme setting so body text uses the brand font, and remove the unused font.

- [x] **"Looks good" on the care plan publishes a job post without saying so**
    - **The issue:** Confirming the care plan with "Looks good" creates a public job post straight away, and nearby care providers are texted about it. Nothing on the button or the page says this will happen.
    - **Why it matters:** A family checking their details can end up advertising a job they weren't ready to post, and real care providers get a text. This happened during testing.
    - **How we'll fix it:** Make posting a separate, clearly labelled step ("Post this job"), or ask the family to confirm and show what will be shared first.
    - **Done (Nov 9):** The family dashboard no longer posts automatically. Once identity and membership are done it shows a 'Your job isn't posted yet' card with what will be shared (street and contact details are not), who sees it, and a 'Post this job' button (plus 'Not yet'). Tests in WhatsNext.test.tsx. Evia's own posting flow already had an explicit confirm step.

- [x] **Contact details can be put in public job descriptions**
    - **The issue:** The job description box says not to include phone numbers or emails, but a description containing both was accepted and saved.
    - **Why it matters:** Every care provider can read the description, so a family can expose personal contact details without realising.
    - **How we'll fix it:** Detect phone numbers and email addresses when the description is saved, on the website and by text, and ask the family to remove them.`)
    - **Done (Nov 9):** New shared check (utils/contactDetails.ts + functions twin, parity-tested) refuses phone numbers (digits and spelled out), emails (also 'name at gmail dot com'), links, @handles and off-Evia contact/payment apps (WhatsApp, Telegram, Snapchat, Venmo, Zelle, Cash App, PayPal). Wired into the Post a job details and title, the job edit window, the older posting wizard, Evia's posting flow and edit, and the text intake. Same refusal for care provider bios: profile editor, signup wizard, Evia's bio step and the profile tool.
    - **Confirmed Nov 7:** "Call me at 408-555-0199" went through the form and was saved word-for-word in the post's `description`.

- [x] **"Nearby Care Providers" looks like it never finishes loading** — _Found in live testing, Nov 7_
    - **The issue:** When no care provider matches, the family dashboard shows four pulsing loading cards that never go away. The "Care providers are being matched to your area, check back shortly" note sits below the fold (`components/client/ClientDashboard.tsx`).
    - **Why it matters:** Families think the page is broken. With only 4 public care-provider profiles in production today, most families will see this.
    - **How we'll fix it:** Show a real empty state: no placeholders, a clear message, and the "Browse all care providers" button in view.
    - **Done (Nov 11):** The four pulsing placeholders are gone. With no match the dashboard shows a real empty state: a clear message and a 'Browse all care providers' button.

- [~] **The post-a-job form loses everything if you're signed out** — _Found in live testing, Nov 7_
    - **The issue:** The 6-step care request form keeps no draft. During testing, the session ended while the form sat on the review step (cause unknown; no idle timeout in the code), and all answers were gone after signing back in.
    - **Why it matters:** Families lose several minutes of work and may give up.
    - **How we'll fix it:** Save a draft as each step is completed (on the `job_postings` record or locally), and find out why the session ended.
    - **Partly done (Nov 11):** The form now saves a draft in the browser per account as each answer changes, restores it on the next visit with a 'Start over' option, and clears it when the job is posted (a week-old draft is dropped). NOT done: the cause of the Nov 7 session end is still unknown; the draft lives in that browser only.


- [~] **Interview times are saved in the family's device time zone** — _Found in live testing, Nov 7_
    - **The issue:** The interview form shows plain times ("10:00 AM") with no time zone and saves them using the family's device time zone. The server then shows them in California time. Live: 10:00 AM chosen on a device set to UTC+5 was saved as `2026-11-10T05:00Z`, and the care provider's notice said "Monday, November 9 at 9:00 PM" while the site showed Tuesday 10:00 AM.
    - **Why it matters:** A relative arranging care from another state or country books the wrong time, and Evia's texts and the site disagree about when the interview is.
    - **How we'll fix it:** Treat every care time as the care location's time zone (Pacific today): build the timestamp in that zone, show the zone next to times, and add a test with a non-Pacific browser.
    - **Also seen with visits:** the care provider's Bookings page lists visits and shows "Start Shift" by the device's clock, while the server checks the 15-minute window in Pacific time. On a device in another time zone, Start spins for about 10 seconds and then says "Not yet — Start opens 15 minutes before the visit (12:00 AM on Sat, Nov 7)", a time that has already passed on that device.
    - **Done (Nov 11) for all U.S. time zones (decision Nov 9: the exact UTC moment is canonical, not Pacific):** New shared helper utils/careTime.ts (site + functions twin, byte-parity tested): ZIP→zone for every U.S. zone incl. split states, Arizona (no daylight saving), Alaska, Hawaii; wall-clock⇄instant conversion across daylight-saving changes and midnight. Visits: each visit is stamped with its care location's zone when generated (booking too, on acceptance); a record with none reads from its address ZIP, then Pacific, so existing data is unchanged. The server's 15-minute Start window, Evia's today/START lookup, timesheet scheduled times, and the booked-window check that decides whether submitted hours are 'outside the booked window' (this would have rejected correct Chicago hours) all use the visit's zone; the site's overdue/cancel-window/Start-window/log-hours use it too, instead of the browser's clock. Interviews are exact instants shown in each person's own zone: the family's and care provider's texts and notices name their own zone (e.g. '12:00 PM ET'; Pacific text is unchanged), and the interview window says which zone the times are in. Day-before reminders now run hourly and fire at 7 PM (care provider) / 9 PM (family) on the visit's own clock the evening before, instead of one Pacific-anchored run. A small zone tag appears beside visit times outside Pacific. Tests run clean under five machine zones (UTC, Pakistan, New York, Hawaii, Los Angeles). NOT done: the zone name on every one of ~50 site time strings and on the remaining Pacific-fixed Evia texts (timesheet lists, in-shift confirmations, other interview pick-lists); the calendar views' own 'today'; a backfill of the zone onto existing visits (not needed: unzoned = Pacific = how they were made); ZIP-3 accuracy at a few county-level borders.

- [x] **Families can request a second interview with someone they've already interviewed** — _Found in live testing, Nov 7_
    - **The issue:** After the care provider accepted the interview, the family dashboard card and the care provider's profile both offer "Request Interview" again. Before acceptance the card correctly said "Interview Requested".
    - **Why it matters:** Duplicate requests confuse both sides and clutter the care provider's inbox.
    - **How we'll fix it:** Show the interview's status ("Interview Tue 10:00 AM") on the card and profile whenever one is pending or accepted.
    - **Done (Nov 11):** Accepted and confirmed interviews now count as already requested on the dashboard card, Find Care and the care provider's profile (it only counted requested / pending / scheduled).

- [~] **The booking form doesn't reuse the job post** — _Found in live testing, Nov 7_
    - **The issue:** "Send Booking" opens with the rate, schedule and care location empty and marked "Required", even though the family entered all three when posting the job this care provider applied to.
    - **Why it matters:** Families type the same details twice, and the two can drift apart.
    - **How we'll fix it:** Pre-fill the booking from the job post (or the care plan) and let the family adjust.
    - **Partly done (Nov 11):** The form now opens with the rate from the job post, the care location whose ZIP matches the post (else the only saved address, else the account address), and the ongoing / end date from the post. NOT done: start and end times (the post has only morning / afternoon / evening) and the days' times stay for the family to enter.

- [ ] **Families can book without a card on file** — _Found in live testing, Nov 7_
    - **The issue:** The family had no payment card, yet the booking request went through, the care provider accepted it, and both sides show "Card" as the payment method. Payment is only attempted after the visit, when the family approves hours (or 24 hours pass).
    - **Why it matters:** The charge fails after the care provider has already worked, and the care provider isn't paid.
    - **How we'll fix it:** Ask for a card before a booking request can be sent (or before the care provider can accept), and show a clear prompt on the booking form.

- [x] **Care providers can put a phone number in their public bio** — _Found in live testing, Nov 7_
    - **The issue:** Saving "Text me at 408-555-0177." in the care provider's About text was accepted ("Profile updated") and shown on the public profile. Job descriptions have the same gap (listed above).
    - **Why it matters:** Families and care providers can arrange care off the platform, which skips the background-check, payment and safety protections.
    - **How we'll fix it:** Run the same contact-detail check on bios as on job descriptions, on the site and in Evia's bio step.
    - **Done (Nov 11):** Done in Wave 1 (Nov 9): phone numbers, emails and links are refused in bios on the profile editor, signup wizard, Evia's bio step and the profile tool.

- [x] **Cancelling one visit ends the whole ongoing booking** — _Found in live testing, Nov 7_
    - **The issue:** The weekly booking (Tuesdays, ongoing) had only the next visits created. When the care provider used "Cancel this shift only" on the last created visit (the prompt said "The rest of your booking stays active"), the booking's status became "completed" and it disappeared from Active Bookings on both sides.
    - **Why it matters:** Families and care providers lose an ongoing arrangement by cancelling a single day, and nobody is told.
    - **How we'll fix it:** Never end an ongoing booking because its created visits ran out; create the next visits ahead of time, and only end a booking when someone chooses to.
    - **Done (Nov 9):** An ongoing booking is no longer marked completed when its last scheduled visit is cancelled or completed: the next two weeks of visits are created straight away and the booking stays accepted; a dated booking completes only when there is nothing left to create. The daily generator now continues from the furthest visit in ANY state, so a cancelled date is never re-created. Frozen membership / locked care provider still get no new visits. Tests: shiftGeneratorNextVisits.test.ts, notificationTriggers.bookingCompletion.test.ts. Race to know about: the trigger and the daily job could both create visits for the same booking in the same minute; not guarded.

- [ ] **A failed payment is handled unclearly on both sides** — _Found in live testing, Nov 7_
    - **The issue:** With no card on file, the family could still approve hours. The charge failed and the family was told "the card was declined" (there was no card). The timesheet then showed "Correction history: Accepted" though no correction was made, and stayed under "Needs Review". The care provider only sees "Awaiting Payment", with no word that the family's payment failed, and their History says "No completed shifts yet".
    - **Why it matters:** Care providers aren't paid and aren't told why; families get a wrong reason.
    - **How we'll fix it:** Require a card before approval (see "Families can book without a card on file"), say "no card on file" when that's the cause, tell the care provider when a payment fails and what happens next, and drop the false correction entry.

### P2: Medium (consistency and polish)

- [ ] **Too many accent colours**
    - **The issue:** The app uses blue buttons, teal sliders and teal Install buttons, an orange crown on Membership, and dark buttons, with no clear rule for which goes where.
    - **Why it matters:** The look is less polished, and it isn't obvious which button is the main action.
    - **How we'll fix it:** Choose one brand colour and one supporting colour in the central theme, and keep red, green and amber for status only.

- [ ] **Buttons look different from page to page**
    - **The issue:** Some main buttons are dark pills ("Find a Care Provider" on My Care Team) and others are blue rectangles ("Request Interview", "New Request"). Button text alternates between Title Case and sentence case.
    - **Why it matters:** It's harder to learn what to tap, and the app feels stitched together.
    - **How we'll fix it:** Use one shared Button component with a fixed set of styles (main, secondary, text link) and sentence case everywhere.

- [ ] **Page layouts are inconsistent**
    - **The issue:**
        - Some pages have a white header band (My Bookings, Calendar, Membership); others put the title straight on the background (Care Requests, Timesheets, My Care Team).
        - Content widths vary from page to page.
        - Care Requests puts its empty box in the left third of the screen.
        - The app background is a cool grey under a cream header bar.
    - **Why it matters:** Each page feels slightly different, so the product feels less finished.
    - **How we'll fix it:** Use one shared page layout (title, subtitle, actions, content width) and one background colour.

- [ ] **Page names don't match the menu or the web address**
    - **The issue:**
        - The "Payments" page is titled "Timesheets."
        - Visits opens as "My Bookings."
        - On the Care Requests page, the top menu highlights "Find Care."
    - **Why it matters:** Users lose track of where they are and can't find things again.
    - **How we'll fix it:** Agree one name for each area and use it in the menu, the page title and the web address.

- [ ] **Care provider cards are confusing**
    - **The issue:**
        - Prices show two numbers ("$24/hr · $26.16/hr billed") with no explanation.
        - The blue "BGC+" badge isn't explained.
        - Names appear exactly as typed ("hamse mahad").
        - On mobile, long names are cut off by the heart icon, and the location, price and billed price wrap awkwardly.
    - **Why it matters:** Families compare providers on these cards. Unclear pricing and badges reduce trust.
    - **How we'll fix it:**
        - Show one clear price with a small "includes 9% service fee" note.
        - Replace "BGC+" with a labelled "Background checked" badge.
        - Capitalise names for display.
        - Redesign the card layout for small screens.

- [ ] **Phone numbers, dates and prices are formatted differently on each page**
    - **The issue:** Settings shows the phone as "+15055281528." Other pages format numbers, dates and prices in their own ways.
    - **Why it matters:** It looks unpolished, and the same detail can look different on two pages.
    - **How we'll fix it:** One shared set of formatting tools, so the phone shows as (505) 528-1528 and prices and dates look the same everywhere.

- [ ] **Care Plan "care needs" look like text boxes**
    - **The issue:** Selected care needs such as "Meal Preparation" appear as large blue outlined boxes, which look like a text field you can type into.
    - **Why it matters:** People try to click into them and get confused.
    - **How we'll fix it:** Show them as small labels (chips) and keep editing behind the pencil icon.

- [ ] **Empty pages don't say what to do next**
    - **The issue:**
        - Messages with no conversations shows two empty panels and no next step.
        - On mobile, the search icon overlaps the "Search conversations" text.
        - Empty states look different on every page.
    - **Why it matters:** New families land on empty screens with nothing to do.
    - **How we'll fix it:** One shared "nothing here yet" component with a clear action, such as "Find a care provider to message," and fix the search field spacing.

- [ ] **Accessibility gaps (keyboard and screen readers)**
    - **The issue:**
        - About 84 icon-only buttons (close, next/previous, edit) have no description for screen readers.
        - About 33 clickable areas aren't real buttons, so they can't be reached with the keyboard.
        - Pop-up windows can't be closed with Escape and aren't announced as pop-ups.
        - The keyboard focus outline is barely visible.
    - **Why it matters:** People who rely on keyboards or screen readers can't use parts of the app, and accessibility is a legal expectation for consumer health services.
    - **How we'll fix it:** Add labels, use real buttons, build one accessible pop-up component, and add a visible focus style. An automatic check will stop new problems from being added.

- [ ] **Browser-style "OK / Cancel" boxes**
    - **The issue:** About 30 actions use the browser's plain grey alert or confirmation box.
    - **Why it matters:** These boxes look off-brand and dated, and some phones block them.
    - **How we'll fix it:** Replace them with branded confirmation pop-ups and notifications.

- [x] **The dashboard's progress line counts the wrong steps**
    - **The issue:** With 2 of 3 setup steps done, the dashboard says "You're 2 of 3 steps away from care." With none done, it says "You're 0 of 3 steps away."
    - **Why it matters:** It tells families the opposite of how far along they are.
    - **How we'll fix it:** Show the steps left ("1 step away from care") or the steps done ("2 of 3 steps done").
    - **Done (Nov 11):** Now reads '2 of 3 steps done' or '1 step away from care'.

- [ ] **The care plan progress card shows an out-of-date status**
    - **The issue:** Right after finishing the setup questions, the dashboard said "60% complete — select the types of care needed", even though the care types had been saved. It only corrected itself after visiting the Care Plan page.
    - **Why it matters:** Families are asked to redo something they've already done.
    - **How we'll fix it:** Work out progress from the same record the setup questions save to, and refresh it when they close.

- [x] **Wrong message when posting a request before the identity check**
    - **The issue:** Clicking "New Request" before the identity check shows "To contact care providers, you need to complete a quick identity check."
    - **Why it matters:** The family was posting a request, not contacting anyone, so the message is confusing.
    - **How we'll fix it:** Word the message for the action that was blocked, for example "To post a care request…".
    - **Done (Nov 11):** The identity check now names the blocked action: 'To post a care request…', 'To interview …', 'To book …'.

- [ ] **Some form checks don't explain themselves**
    - **The issue:** A $0 hourly rate just greys out "Continue" with no explanation. On the Care Plan page, a missing first name only shows as a pop-up at the top of the screen, away from the field. The emergency contact can be the account holder's own phone number.
    - **Why it matters:** People can't tell what's wrong. An emergency contact who is the user themselves is no help in an emergency.
    - **How we'll fix it:** Show the reason next to the field, and don't accept an emergency contact with the same number as the account.

- [ ] **The page behind a pop-up scrolls too**
    - **The issue:** Scrolling inside the care provider profile pop-up also scrolls the page behind it.
    - **Why it matters:** It feels broken, and people lose their place on the page.
    - **How we'll fix it:** Stop the background page from scrolling while a pop-up is open, as part of the shared pop-up component.`)

- [x] **In-app notifications show raw web addresses** — _Found in live testing, Nov 7_
    - **The issue:** Bell notifications include links as plain text, for example "https://www.eviacares.com/client/membership".
    - **Why it matters:** It looks unfinished, and the long address is hard to read on a phone.
    - **How we'll fix it:** Turn links into a button or tappable text ("View membership"), using the notification's own link field.
    - **Done (Nov 11):** Bell text drops raw links and reads as a normal sentence.

- [~] **The care provider jobs list shows stale and badly formatted jobs** — _Found in live testing, Nov 7_
    - **The issue:** Before setting a location, the test care provider's dashboard listed jobs dated August–September 2026 (already past), "Location TBD", "26/hr" with no $ sign, and raw values such as "via credit_card" and "via cash".
    - **Why it matters:** Care providers see jobs they can't take and data that looks broken.
    - **How we'll fix it:** Hide past-dated jobs, require a location before listing jobs, and format rates and payment methods with the shared formatters.
    - **Partly done (Nov 11):** Jobs dated before today are hidden on the job board and the onboarding dashboard; rates read '$26/hr'; payment reads 'Paid by card through Evia' (no 'via cash'); 'Location TBD' is no longer shown; 'Experience' no longer reads 'years years'. NOT done: requiring a location before any jobs are listed.

- [~] **Interview requests are slow and the times ignore the care provider** — _Found in live testing, Nov 7_
    - **The issue:** Sending an interview request took about 8 seconds and showed two success messages saying the same thing. The time list is always 9 AM–6 PM, whatever hours the care provider gave, and shows no time zone.
    - **Why it matters:** Families pick times the care provider has said they can't do, and the double message looks like a glitch.
    - **How we'll fix it:** Offer times from the care provider's availability, show the time zone, and show one confirmation.
    - **Partly done (Nov 11):** Times are now offered from the care provider's own availability for the chosen day (all day when none is set), the window states the zone, and there is one confirmation (Find Care showed none before). NOT done: the ~8 second wait to send.

- [ ] **Editing a care location adds a second one** — _Found in live testing, Nov 7_
    - **The issue:** Changing the family's care location to a new address kept the old one, so the post-a-job form lists both Santa Clara and Gilroy.
    - **Why it matters:** Families may post a job at an old address.
    - **How we'll fix it:** Editing should replace the address; adding a new one should be a separate action.

- [x] **The job review step shows details the family never entered** — _Found in live testing, Nov 7_
    - **The issue:** The review page shows the raw date ("2026-11-10"), and adds "Pets in home" and "Credit Card" without the form ever asking.
    - **Why it matters:** Families post details they didn't choose, and care providers see them.
    - **How we'll fix it:** Format the date, and only show fields the family set (or ask for them in the form).
    - **Done (Nov 11):** Dates are formatted ('Tue, Nov 10, 2026') and payment reads 'paid by card through Evia'. Pets / smoking were already only shown when set on the saved location.

- [x] **The rate step gives no guidance** — _Found in live testing, Nov 7_
    - **The issue:** "Set your rate" is an empty box. It gives no typical local range and doesn't mention the fee families pay on top ($25/hr becomes $27.25/hr billed).
    - **Why it matters:** Families guess, and the higher billed amount is a surprise later.
    - **How we'll fix it:** Show a typical range for the area and the billed amount as the family types.
    - **Done (Nov 11):** The rate step shows a typical local range (25th–75th percentile of the rates care providers have set; $18–28 when there are too few) and the billed amount as the family types, e.g. $25/hr → $27.25/hr.

- [~] **Form errors appear at the top of the screen and linger** — _Found in live testing, Nov 7_
    - **The issue:** Leaving the rate empty shows "Please enter an hourly rate" as a pop-up at the top of the screen instead of next to the field, and it stays visible on the next step.
    - **Why it matters:** The message is easy to miss, and seeing it on the next step is confusing.
    - **How we'll fix it:** Show the error under the field and clear it when the step changes.
    - **Partly done (Nov 11):** The rate step shows its error under the field and clears it when the rate is typed; moving to another step scrolls to the top and clears leftover error toasts. NOT done: moving the other steps' errors under their fields.

- [ ] **Days of the week are in a different order on each side** — _Found in live testing, Nov 7_
    - **The issue:** Care provider pages list Mon–Sun; family pages list Sun–Sat.
    - **Why it matters:** Small, but it makes the two sides feel like different products.
    - **How we'll fix it:** Pick one order and use a shared day list.

- [x] **"BGC+" badge on care provider cards** — _Found in live testing, Nov 7_
    - **The issue:** The background-check badge on the family's care provider card reads "BGC+" in tiny text.
    - **Why it matters:** Families don't know what it means, so the strongest trust signal is lost.
    - **How we'll fix it:** Use plain words, for example "Background checked", with a short explanation on hover or tap.
    - **Done (Nov 11):** The badge now reads "Background checked" with a check icon.

- [ ] **Slow pages: Membership and the family dashboard** — _Found in live testing, Nov 7_
    - **The issue:** The family Membership page showed "Loading membership status..." for more than 3 seconds. (Find Care being slow is already listed.)
    - **Why it matters:** Slow pages feel broken, especially on mobile data.
    - **How we'll fix it:** Load membership status from the user record already in memory, and show a placeholder instead of a sentence.

- [~] **No notice when a care provider's membership becomes active** — _Found in live testing, Nov 7_
    - **The issue:** The care provider got no in-app notification when their membership became active.
    - **Why it matters:** They don't know they can move on to the background check.
    - **How we'll fix it:** Send a bell notification (and Evia text) when the membership activates.
    - **Partly done (Nov 11):** Checked, not a code gap: the care provider's 'Membership active' bell and text are raised by the membership record change (membership_paid). The Nov 7 test set the membership by hand, which skips that change. Re-test with a real (test-mode) payment.


- [~] **The care provider's dashboard doesn't update after actions** — _Found in live testing, Nov 7_
    - **The issue:** After applying to a job, the card still said "Apply Now" and My Applications said "No pending applications" until a page reload. Applying again was only refused after filling the form in a second time ("You have already applied to this job"). After the reload, Nearby Jobs said "No jobs posted yet" because the one job was hidden once applied, and the application showed the date it was sent (Nov 7) where the job's date (Nov 10) is expected.
    - **Why it matters:** Care providers can't tell whether their action worked.
    - **How we'll fix it:** Update the lists as soon as the write succeeds, mark applied jobs "Applied", and say "No new jobs nearby" when jobs are only hidden.
    - **Partly done (Nov 11):** The dashboard's Nearby Jobs and the Care Requests card now listen live, so an applied job leaves the list and shows under My Applications at once (both were one-time reads). The empty text now says 'No new jobs nearby right now. Jobs you've applied to or hidden aren't listed here.' NOT done: the application row still shows the date it was sent, not the job's date.

- [x] **Accepting an interview leaves a blank page** — _Found in live testing, Nov 7_
    - **The issue:** On the care provider's Interviews tab, Accept removed the card and left an empty list with no message and no confirmation. The filter chips changed to "All / Accepted" while the address still said "pending". Accepting a booking request also showed no confirmation.
    - **Why it matters:** It looks like the interview disappeared.
    - **How we'll fix it:** Show a confirmation and switch to the Accepted view (or keep the card with its new status).
    - **Done (Nov 11):** Accept now switches to the Accepted view so the card stays in sight, confirms with what happens next, and an empty filter shows 'No … interviews right now' with a 'Show all interviews' button. Accepting a booking request already showed a confirmation.

- [x] **Family and care provider see different detail for the same event** — _Found in live testing, Nov 7_
    - **The issue:** The care provider's "Interview confirmed" notice has the time, the note and the Meet link; the family's "Interview Accepted" notice has neither time nor link.
    - **Why it matters:** The family has to go looking for when and where to join.
    - **How we'll fix it:** Use one notice template for both sides with time, link and next step.
    - **Done (Nov 11):** The family's 'Interview Accepted' bell now carries the time (in their own zone) and says Evia will text the call link. The family's text already carried the time and link.

- [ ] **Slow saves in Settings** — _Found in live testing, Nov 7_
    - **The issue:** Pausing the care provider account showed "Saving…" for about 10 seconds; reactivating was similar.
    - **Why it matters:** Feels broken; people click again.
    - **How we'll fix it:** Find what the save waits on (probably a backend call) and return as soon as the write lands.

- [~] **Family membership shows as "None" in some places** — _Found in live testing, Nov 7_
    - **The issue:** With member access granted (`membershipStatus: active`, set by hand for testing), Settings says "Membership plan: None — Add a plan" and the Membership page offers "Select a plan". The access check reads one field; these pages read another. Needs checking with a real subscription before treating it as a bug.
    - **Why it matters:** A paying family could be told they have no plan and pay twice.
    - **How we'll fix it:** Use one shared "membership active" helper everywhere (the access gate's rule).
    - **Partly done (Nov 11):** Checked, not a code gap: Settings and the Membership page read the subscription record, which any real subscription creates; only the hand-set test data lacked one. Re-test with a real (test-mode) subscription.

- [~] **The dashboard's timesheet and shift cards say the wrong thing** — _Found in live testing, Nov 7_
    - **The issue:** With no timesheet ever submitted, the family dashboard says "All timesheets reviewed". The upcoming shift card shows a time ("12 AM – 11:59 PM") without a date. The family's Settings shows the account address (old Santa Clara) separately from the care location (Gilroy), with no explanation.
    - **Why it matters:** Families read these as facts about their care.
    - **How we'll fix it:** "No timesheets yet" when there are none; always show the date on shift cards; explain or merge the two addresses.
    - **Partly done (Nov 11):** 'No timesheets yet' when none was ever submitted; the upcoming shift card shows the date. NOT done: explaining or merging the account address and the care location in Settings.

- [~] **Find Care filters and counts are off** — _Found in live testing, Nov 7_
    - **The issue:** With "5+ years" experience selected, a care provider with "3-5 years" still shows. The tabs say "All (2)" while the list says "1 care provider found". On a care provider card only the photo opens the profile (not the name), and the profile doesn't show the care provider's weekly availability.
    - **Why it matters:** Families filter on experience and availability to choose someone; wrong results erode trust.
    - **How we'll fix it:** Map the experience buckets to numbers correctly, make the counts agree, make the name a link, and add availability to the profile.
    - **Partly done (Nov 11):** The experience filter reads the stored bucket as a number (a '3-5 years' provider no longer passes '5+'); the All and Favorites counts use the same rules as the list; the care provider's name is a real button. NOT done: showing weekly availability in the profile window.

- [~] **A pending reschedule can be hidden from the care provider** — _Found in live testing, Nov 7_
    - **The issue:** When the family proposed moving a visit, the care provider's Bookings page tucked that visit behind "Show 1 more shift", so the "Accept new time / Decline" box was out of sight. The family's extra-visit request is labelled "Schedule change request" on both sides, and its booking picker lists bookings only by the care provider's name. After the care provider accepted it, the family's notice said "accepted your request to add Thu to your regular schedule", though only the one Nov 12 visit was added.
    - **Why it matters:** The care provider may never see the request, and the family's visit stays unconfirmed.
    - **How we'll fix it:** Always show visits with a pending request, show pending requests under the Requests tab, and call an extra visit an "Extra visit request".
    - **Partly done (Nov 11):** A visit with a pending reschedule is always shown (never behind 'Show more shifts'); a one-day request is called 'Extra visit request' on both sides and accepting it tells the family about the extra visit, not a change to the regular schedule. NOT done: listing pending requests under the Requests tab and naming the booking in the family's picker.

- [x] **Account-change errors don't say what went wrong** — _Found in live testing, Nov 7_
    - **The issue:** Changing the recovery email to an invalid address or to an address the email service refuses both show only "Failed to send the link". The server returned a specific reason ("Valid email required"; the email provider rejected the domain) that the page drops.
    - **Why it matters:** People can't fix the problem themselves.
    - **How we'll fix it:** Show the server's message, and check the email format on the page before sending.
    - **Done (Nov 11):** Both Settings pages show the server's own reason when it gave one (e.g. 'Valid email required') and check the email format before sending.

- [ ] **Visit and timesheet screens: slow, and the money shown doesn't match** — _Found in live testing, Nov 7_
    - **The issue:** Start and End each spun for about 12 seconds; ending a visit gave no confirmation and no prompt to submit hours. The extra-charge type list only offers "Custom" though the hint names overtime, mileage and supplies. The family's review window shows $2.37 while the card above says $3.37 will be charged (the 9% fee, $1 minimum, is left out). The banner says "Shifts auto-approve after 24 hours" while this timesheet (with an extra charge) needs manual approval. The care provider's message says "awaiting client approval".
    - **Why it matters:** The money step is where trust matters most; mismatched totals and slow buttons cause double clicks and disputes.
    - **How we'll fix it:** Speed up the visit actions, confirm the end and link to submitting hours, offer the named charge types, show the full amount charged everywhere, and word the auto-approve banner per timesheet.

- [x] **Reviews and blocking don't update everything** — _Found in live testing, Nov 7_
    - **The issue:** After the family left a 5-star review, the review appeared in the profile's Reviews section (5.0, 1 review) but the header still said "No reviews yet". Blocking the family from the care provider's chat happened with one click and no confirmation, and after unblocking in Settings the conversation never came back.
    - **Why it matters:** Care providers look unreviewed, and one mis-click permanently loses a conversation.
    - **How we'll fix it:** Update the profile's rating summary when a review lands, ask before blocking, and keep (hide, not remove) the conversation so unblocking restores it.
    - **Partly done (Nov 9):** Blocking now asks first, and unblocking (site and Evia) no longer hides or wipes the conversation: it comes back as it was. NOT done: the profile header still saying 'No reviews yet' after a review lands (Wave 3).
    - **Done (Nov 11):** The profile header rating and count now come from the reviews listed (no more 'No reviews yet' beside a 5-star review). With the Nov 9 blocking changes this item is complete.

- [x] **Deleting an account works but leaves loose ends** — _Found in live testing, Nov 7_
    - **The issue:** The care provider's deletion (confirm window, texted code, wrong code refused) removed their records, but the page stayed on "Deleting..." with no confirmation and no sign-out until reloaded, and then showed the plain login page with no "your account was deleted" message. The window never says what happens to the paid yearly membership, upcoming visits or unpaid hours. Afterwards the family's inbox still lists the conversation (unread badge) and accepts new messages that nobody will read, and their job post still shows "1 applicant".
    - **Why it matters:** The person deleting isn't sure it worked, and the family keeps writing to someone who's gone.
    - **How we'll fix it:** Sign out and show a clear "account deleted" page when the request completes; spell out the membership, visits and pay consequences in the window; mark the other side's conversations and applications as "no longer on Evia" and stop new messages.
    - **Done (Nov 9):** Server: deleting an account now cancels upcoming visits and open bookings the normal way (a care provider's as 'system', a family's as 'client', so the other side is told), withdraws a care provider's pending applications (the applicant count follows), takes down a family's open job posts, removes a care provider's public profile, and CLOSES conversations (closedReason, never deleted); the request is marked done before the login is removed. Site: after deletion the person is signed out and lands on a clear 'Your account has been deleted' page; the window lists the membership (non-refundable), visits, posts and conversations; a closed conversation shows 'no longer on Evia' and cannot send (also refused by firestore.rules). Needs a functions + firestore:rules + hosting deploy. Not done: what happens to unpaid hours is not automated, the window tells the person to contact support first.

### P3: Low (small fixes)

- [ ] **Leftover "(1)" and "(2)" labels on the home page**
    - **The issue:** Small "(1)" and "(2)" markers sit above two home-page sections.
    - **Why it matters:** They look like unfinished placeholders.
    - **How we'll fix it:** Remove them, or turn them into proper section labels.

- [ ] **Same call to action written three ways**
    - **The issue:** The site uses "Find a care provider," "Find Your Care Provider" and "Find a Care Provider."
    - **Why it matters:** Small inconsistencies make the product feel less polished.
    - **How we'll fix it:** One wording in sentence case everywhere.

- [ ] **Sign-in page repeats the logo and sits too high**
    - **The issue:** "Evia" appears in the header and again as a heading right under it, with almost no gap. The form is pushed to the top with empty space below.
    - **Why it matters:** It looks cramped and unfinished.
    - **How we'll fix it:** Remove the duplicate heading and centre the form vertically.

- [ ] **The "page not found" screen needs polish**
    - **The issue:** The large "404" is very faint, and the screen offers "Go to Dashboard" even to visitors who aren't signed in.
    - **Why it matters:** It's a minor dead end for people who follow an old link.
    - **How we'll fix it:** Make the 404 readable, and show only links that make sense for the visitor.

- [ ] **"Admin" link in the public footer**
    - **The issue:** Every visitor sees an "Admin" link in the footer.
    - **Why it matters:** It invites curiosity and looks unprofessional. The admin area is protected, so this isn't a security hole.
    - **How we'll fix it:** Hide it from the public footer.

- [ ] **Every page has the same browser-tab title**
    - **The issue:** Every page, including the dashboard and settings, shows the same tab title, "Senior & Child Care San Jose & Santa Clara County | Evia."
    - **Why it matters:** People with several tabs open can't tell them apart, and search engines see duplicate pages.
    - **How we'll fix it:** Give each page its own title, for example "Calendar · Evia."

- [ ] **Care provider bios break words in half**
    - **The issue:** On a care provider's profile, a word at the end of a line is split across two lines, for example "blessin" / "g".
    - **Why it matters:** It looks broken on the page families use to choose a care provider.
    - **How we'll fix it:** Use normal word wrapping for profile text.

- [ ] **Sign-up steps open scrolled down, and the terms checkbox has no label**
    - **The issue:** After pressing "Continue" on the sign-up page, the next step opens part-way down the page, so its heading is cut off. The "I agree to the terms" checkbox is read out by screen readers as just "on".
    - **Why it matters:** The first impression feels unfinished, and people using screen readers can't tell what they're agreeing to.
    - **How we'll fix it:** Scroll to the top at each step, and connect the checkbox to its label.`)
    - **Also seen Nov 7:** the care provider setup steps and the post-a-job steps open scrolled to the middle too.

- [ ] **More controls without labels** — _Found in live testing, Nov 7_
    - **The issue:** Screen readers can't name: the care provider's service options, the login code boxes, and several header icon buttons. The post-a-job "Ongoing / no end date" checkbox is read as "on". Login uses 6 code boxes while sign-up uses one box.
    - **Why it matters:** Blind and low-vision users can't complete these steps, and the two code inputs behave differently.
    - **How we'll fix it:** Add labels, and use one shared code-input component for sign-in and sign-up.

- [ ] **Small wording and layout slips** — _Found in live testing, Nov 7_
    - **The issue:** The jobs page has two "CARE TYPE" filter labels. The menu says "Log out" for care providers and "Sign Out" for families. The care provider sign-up page's tab title is "Find a Care Provider…". "Myself(Testfam E2E)" is missing a space. Date fields show two calendar icons (the browser's and a custom one).
    - **Why it matters:** Each is minor; together they make the product feel unfinished.
    - **How we'll fix it:** Fix each one; the shared building blocks in the code plan stop them coming back.


- [ ] **More wording slips on the care provider side** — _Found in live testing, Nov 7_
    - **The issue:** The apply window says "3-5 years years" and "Client's budget: 25/hr" ("client" where the product says "family", and no $). The inbox groups conversations under "OTHER CLIENTS" (the family side says "OTHER CARE PROVIDERS"). Job cards show a "Day" label next to "Morning" and "(0.0 mi away)". Settings shows the phone as "+16505550102" and the background check as "Background check cleared / Cleared". The payouts page repeats the fee and timing text twice. A past interview still offers "Join video call", "Reschedule" and "Cancel". The calendar opens at midnight, so the working day is below the fold. The emergency contact's first name was saved as "Contact".
    - **Why it matters:** Each is small; together they make the care provider side feel unfinished.
    - **How we'll fix it:** Fix each one, and use the shared formatters for money, phone numbers and distances.

---

## Testing notes (Nov 7)

**Test accounts (live project, labelled `e2eTestAccount` in the database)**
- Test family: +1 650-555-0101 (Testfam E2E), care recipient "Rosa E2E", Gilroy 95020. Identity check and membership set by hand.
- Test care provider: +1 650-555-0102 (Testcare E2E), Gilroy 95020, 5-mile radius. Membership, background check, approval and payouts set by hand.

**Tested so far (website)**
- Care provider: sign-up and setup wizard, dashboard, seeing and applying to a job, accepting an interview, inbox reply, accepting a booking, Bookings, Calendar, Payments (timesheets and payouts), My Families, Profile, Settings (pause and reactivate).
- Family: dashboard, Nearby Care Providers, messaging, requesting an interview, posting a care request, viewing applicants, marking an interview completed, sending a booking request, My Bookings, Care Team, Calendar, Payments, Membership, Settings.
- Production has only the two test shifts in `shifts` and one interview in `video_interviews`, so no real booking has gone through the site yet.

**Also tested:** a full visit (start, tasks, note, end), submitting hours with an extra charge, the family approving (payment failed as expected with no card), leaving a review, extra-visit request, reschedule proposal (declined), cancelling single visits from both sides, Find Care filters and favourites, editing availability, bio and services (Transportation), changing the recovery email, blocking and unblocking.

**Also tested:** deleting the test care provider's account (Nov 7).

**Still to test:** rescheduling an interview, the family cancelling a whole booking, anything that takes money or runs a background check (needs the sandbox; Stripe is live), the admin panel (skipped). Evia text testing is being done by hand.

**Test data changed by hand for this:** interview `y6CnesL1CQkuMVbtxlTJ` moved to Nov 6 so it could be marked completed; shift `lU6iX7VWwu5zvg6BrlUo` moved to Nov 7, 00:00–23:59, so it can be started.

**Side effects so far**
- Two test job posts texted a real care provider in Santa Clara (posts `eda2FvyOWQw3Je0OAo0V`, cancelled, and `FpHAbkOloK16HnM481Bf`, open for testing). A 10-mile travel radius was added to that provider's record to stop more texts. No one was told, per the founder's team.

**Clean-up after the fixes**
- Remove the support-line test number (650) 563-3842 and confirm who owns +1 408-637-0483.
- Remove the 555-0101 and 555-0102 test numbers.
- The test care provider's account was deleted through the app on Nov 7 (its records are gone). Delete the remaining test records labelled `e2eTestAccount`, the two test posts, the test interview and the test chat.
- Decide whether to keep the 10-mile radius added to the Santa Clara provider's record.
- In the LIVE Stripe account: an unpaid Checkout session (it expires on its own) and probably a customer record for e2e-family@example.com were created on Nov 7. Delete the customer if one exists.
