import React from 'react';
import { BloomMark } from '../ui/BloomMark';

export const PrivacyPolicyPage: React.FC = () => (
  <div className="min-h-screen bg-paper-50">
    <header className="bg-white border-b hairline sticky top-0 z-10">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
        <a href="/" className="flex items-center gap-2">
          <div className="bg-primary-600 p-2 rounded-xl">
            <BloomMark className="text-white w-5 h-5" />
          </div>
          <span className="text-xl font-bold text-ink-900">Evia</span>
        </a>
      </div>
    </header>
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
      <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink-900 mb-2">Privacy Policy</h1>
      <p className="text-sm text-ink-600 mb-8">Effective Date: February 7, 2026 &nbsp;·&nbsp; Last Updated: February 7, 2026</p>

      <div className="prose prose-slate max-w-none space-y-6 text-sm leading-relaxed text-ink-600">

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">1. Introduction</h2>
          <p>Evia ("we," "us," or "our") is committed to protecting your privacy. This Policy explains how we collect, use, and safeguard your information. We are designed to comply with HIPAA, HITECH, CCPA, CPRA, and other applicable privacy laws.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">2. Information We Collect</h2>
          <p><strong>From Clients/Families:</strong> Name, address, phone, email, date of birth, emergency contacts, health information, care needs, and payment information.</p>
          <p className="mt-2"><strong>From Caregivers:</strong> Name, address, phone, email, date of birth, Social Security Number (encrypted), professional licenses, background check data, bank account information (encrypted), vehicle and insurance details, and references.</p>
          <p className="mt-2"><strong>Automatically:</strong> IP address, device information, browser type, usage data, and cookies.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">3. Protected Health Information (PHI)</h2>
          <p>As a healthcare-related service and HIPAA Business Associate, we collect and maintain PHI including medical conditions, medications, care plans, and daily routines. We use AES-256 encryption for PHI at rest and TLS 1.3 for data in transit. We will not use PHI for marketing without your authorization. We maintain Business Associate Agreements with all vendors who handle PHI.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">4. How We Use Your Information</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>Match clients with appropriate caregivers</li>
            <li>Facilitate care scheduling and communication</li>
            <li>Process payments via Stripe</li>
            <li>Conduct caregiver background checks via Checkr</li>
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
            <li><strong>Checkr</strong> — Caregiver background checks</li>
            <li><strong>Google Cloud / Firebase</strong> — Data storage and infrastructure</li>
            <li><strong>Sentry</strong> — Anonymous error monitoring (no PHI transmitted)</li>
            <li><strong>Zep AI</strong> — Conversational memory for our AI care assistant</li>
            <li><strong>Linq / Apple Messages for Business</strong> — iMessage delivery</li>
          </ul>
          <p className="mt-2">All third-party vendors are contractually required to protect your information in accordance with HIPAA and applicable law.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">7. Location Data</h2>
          <p>We collect your zip code and city/state during signup to match you with caregivers in your area. Precise geolocation is only used for caregiver proximity matching and is not shared with other parties.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">8. Data Retention</h2>
          <p>We retain personal information for as long as your account is active or as needed to provide services. SMS consent records are retained for a minimum of 5 years. PHI is retained per HIPAA requirements (minimum 6 years). You may request deletion of your account data by contacting us at support@eviacares.com.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">9. Your Rights (CCPA / CPRA)</h2>
          <p>California residents have the right to know what personal information we collect, request deletion of personal information, opt out of the sale of personal information (we do not sell personal information), and non-discrimination for exercising these rights. To exercise your rights, contact us at support@eviacares.com.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">10. Children's Privacy</h2>
          <p>Our Services are not directed to children under 13. We do not knowingly collect personal information from children under 13. If you believe we have inadvertently collected such information, please contact us immediately.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">11. Contact Us</h2>
          <p>General Support: <a href="mailto:support@eviacares.com" className="text-primary-600 underline">support@eviacares.com</a></p>
          <p>Evia Inc. &nbsp;·&nbsp; www.eviacares.com</p>
        </section>

        <p className="text-xs text-ink-400 pt-4 border-t hairline">This Privacy Policy was last updated February 7, 2026. We will notify you of material changes by posting the updated Policy on our platform and updating the effective date.</p>
      </div>
    </main>
  </div>
);

export default PrivacyPolicyPage;
