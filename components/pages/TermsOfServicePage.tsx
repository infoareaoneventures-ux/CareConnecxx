import React from 'react';
import { BloomMark } from '../ui/BloomMark';

export const TermsOfServicePage: React.FC = () => (
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
      <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink-900 mb-2">Terms of Service</h1>
      <p className="text-sm text-ink-600 mb-8">Effective Date: February 7, 2026 &nbsp;·&nbsp; Version 1.0</p>

      <div className="prose prose-slate max-w-none space-y-6 text-sm leading-relaxed text-ink-600">

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">1. Agreement to Terms</h2>
          <p>By accessing or using the Evia platform, website, and services (collectively, the "Services"), you agree to be bound by these Terms of Service. If you do not agree to these Terms, do not use our Services.</p>
          <p className="mt-2 font-medium">These Terms include a mandatory arbitration agreement and class action waiver in Section 17. Please read carefully.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">2. Platform Nature</h2>
          <p>Evia operates a technology platform that matches clients with caregivers. <strong>Caregivers are independent contractors, not employees of Evia.</strong> We facilitate connections but do not employ caregivers, provide medical care, or guarantee the quality of care provided.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">3. Trust &amp; Safety</h2>
          <p>All caregivers undergo criminal background checks, sex offender registry checks, reference checks, and credential verification via Checkr. Background checks have limitations — they may not reveal all criminal history and are point-in-time checks. We recommend you interview caregivers before hiring and start with shorter visits to build trust.</p>
          <p className="mt-2">Client identity may be verified via Stripe Identity for fraud prevention purposes.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">4. Payments &amp; Fees</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>All payments are processed through Stripe. Client credit cards are charged after service completion.</li>
            <li>Caregivers receive payment after service is confirmed. A platform fee is retained by Evia.</li>
            <li><strong>Cancellation policy:</strong> 24+ hours: full refund; 12–24 hours: 50% refund; &lt;12 hours: no refund (caregiver compensated); no-show: full charge.</li>
            <li>Payment disputes must be submitted within 48 hours of service completion.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">5. SMS &amp; Electronic Communications</h2>
          <p>By providing your phone number and checking the SMS consent box during registration, you expressly consent to receive text messages (SMS/MMS) from Evia and its AI care assistant at the number provided. This includes appointment reminders, care updates, and service notifications. Message and data rates may apply. You may opt out at any time by replying STOP. Message frequency varies.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">6. HIPAA Compliance &amp; Privacy</h2>
          <p>Evia complies with HIPAA and maintains appropriate safeguards for Protected Health Information (PHI). We maintain Business Associate Agreements with all vendors who handle PHI. By using our Services, you authorize Evia to share necessary information with matched caregivers and process information for payment and operations.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">7. Medical Disclaimer</h2>
          <p>Information on the Platform is not medical advice. Evia does not provide clinical services or act as a healthcare provider. Always consult qualified healthcare professionals for medical decisions. For any medical emergency, call 911 immediately.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">8. Limitation of Liability</h2>
          <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW: Evia is not liable for caregiver actions, injuries during care, or property damage. Evia's total liability is limited to fees paid in the last 12 months. The Platform is provided "AS IS" without warranties of any kind.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">9. Account Termination</h2>
          <p>We may suspend or terminate your account for violation of these Terms, fraud, safety concerns, non-payment, or inactivity. You may terminate your account at any time by contacting support. Outstanding payment obligations survive termination.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">10. Governing Law &amp; Dispute Resolution</h2>
          <p>These Terms are governed by the laws of the State of Illinois. Before filing a claim, contact us at support@eviacares.com. Any unresolved dispute will be resolved through binding arbitration administered by the AAA in Chicago, Illinois. <strong>YOU AGREE TO BRING CLAIMS ONLY IN YOUR INDIVIDUAL CAPACITY</strong> and not as a plaintiff or class member in any class proceeding.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">11. Changes to These Terms</h2>
          <p>We may modify these Terms at any time. We will post updated Terms on the Platform and notify you of material changes. Your continued use after changes indicates acceptance.</p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-900 mb-2">12. Contact</h2>
          <p>Evia &nbsp;·&nbsp; <a href="mailto:support@eviacares.com" className="text-primary-600 underline">support@eviacares.com</a></p>
        </section>

        <p className="text-xs text-ink-400 pt-4 border-t hairline">BY USING EVIA SERVICES, YOU ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND AGREE TO BE BOUND BY THESE TERMS OF SERVICE.</p>
      </div>
    </main>
  </div>
);

export default TermsOfServicePage;
