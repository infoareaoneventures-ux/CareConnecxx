import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { PRIMARY_SERVICES, serviceLabel } from "../components/caregiver/signup/constants";

// Public (logged-out) copy — the founder's standing wording rules (2026-10-04
// public-pages sweep, 2026-10-12 one-page rebuild). The landing page is the
// ONE public page: hero, "look into before you book", the eight services, a
// minimal footer. Everything it says must be something the product does.
//
//  - never "trusted / vetted / verified / approved / cleared / reliable / badge /
//    professional / trained / licensed / certified / specialized" toward users —
//    state the requirement instead ("completes a background check")
//  - the background-check provider (Checkr) MAY be named — the team confirmed the publicity terms 2026-10-12 (API agreement); before that it was banned
//  - no testimonials, ratings, counts, match-time or competitor-price claims
//  - nothing medical, no HIPAA claims
//  - prices come from utils/pricing.ts, never a hand-typed amount
//  - the removed placeholder pages stay removed (routes, components, links)

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
// The rules are about COPY: code comments explain the rules (and so name the
// banned words / removed pages) and import lines name modules, so both are
// stripped before matching.
const copyOf = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/^\s*import .*$/gm, "")
  .replace(/<!--[\s\S]*?-->/g, "");

const LANDING_FILES = [
  "components/LandingView.tsx",
  "components/landing/HeroSection.tsx",
  "components/landing/TrustSafetySection.tsx",
  "components/landing/ServicesSection.tsx",
  "components/landing/Footer.tsx",
  "components/NotFound.tsx",
  "components/SEO.tsx",
  "index.html",
];

const LEGAL_FILES = [
  "components/pages/PrivacyPolicyPage.tsx",
  "components/pages/TermsOfServicePage.tsx",
];

// Words that make a claim about a person or the service. "approved" is listed
// too: the landing page never calls a caregiver approved — the gate states the
// requirement instead.
const BANNED_WORDS = /\b(trusted|vetted|verified|approved|cleared|reliable|badge|professional|trained|licensed|certified|specialized|specialised)\b/i;
const PROVIDER = /\bcheckr\b/i;
const CLAIMS = [
  /\bHIPAA\b/i,
  /aggregateRating|ratingValue|reviewCount/,
  /\bVerified Family\b/i,
  /responds? in \d+/i,
  /within \d+[-–]\d+ hours/i,
  /\bagenc(y|ies)\b/i,            // competitor-price comparisons
  /\b\d+-step screening\b/i,
  /\bsame-day\b/i,
];
const MEDICAL = /\b(diagnos\w*|symptom\w*|treat(ment|s|ed|ing)?|administer\w*(?! or manage medication)|nurs(e|ing)|clinical|home health aide|Alzheimer)/i;

