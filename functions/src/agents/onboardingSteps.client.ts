import { ConversationStep } from "./conversationStep";

/**
 * CLIENT_STEPS — the linear client onboarding questions as data.
 *
 * Each entry is a `ConversationStep` (see conversationStep.ts) that the `runStep`
 * runner drives through the CLAUDE.md checklist. This file owns ONLY the
 * per-step variation that used to differ between hand-written handlers: the
 * parse prompt, how the parser's raw output maps to stored `onboardingData`
 * fields (including derived top-level keys the matching engine reads), the
 * re-ask / retry text, the next step id, and the acknowledging next question.
 *
 * Every user-visible string here is copied VERBATIM from the former
 * `handleClientAsk*` handlers in onboardingConversation.ts. Changing any of
 * them changes what Evia says — that is a regression, not a refactor.
 *
 * Boundary: this table covers the ask-a-question / store-an-answer / ask-the-next
 * steps only. `client_ask_location` keeps its bespoke handler (reverse-geocode +
 * inbound location pin), and `client_confirm_intake` onward keep theirs too.
 *
 * The two helpers a step's `nextQuestion` needs (`generateCaraMessage`,
 * `locationPrompt`) are injected via `buildClientSteps` so this module stays
 * free of import cycles with onboardingConversation.ts. The `parse` functions
 * are pure and need no injection.
 */

export interface ClientStepDeps {
  /** Generate Evia's next line (ack + next question) — same call shape as before. */
  generateCaraMessage: (opts: {
    audience: "caregiver" | "family";
    context: string;
    fallback: string;
    maxTokens?: number;
    language?: "en" | "es";
    emotionalDirective?: string;
  }) => Promise<string>;
  /** Wrap a location ask with the "tap to share" affordance on iMessage/RCS. */
  locationPrompt: (base: string, service?: string) => string;
}

