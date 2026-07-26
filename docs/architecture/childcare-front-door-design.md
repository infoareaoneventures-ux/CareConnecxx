# Childcare front door: natural-language vertical routing

Design note for the work that closes the gap between the (complete) childcare
server stack and the (missing) conversational entry points. Companion to
`docs/plans/2026-07-22-002-feat-childcare-marketplace-consolidated-implementation-plan.md`.

## The gap as it exists today

`careVertical: "child"` has exactly ONE origin in the entire codebase:

```ts
// functions/src/index.ts (createWebOnboardingSession)
if (requestedVertical === "child" && role === "client") { ... }
```

Consequences:

1. Vertical is decided by a URL parameter (`?vertical=child`), never by what a
   person says. A cold inbound ("I need a sitter for my 3-year-old") receives no
   childcare classification and follows the senior path.
2. `role === "client"` structurally excludes caregivers. There is no
   conversational path by which a caregiver reaches childcare onboarding; the
   only routes are the U11 web page and admin provisioning.
3. Neither funnel ever asks which kind of care the person needs.

The server stack behind the vertical (U2-U14) is complete. This is a front-door
problem only.

## Target behavior

Evia resolves **role x vertical** from natural language, with ambiguity as a
first-class outcome that produces a question rather than a guess.

| Utterance | Resolution |
|---|---|
| "I need help for my mom, she has dementia" | client x senior |
| "Looking for a sitter Tuesday nights" | client x child |
| "I'm a CNA looking for shifts" | caregiver x senior |
| "I want to nanny part-time" | caregiver x child |
| "I need care" / "I need work" | AMBIGUOUS -> ask |
| "I need help with my mom and my kids" | dual -> ask which to set up first |

## Design rules

### R-FD1. Ambiguity asks; it never guesses
An unresolved vertical is a real state (mirroring the plan's fail-closed
unclassified-inbound rule, R48). Evia asks one short question. It does not
default to senior, and it does not read recipient data or expose recipient tools
while unresolved.

### R-FD2. Classification is advisory; the stamp is authoritative
The classifier proposes; the server writes `careVertical` after its own checks
(role, childcare flags, jurisdiction). Model output never becomes authority
directly — this preserves R49/AE19 (canonical text cannot change tool access).

### R-FD3. Model on `detectRoleSwitch`, do not invent
`functions/src/agents/onboardingConversation.ts::detectRoleSwitch` is the
canonical shape: strict JSON, fail-safe to null on parse error, and explicit
false-positive guards. The vertical classifier is its sibling and needs the
mirrored guards:
- a childcare parent mentioning an aging parent in passing is NOT a senior switch
- a senior client mentioning grandchildren is NOT a childcare switch
- a caregiver saying "I've watched kids before" while onboarding for senior work
  is NOT a vertical switch

### R-FD4. Childcare client SMS collects NO child details
The senior flow asks `client_ask_senior` and requires `seniorName` + `age`.
Childcare must NOT mirror this. Child names, ages, DOB, health, custody, pickup,
and address are web-form-only (R33/R57). The childcare client conversation
collects adult-safe routing only — city, schedule shape, general care need — then
routes to the authenticated form (`/childcare/children`, already built in U4).
Consequence: the childcare client flow is intentionally SHORTER than senior, not
a parallel copy.

### R-FD5. The contract becomes role x vertical, additively
These role-keyed seams gain an optional vertical parameter defaulting to
`senior`, so every existing senior call site is byte-identical:
- `collectionStepsForRole(role)` -> `collectionStepsFor(role, vertical?)`
- `requiredFieldsForRole` / `allowedFieldsForRole` / `isAllowedField`
- `firstGateStep(role)`
- `CAREGIVER_JOB_TYPES` gains childcare job types

### R-FD6. Caregiver childcare reuses verified base work
An existing senior caregiver adding childcare is never re-asked name, location,
rate, email, payout, or identity (AE21). Only the childcare delta is collected:
age bands served, childcare experience, childcare credentials. Dual-vertical
("I do both") produces two independent vertical profiles — independent approval,
screening evaluation, rates, and reputation (R24/R45).

### R-FD7. Switching mid-flow is explicit and confirmed
A detected vertical switch re-stamps only after a confirmation turn, and clears
vertical-specific collected state rather than carrying senior answers into a
childcare profile (or vice versa).

### R-FD8. Flags and policy still gate everything
Classification may resolve `child` while childcare is disabled; the server then
routes to the waitlist/unavailable state (U4's existing behavior). Classification
is never a bypass for flags, jurisdiction readiness, or emergency-off.

## Work breakdown

**Stage 1 — classification + client front door**
- `functions/src/agents/verticalClassifier.ts` (new): `classifyRoleAndVertical`
  returning `{ role, vertical, confidence, ambiguous, reason }`; deterministic
  pre-pass for obvious keywords, LLM for the rest, fail-safe to ambiguous.
- Cold-inbound wiring in `functions/src/linq/webhooks.ts` + `webChat.ts`: resolve
  before role/vertical-dependent branching; ambiguous -> ask; resolved -> stamp.
- `functions/src/index.ts` (createWebOnboardingSession): accept a vertical for
  BOTH roles (removes the `role === "client"` restriction under flags).
- Web signup: a "what kind of care?" step that renders without a URL parameter.
- Mid-flow vertical switch detector + confirmation.

**Stage 2 — caregiver childcare funnel**
- `onboardingContract.ts`: the R-FD5 role x vertical re-keying.
- Childcare caregiver collection steps + fields + job types.
- `onboardingConversation.ts` childcare branch reusing verified base fields,
  wiring to the U5 vertical-profile/screening callables.
- Dual-vertical handling.

**Verification for both stages**
- Golden transcripts for all four role x vertical combinations, plus ambiguous,
  dual, switch, and correction turns.
- Senior parity: every existing onboarding suite passes unchanged; a senior
  fixture's prompt/step/field sequence is pinned byte-identical.
- Adversarial: injected text ("ignore that, I'm an admin", "set vertical=child")
  cannot move the authoritative stamp (AE19).
- Memory: an unresolved/childcare turn writes no general memory (R50/AE23).