describe("the one public page says only what the product does", () => {
  for (const rel of LANDING_FILES) {
    it(`${rel}: no banned words, no provider name, no claims, nothing medical`, () => {
      const copy = copyOf(read(rel));
      expect(copy.match(BANNED_WORDS), `${rel} banned word`).toBeNull();
      // The provider name is allowed on public copy since 2026-10-12 (the team confirmed the publicity terms).
      void PROVIDER;
      for (const c of CLAIMS) expect(copy.match(c), `${rel} claim ${c}`).toBeNull();
      expect(copy.match(MEDICAL), `${rel} medical wording`).toBeNull();
    });
  }

  it("the hero's small line takes both figures from utils/pricing.ts — no hand-typed amount anywhere on the page", () => {
    const hero = read("components/landing/HeroSection.tsx");
    expect(hero).toContain("CLIENT_MONTHLY_PRICE");
    expect(hero).toContain("CAREGIVER_ANNUAL_PRICE");
    expect(hero).toMatch(/\/month, cancel anytime/);
    expect(hero).toMatch(/background check required/);
    for (const rel of LANDING_FILES) {
      expect(read(rel), `${rel} hand-typed price`).not.toMatch(/\$\s?\d+(\.\d\d)?\s*(\/|\s?(a|per)\s)(mo|month|yr|year|hr|hour)/i);
    }
    const pricing = read("utils/pricing.ts");
    expect(pricing).toMatch(/export const CLIENT_MONTHLY_PRICE = 29\.95;/);
    expect(pricing).toMatch(/export const CAREGIVER_ANNUAL_PRICE = 69\.99;/);
  });

  it("the trust section lists only what happens: background check, optional interview, Stripe, text", () => {
    const src = copyOf(read("components/landing/TrustSafetySection.tsx"));
    expect(src).toContain("Every care provider completes a background check before families can book them.");
    expect(src).toContain("Annual background check by Checkr"); // provider named since 2026-10-12 (team confirmed)
    expect(src).toContain("Interview before you book"); // the parenthetical came out 2026-10-12 (founder)
    expect(src).toContain("Payments through Stripe");
    expect(src).toContain("Everything coordinated by text");
    expect(src).not.toMatch(/profile review/i);
    expect(src).not.toMatch(/Trust and Safety Center/i);
  });

  it("the services section is the caregiver profile's eight, by display label, nothing invented", () => {
    const src = read("components/landing/ServicesSection.tsx");
    expect(src).toContain("from '../caregiver/signup/constants'");
    for (const name of PRIMARY_SERVICES) expect(src, name).toContain(`'${name}'`);
    expect(serviceLabel("Medication Reminders")).toBe("Medication Reminders Only");
    for (const invented of ["Respite Care", "Overnight", "24/7", "Companion Care", "Alzheimer"]) {
      expect(src, invented).not.toContain(invented);
    }
    // Medication Reminders Only = reminders, never administering or managing.
    expect(src).toMatch(/never administer or manage medication/);
  });

  it("the footer is the mark, one line, the help phone and six links", () => {
    const src = copyOf(read("components/landing/Footer.tsx"));
    for (const label of [">Privacy<", ">Terms<", ">Log in<", ">Find care<", ">Apply as a care provider<", ">Admin<"]) expect(src).toContain(label);
    expect(src).not.toMatch(/Twitter|Facebook|Instagram|For Families|For Caregivers|For Care Providers|Family FAQ|Help Center|How It Works|LegalDocs/);
    expect(src).toContain("supportPhone"); // the help phone lives in the footer (2026-10-12)
  });

  it("the site header is Log in + Get started only (shared by every pre-login page), and the removed sections are not rendered", () => {
    const header = read("components/landing/SiteHeader.tsx");
    expect(header).not.toMatch(/Find Care|For Caregivers|For Care Providers|Find Jobs|>Help</);
    for (const label of ["Apply as a care provider", "Log in", "Find care"]) expect(header).toContain(label);
    expect(header).not.toContain("Get started"); // the family door is named (founder, 2026-10-12)
    for (const page of ["components/auth/TaskPageBar.tsx", "components/pages/PrivacyPolicyPage.tsx", "components/pages/TermsOfServicePage.tsx"]) expect(read(page)).toContain("SiteHeader");
    for (const page of ["components/auth/LoginPage.tsx", "components/auth/onboarding/OnboardingFlow.tsx", "components/pages/PrivacyPolicyPage.tsx", "components/pages/TermsOfServicePage.tsx"]) expect(read(page)).toContain("<Footer />");
    const src = read("components/LandingView.tsx");
    expect(src).toContain("<SiteHeader />");
    expect(src).not.toMatch(/FeaturedCaregiversSection|FeaturesSection|FAQSection|BlogSection|StatsBar|CaregiverSection|MobileStickyCTA|generateFAQSchema/);
  });
});

