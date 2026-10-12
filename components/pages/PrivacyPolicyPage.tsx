import React from 'react';
import { SiteHeader } from '../landing/SiteHeader';
import { Footer } from '../landing/Footer';

export const PrivacyPolicyPage: React.FC = () => (
  <div className="min-h-screen bg-paper-50">
    <SiteHeader />
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink-900 mb-2">Privacy Policy</h1>
      <p className="text-sm text-ink-600 mb-8">Effective Date: February 7, 2026 &nbsp;·&nbsp; Last Updated: February 7, 2026</p>

      <div className="prose prose-slate max-w-none space-y-6 text-sm leading-relaxed text-ink-600">

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">1. Introduction</h2>
          <p>Evia ("we," "us," or "our") is committed to protecting your privacy. This Policy explains how we collect, use, and safeguard your information. We follow applicable privacy laws, including the California Consumer Privacy Act (CCPA) and the California Privacy Rights Act (CPRA).</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">2. Information We Collect</h2>
          <p><strong>From Clients/Families:</strong> Name, address, phone, email, date of birth, emergency contacts, health information, care needs, and payment information.</p>
          <p className="mt-2"><strong>From Care Providers:</strong> Name, address, phone, email, date of birth, services offered, rates, availability, a profile photo and bio, and the result of the background check (and driving record check, when Transportation is offered). Your Social Security Number and date of birth for the background check are entered on our background-check provider's own secure site and are not stored by Evia. Bank account details for payouts are held by Stripe, not by Evia.</p>
          <p className="mt-2"><strong>Automatically:</strong> IP address, device information, browser type, usage data, and cookies.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">3. Health-Related Information</h2>
          <p>Care plans you create may include health-related details: the type of care needed, daily routines, and notes you choose to add. We do not ask for medical records, medication lists, dosages or diagnoses, and our forms decline them. This information is encrypted in transit and at rest on Google Cloud, access to it is limited by role, and each view of it is logged. We do not use it for marketing. Evia is a non-medical care marketplace and does not claim certification under HIPAA.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">4. How We Use Your Information</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>Match clients with appropriate care providers</li>
            <li>Facilitate care scheduling and communication</li>
            <li>Process payments via Stripe</li>
            <li>Conduct care provider background checks via Checkr</li>
            <li>Provide customer support</li>
            <li>Comply with legal and regulatory requirements</li>
            <li>Send appointment reminders and care updates via SMS (with your consent)</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">5. SMS &amp; Text Messaging</h2>
          <p>When you provide consent during registration, Evia may send you SMS messages including appointment confirmations, care updates from our AI assistant Evia, health alerts, and service notifications. You may opt out at any time by texting STOP. We do not share your phone number with third parties for marketing purposes. Message frequency varies. Message and data rates may apply.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">6. Third-Party Services</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Stripe</strong> — Payment processing and identity verification</li>
            <li><strong>Checkr</strong> — Care provider background checks</li>
            <li><strong>Google Cloud / Firebase</strong> — Data storage and infrastructure</li>
            <li><strong>OpenAI, Google (Gemini) and Anthropic</strong> — the AI models behind Evia process the content of your conversations and the care details you share with her</li>
            <li><strong>Zep AI</strong> — Conversational memory for our AI care assistant</li>
            <li><strong>Linq / Apple Messages for Business</strong> — text and iMessage delivery</li>
            <li><strong>Resend</strong> — transactional email</li>
            <li><strong>Google Maps</strong> — geocoding of addresses for distance and matching</li>
            <li><strong>Sentry</strong> — error monitoring (page text is masked; your account id is attached to error reports)</li>
          </ul>
          <p className="mt-2">Our vendors are bound by contracts that require them to protect your information under applicable law.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">7. Location Data</h2>
          <p>We collect your zip code and city/state during signup to match you with care providers in your area. Precise geolocation is only used for care provider proximity matching and is not shared with other parties.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">8. Data Retention</h2>
          <p>We retain personal information for as long as your account is active or as needed to provide services. SMS consent records are retained for a minimum of 5 years, and access-audit records for 6 years. You may request deletion of your account data by messaging our team from your account (Message our team).</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">9. Your Rights (CCPA / CPRA)</h2>
          <p>California residents have the right to know what personal information we collect, request deletion of personal information, opt out of the sale of personal information (we do not sell personal information), and non-discrimination for exercising these rights. To exercise your rights, message our team from your account (Message our team).</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">10. Children's Privacy</h2>
          <p>Our Services are not directed to children under 13. We do not knowingly collect personal information from children under 13. If you believe we have inadvertently collected such information, please contact us immediately.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">11. Contact Us</h2>
          <p>General Support: message our team from your account (Message our team in the menu).</p>
          <p>Evia Inc. &nbsp;·&nbsp; www.eviacares.com</p>
        </section>

        <p className="text-xs text-ink-400 pt-4 border-t hairline">This Privacy Policy was last updated February 7, 2026. We will notify you of material changes by posting the updated Policy on our platform and updating the effective date.</p>
      </div>
    </main>
    <Footer />
  </div>
);

export default PrivacyPolicyPage;