export function buildClientSteps(deps: ClientStepDeps): Record<string, ConversationStep> {
  const { generateCaraMessage, locationPrompt } = deps;

  return {
    // ── client_ask_name ─────────────────────────────────────────────────────────
    client_ask_name: {
      id: "client_ask_name",
      parsePrompt:
        "Extract the person's full name as given (first and last, if a last name was shared). Reply with just their name as typed, nothing else. If you cannot find a name, reply: unknown",
      parse(raw, session) {
        const safeName = (!raw || raw === "__parse_error__" || raw === "unknown") ? "there" : raw;
        if (safeName === "there") return null; // re-ask: "didn't catch your name"
        // Website parity: the /start form has separate First/Last name boxes —
        // split the same way here so a full name shared over SMS lands on the
        // same firstName/lastName fields, not just firstName.
        const [firstName, ...rest] = safeName.trim().split(/\s+/);
        const lastName = rest.join(" ") || undefined;
        // Self-seeker (set at the role step): the sender IS the care recipient —
        // mirror their FIRST name into the senior slot so "who are you caring
        // for" is never asked.
        if ((session.onboardingData?.relationship as string) === "self") {
          return { firstName, ...(lastName ? { lastName } : {}), seniorName: firstName };
        }
        return { firstName, ...(lastName ? { lastName } : {}) };
      },
      nextStep: (session) =>
        (session.onboardingData?.relationship as string) === "self"
          ? "client_ask_needs"
          : "client_ask_senior",
      reask: () => "What's your name?",
      retry: () => "I didn't catch your name — could you share it?",
      async nextQuestion(session) {
        const safeName = (session.onboardingData?.firstName as string) ?? "there";
        if ((session.onboardingData?.relationship as string) === "self") {
          return generateCaraMessage({
            audience: "family",
            context: `Evia just learned the name of someone looking for care for THEMSELVES: ${safeName}. You're mid-conversation — do NOT greet again. Speak to them directly ("you", never "your loved one"). Warmly acknowledge and ask how old they are and what kind of help would make day-to-day easier for them.`,
            fallback: `Nice to meet you, ${safeName}. How old are you, and what would you like a hand with day to day?`,
            maxTokens: 80,
          });
        }
        return generateCaraMessage({
          audience: "family",
          context: `Evia just learned the client's name is ${safeName}. You're mid-conversation — do NOT greet again (no "Hi"/"Hey ${safeName}"). Warmly acknowledge and ask who they're looking for care for (name and relationship to them, e.g. "my mom Dorothy").`,
          fallback: `Nice to meet you, ${safeName}. Who are we caring for?`,
          maxTokens: 80,
        });
      },
    },

    // ── client_ask_senior ───────────────────────────────────────────────────────
    client_ask_senior: {
      id: "client_ask_senior",
      parsePrompt:
        'Extract the senior\'s first name and the user\'s relationship to them from this message. ' +
        'If the message says the care is for the SENDER THEMSELVES ("me", "myself", "it\'s for me", "I need the care"), ' +
        'reply exactly: {"seniorName":"SELF","relationship":"self"}. ' +
        'If care is for MORE THAN ONE person (e.g. "my mom and dad", "both my parents", "mom Dorothy and dad Frank"), ' +
        'put the first person in seniorName/relationship and EVERY other person in additionalRecipients: ' +
        '{"seniorName":"...","relationship":"...","additionalRecipients":[{"name":"...","relationship":"..."}]}. ' +
        'Use the relationship words even when names are missing (e.g. "mom and dad" → seniorName "Mom", additional name "Dad"). ' +
        'Otherwise reply in JSON format: {"seniorName":"...","relationship":"..."}',
      parse(raw, session) {
        if (raw === "__parse_error__") return null; // re-ask: "didn't catch that"
        let parsed: { seniorName?: unknown; relationship?: unknown; additionalRecipients?: unknown };
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Parse failed → re-ask. Never persist a placeholder name: the old
          // "your loved one" default flowed verbatim to senior_profiles.name and
          // clientIntakes.recipientName.
          return null;
        }
        let seniorName   = String(parsed.seniorName   ?? "").trim();
        let relationship = String(parsed.relationship ?? "").trim();
        const additional: Array<{ name?: string; relationship?: string }> =
          Array.isArray(parsed.additionalRecipients)
            ? (parsed.additionalRecipients as Array<{ name?: string; relationship?: string }>)
            : [];
        // "It's for me" — the sender is the care recipient.
        if (seniorName === "SELF" || relationship === "self") {
          const own = (session.onboardingData?.firstName as string) || "you";
          return { seniorName: own, relationship: "self" };
        }
        // No identifiable recipient name → re-ask rather than storing a
        // placeholder as their real name.
        if (!seniorName) return null;
        if (!relationship) relationship = "family member"; // soft default — relationship is non-critical
        const extras = additional
          .map((r) => ({
            name:         String(r?.name ?? "").trim(),
            relationship: String(r?.relationship ?? "").trim(),
          }))
          .filter((r) => r.name && r.name.toLowerCase() !== seniorName.toLowerCase());
        return {
          seniorName,
          relationship,
          ...(extras.length ? { additionalRecipients: extras } : {}),
        };
      },
      nextStep: "client_ask_needs",
      reask: () => "Now, who are you looking for care for? (Their name and your relationship — or just say it's for you)",
      retry: () => "Now, who are you looking for care for? (Their name and your relationship, e.g. 'my mom Dorothy' — or just say it's for you)",
      async nextQuestion(session) {
        const seniorName   = (session.onboardingData?.seniorName as string)   ?? "your loved one";
        const relationship = (session.onboardingData?.relationship as string) ?? "family member";
        if (relationship === "self") {
          return generateCaraMessage({
            audience: "family",
            context: `Evia is onboarding someone looking for care for THEMSELVES (${seniorName}). Speak to them directly ("you", never third person). Ask how old they are and what kind of help would make day-to-day easier for them.`,
            fallback: `Got it — I'd love to help you directly. How old are you, and what would you like a hand with day to day?`,
            maxTokens: 80,
          });
        }
        const extraRecipients = Array.isArray(session.onboardingData?.additionalRecipients)
          ? (session.onboardingData!.additionalRecipients as Array<{ name?: string }>)
              .map((r) => r?.name).filter(Boolean)
          : [];
        if (extraRecipients.length) {
          const everyone = [seniorName, ...extraRecipients].join(" and ");
          return generateCaraMessage({
            audience: "family",
            context: `Evia is onboarding a family caring for MULTIPLE loved ones: ${everyone}. Acknowledge warmly that you'll set things up for both/all of them, then ask how old each of them is and what kind of help each needs these days.`,
            fallback: `Got it — care for ${everyone}. How old is each of them, and what does each need help with these days?`,
            maxTokens: 90,
          });
        }
        return generateCaraMessage({
          audience: "family",
          context: `Evia is onboarding a family. They just said they're looking for care for ${seniorName} (their ${relationship}). Ask how old ${seniorName} is and what kind of help they need these days.`,
          fallback: `Got it. How old is ${seniorName}, and what do they need help with these days?`,
          maxTokens: 80,
        });
      },
    },

    // ── client_ask_needs ──────────────────────────────────────────────────────────
    client_ask_needs: {
      id: "client_ask_needs",
      parsePrompt:
        'Extract age (as number) and careNeeds (array of strings — day-to-day help needed, NOT diagnoses) from this message. ' +
        'If ages for MULTIPLE people are given (e.g. "mom is 82 and dad is 85"), also include ' +
        '"recipientAges":[{"name":"...","age":0}] with one entry per named person. ' +
        'Reply in JSON: {"age":0,"careNeeds":[]}',
      parse(raw, session) {
        if (raw === "__parse_error__") return null; // re-ask: "didn't catch that"
        let parsed: { age?: unknown; careNeeds?: unknown; recipientAges?: unknown };
        try {
          parsed = JSON.parse(raw);
        } catch {
          return null; // parse failed → re-ask instead of advancing with empty needs
        }
        const rawAge      = Number(parsed.age);
        const age         = Number.isFinite(rawAge) && rawAge > 0 ? rawAge : undefined;
        const careNeeds   = Array.isArray(parsed.careNeeds)  ? (parsed.careNeeds  as string[]) : [];
        const recipientAges: Array<{ name?: string; age?: number }> =
          Array.isArray(parsed.recipientAges) ? (parsed.recipientAges as Array<{ name?: string; age?: number }>) : [];

        // careNeeds is the REQUIRED field this step exists to collect. If the
        // message had nothing needs-shaped (auto-skip loop landed here off a
        // front-loaded age, or the answer was only an age), re-ask instead of
        // advancing with empty needs — mirrors the client_ask_schedule guard.
        if (careNeeds.length === 0) return null;

        // Multi-recipient household: route each named age to the right person —
        // primary keeps top-level `age`, everyone else's lands on their entry in
        // additionalRecipients (finalization writes one senior profile per person).
        const existingExtras = Array.isArray(session.onboardingData?.additionalRecipients)
          ? (session.onboardingData!.additionalRecipients as Array<{ name?: string; relationship?: string; age?: number }>)
          : [];
        if (existingExtras.length && recipientAges.length) {
          const primaryName = String(session.onboardingData?.seniorName ?? "").toLowerCase();
          const patched = existingExtras.map((r) => {
            const match = recipientAges.find(
              (a) => String(a?.name ?? "").toLowerCase() === String(r?.name ?? "").toLowerCase(),
            );
            const matchedAge = Number(match?.age);
            return Number.isFinite(matchedAge) && matchedAge > 0 ? { ...r, age: matchedAge } : r;
          });
          const primaryMatch = recipientAges.find(
            (a) => String(a?.name ?? "").toLowerCase() === primaryName,
          );
          const primaryAge = Number(primaryMatch?.age);
          const resolvedAge = Number.isFinite(primaryAge) && primaryAge > 0 ? primaryAge : age;
          return {
            ...(resolvedAge !== undefined ? { age: resolvedAge } : {}),
            careNeeds,
            additionalRecipients: patched,
          };
        }
        return { ...(age !== undefined ? { age } : {}), careNeeds };
      },
      nextStep: "client_ask_location",
      reask(session) {
        const d = session.onboardingData ?? {};
        return `How old is ${d.seniorName ?? "your loved one"}, and what kind of help do they need?`;
      },
      // Reached when parse returns null (parse error or no care needs extracted).
      retry(session) {
        const d = session.onboardingData ?? {};
        return `How old is ${d.seniorName ?? "your loved one"}, and what kind of help do they need?`;
      },
      async nextQuestion(session) {
        const d = session.onboardingData ?? {};
        const seniorName = d.seniorName;
        const careNeeds  = (d.careNeeds  as string[]) ?? [];
        const condLabel = careNeeds.length > 0 ? careNeeds.join(", ") : "";
        const msg = await generateCaraMessage({
          audience: "family",
          context:
            `Evia is collecting onboarding info for a family caring for ${seniorName ?? "their loved one"}. ` +
            `They just shared the care situation${condLabel ? ` (${condLabel})` : ""}. ` +
            `If the situation is emotionally heavy (memory care, a serious diagnosis, or the family sounds worried), ` +
            `acknowledge that weight warmly in one short sentence first — no platitudes, no clinical hedging. ` +
            `Then ask what city and zip code ${seniorName ?? "they"} lives in so you can find specialists nearby.`,
          fallback: `And where does ${seniorName ?? "they"} live?`,
          emotionalDirective: (session as any)._emotionalDirective,
          maxTokens: 120,
        });
        return locationPrompt(msg, session.service);
      },
    },

    // ── client_ask_schedule ────────────────────────────────────────────────────────
    client_ask_schedule: {
      id: "client_ask_schedule",
      parsePrompt:
        'Extract daysPerWeek (number), timeOfDay (morning/afternoon/evening/all-day), and hoursPerDay (number) from this message. Reply in JSON: {"daysPerWeek":0,"timeOfDay":"","hoursPerDay":0}',
      parse(raw) {
        if (raw === "__parse_error__") return null; // re-ask: "didn't catch that"
        let daysPerWeek = 0, timeOfDay = "", hoursPerDay = 0;
        try {
          const parsed = JSON.parse(raw);
          daysPerWeek = Number(parsed.daysPerWeek) || 0;
          timeOfDay   = (parsed.timeOfDay ?? "") as string;
          hoursPerDay = Number(parsed.hoursPerDay) || 0;
        } catch { return null; }
        // Nothing schedule-shaped in the message (happens when the auto-skip
        // loop lands here off an unrelated front-loaded answer) — re-ask
        // instead of fabricating a default schedule.
        if (!daysPerWeek && !timeOfDay) return null;
        return {
          daysPerWeek: daysPerWeek || 3,
          timeOfDay:   timeOfDay   || "mornings",
          hoursPerDay: hoursPerDay || 4,
        };
      },
      // Collection ends here → the intake playback/confirmation step (the legacy
      // client_ask_start/preferences/budget steps were removed: the site's
      // wizard never collected them).
      nextStep: "client_confirm_intake",
      reask(session) {
        const d = session.onboardingData ?? {};
        return `How often does ${d.seniorName ?? "they"} need someone, and what times of day work best?`;
      },
      retry: () => "Hmm, I didn't catch that. What days and hours do you need care? (e.g. \"Mon–Fri, 9am to 3pm\" or \"3 days a week, mornings\")",
      async nextQuestion(session) {
        const dSched = session.onboardingData ?? {};
        const seniorSched = (dSched.seniorName as string) ?? "your loved one";
        return generateCaraMessage({
          audience: "family",
          context: `Evia is onboarding a family for ${seniorSched}. They just gave their schedule. Acknowledge it in one short line, then ask when they'd like care to start — right away, or a specific date.`,
          fallback: `Got it. And when would you like care to start for ${seniorSched} — right away, or a specific date?`,
          emotionalDirective: (session as any)._emotionalDirective,
          maxTokens: 90,
        });
      },
    },
  };
}