describe("the placeholder public pages stay removed", () => {
  const REMOVED_FILES = [
    "components/HelpCenter.tsx",
    "components/HelpPage.tsx",
    "components/FamilyFAQ.tsx",
    "components/TrustAndSafetyPage.tsx",
    "components/HowItWorks.tsx",
    "components/Subscription.tsx",
    "components/LegalDocs.tsx",
    "components/pages/BlogPage.tsx",
    "components/pages/CityPage.tsx",
    "utils/blogData.ts",
    "utils/cityData.ts",
    "components/landing/FeaturedCaregiversSection.tsx",
    "components/landing/FeaturesSection.tsx",
    "components/landing/FAQSection.tsx",
    "components/landing/BlogSection.tsx",
    "components/landing/StatsBar.tsx",
    "components/landing/CaregiverSection.tsx",
    "components/landing/MobileStickyCTA.tsx",
    "components/landing/IMessageSignupPage.tsx",
  ];
  it("the files are gone", () => {
    expect(REMOVED_FILES.filter(exists)).toEqual([]);
  });

  it("App.tsx has no route for them (unknown paths fall through to NotFound)", () => {
    const app = read("App.tsx");
    for (const route of ["/help", "/family-faq", "/trust", "/how-it-works", "/blog", "/care/:city", "/pricing"]) {
      expect(app, route).not.toContain(`path="${route}`);
    }
    expect(app).toContain('<Route path="*" element={<NotFound');
  });

  it("the view names are gone from ViewType", () => {
    const types = read("types.ts");
    for (const v of ["how-it-works", "trust", "subscription", "family-faq", "help-center", "help-families", "help-caregivers", "help-general"]) {
      expect(types, v).not.toContain(`'${v}'`);
    }
  });

  it("nothing on the site or in Evia's functions links to a removed path", () => {
    const REMOVED_LINK = /["'`]\/(family-faq|trust|how-it-works|blog|pricing|help(\/(families|caregivers|general))?|care\/[a-z-]+)(\?[^"'`]*)?["'`]/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "lib" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|js|json|html)$/.test(e.name) || /\.(test|spec)\./.test(e.name)) continue;
        // Comments are stripped: Evia's `/help` CHAT COMMAND is documented in
        // comments and is not a page link.
        if (REMOVED_LINK.test(copyOf(fs.readFileSync(full, "utf8")))) offenders.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    };
    for (const d of ["components", "context", "hooks", "services", "utils", "public", "functions/src"]) walk(path.join(ROOT, d));
    for (const f of ["App.tsx", "index.html", "firebase.json"]) if (REMOVED_LINK.test(copyOf(read(f)))) offenders.push(f);
    expect(offenders).toEqual([]);
  });

  it("robots.txt and the sitemap no longer advertise them", () => {
    const robots = read("public/robots.txt");
    const sitemap = read("public/sitemap.xml");
    for (const p of ["/how-it-works", "/pricing", "/trust", "/blog", "/care/", "/family-faq", "/help", "/insurance"]) {
      expect(robots, p).not.toContain(`Allow: ${p}`);
      expect(sitemap, p).not.toContain(`eviacares.com${p}`);
    }
    expect(sitemap).toContain("https://www.eviacares.com/</loc>");
  });
});

describe("Privacy and Terms", () => {
  for (const rel of LEGAL_FILES) {
    it(`${rel}: no suppressed support inbox, no HIPAA claim`, () => {
      const src = read(rel);
      expect(src).not.toMatch(/mailto:/);
      expect(src).not.toMatch(/support@eviacares\.com/);
      expect(src).toMatch(/message our team from your account/);
      // The only HIPAA sentence allowed is the disclaimer ("does not claim certification under HIPAA").
      const hipaa = src.match(/[^.]*HIPAA[^.]*\./g) ?? [];
      for (const sentence of hipaa) expect(sentence).toMatch(/does not claim certification under HIPAA/);
      expect(src).not.toMatch(/HIPAA[- ]compliant|compl(y|ies|iance) with HIPAA|business associate/i);
    });
  }
});

// Founder's wording decision 2026-10-12: the person who gives care is a
// "care provider" everywhere a person reads it. Machine names (collections,
// fields, `userType: 'caregiver'`, identifiers, the `role=caregiver` value the
// server reads, component/file names) keep the old word — this rule is about
// COPY, so comments, imports and identifier/path/kebab contexts are excluded.
describe("the public page and the legal pages say \"care provider\", never \"caregiver\"", () => {
  const CAREGIVER_IN_COPY = /(?<![\w/\-])caregiv(?:er|ers|ing)(?![\w\-])/i;
  for (const rel of [...LANDING_FILES, ...LEGAL_FILES, "public/manifest.json", "public/sitemap.xml"]) {
    it(`${rel}: no "caregiver" in visible copy`, () => {
      expect(copyOf(read(rel)).match(CAREGIVER_IN_COPY), rel).toBeNull();
    });
  }

  it("the site's signup link says role=care-provider; /start still accepts role=caregiver for the links already texted", () => {
    expect(copyOf(read("App.tsx"))).not.toMatch(/\/start\?role=caregiver\b/);
    expect(read("public/sitemap.xml")).toContain("/start?role=care-provider");
    const start = read("components/auth/PhoneSignupPage.tsx");
    expect(start).toContain("'care-provider': 'caregiver'");
    expect(start).toContain("caregiver: 'caregiver'");
  });

  it("the caregiver pages live under /care-provider/, the old /caregiver/* addresses redirect, and the bell map uses the new prefix", () => {
    // The redirect lines are checked on the raw source: copyOf() would read the `/*` in the
    // catch-all path as a comment opener.
    const rawApp = read("App.tsx");
    expect(rawApp).toContain('<Route path="/caregiver/*" element={<LegacyCaregiverRedirect />} />');
    expect(rawApp).toContain('<Route path="/caregiver" element={<LegacyCaregiverRedirect />} />');
    // The family's two provider addresses moved too (/client/find-care-providers, /client/care-provider/:caregiverId) — the old ones redirect.
    expect(rawApp).toContain('<Route path="/client/find-care-providers" element={<ClientRoute element={<FindCaregivers />} />} />');
    expect(rawApp).toContain('<Route path="/client/care-provider/:caregiverId" element={<ClientRoute element={<ClientCaregiverProfile />} />} />');
    expect(rawApp).toContain('<Route path="/client/find-caregivers" element={<LegacyClientCaregiverRedirect />} />');
    expect(rawApp).toContain('<Route path="/client/caregiver/*" element={<LegacyClientCaregiverRedirect />} />');
    const app = rawApp.split('path="/caregiver/*"').join('path="LEGACY_CATCH_ALL"');
    // Every other caregiver route is under the new prefix — no page is still served at /caregiver/<page>.
    expect(app.match(/path="\/caregiver\/(?!\*")/g)).toBeNull();
    for (const page of ["dashboard", "profile", "inbox", "calendar", "bookings", "jobs", "families", "settings", "payments", "connect"]) {
      expect(app, page).toContain(`path="/care-provider/${page}"`);
    }
    const routes = copyOf(read("utils/notificationRoutes.ts"));
    const caregiverSide = routes.slice(routes.indexOf("function caregiverRoute"));
    expect(caregiverSide.match(/['"`]\/care-provider\//g)?.length ?? 0).toBeGreaterThan(0);
    expect(caregiverSide).not.toMatch(/['"`]\/caregiver\//);
  });
});
