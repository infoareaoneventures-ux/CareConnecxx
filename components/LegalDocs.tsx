
import React from 'react';
import { X, Shield, Lock, FileText } from 'lucide-react';

interface LegalDocsProps {
  type: 'privacy' | 'terms';
  onClose: () => void;
}

export const LegalDocs: React.FC<LegalDocsProps> = ({ type, onClose }) => {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white w-full max-w-2xl h-[80vh] rounded-3xl shadow-xl flex flex-col overflow-hidden animate-slide-in">
        <div className="p-6 border-b hairline flex justify-between items-center bg-paper-100">
           <div className="flex items-center gap-3">
              <div className="bg-white border hairline p-2 rounded-full text-ink-900">
                 {type === 'terms' ? <FileText className="w-6 h-6" /> : <Lock className="w-6 h-6" />}
              </div>
              <div>
                 <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">
                    {type === 'terms' ? 'Terms of Service' : 'Privacy Policy'}
                 </h2>
                 <p className="text-xs text-ink-600">Last updated: April 2026</p>
              </div>
           </div>
           <button onClick={onClose} className="p-2.5 hover:bg-paper-200 rounded-full transition-colors">
              <X className="w-6 h-6 text-ink-600" />
           </button>
        </div>

        <div className="flex-grow overflow-y-auto p-8 text-ink-600 text-sm leading-relaxed space-y-6">
           {type === 'terms' ? (
             <>
               <p><strong>1. Acceptance of Terms</strong><br/>By accessing Evia, you agree to be bound by these Terms of Service. If you do not agree, you may not use the platform.</p>

               <p><strong>2. Nature of Platform</strong><br/>Evia is a venue connecting independent Caregivers with Clients. We are not an employer. Caregivers are independent contractors who set their own rates and schedules.</p>

               <p><strong>3. Trust & Safety</strong><br/>We perform background checks via Checkr and identity verification via Stripe Identity. We do not guarantee the conduct of any user. Users are responsible for their interactions and should exercise appropriate caution.</p>

               <p><strong>4. Payments & Fees</strong><br/>Clients are charged via Stripe after approving the caregiver's submitted hours (or when the review window closes). Evia adds a service fee to each visit's charge. A visit cancelled before it starts is not charged. Caregivers receive payouts via Stripe Connect.</p>

               <p><strong>5. Medical Disclaimer</strong><br/>Caregivers provide non-medical assistance unless specifically licensed (e.g., RN). This platform does not provide medical advice. Always consult a qualified healthcare professional for medical concerns.</p>

               <p><strong>6. Account Termination</strong><br/>We reserve the right to suspend or terminate accounts that violate these terms, abuse the platform, or pose a safety risk to other users.</p>

               <p><strong>7. Limitation of Liability</strong><br/>Evia is not liable for damages arising from interactions between users on the platform. Our total liability is limited to fees paid to us in the prior 12 months.</p>

               <p><strong>8. Governing Law</strong><br/>These terms are governed by the laws of the State of California. Any disputes shall be resolved in the courts of Santa Clara County, California.</p>
             </>
           ) : (
             <>
               <p><strong>1. Information Collection</strong><br/>We collect personal information such as name, email, phone, address, and care needs to facilitate care matching. Caregivers provide additional information for background verification.</p>

               <p><strong>2. Health Information</strong><br/>Care plan and health-related data is encrypted at rest in Google Cloud Firestore. Access is restricted to authorized parties (the client, their assigned caregiver, and verified care coordinators).</p>

               <p><strong>3. Third-Party Services</strong><br/>We share necessary information with: Stripe (payments + identity verification), Checkr (background checks), Google Cloud (hosting + database). We do not sell your data to advertisers.</p>

               <p><strong>4. Location Data</strong><br/>For shift verification, we capture Caregiver location only at clock-in and clock-out events during active shifts. We do not continuously track location.</p>

               <p><strong>5. Communications</strong><br/>Messages between users are stored to provide the chat feature. Push notifications and email require your explicit opt-in.</p>

               <p><strong>6. Data Retention</strong><br/>We retain account data for as long as your account is active. After account deletion, financial records are retained per IRS requirements (7 years); other personal data is purged within 90 days.</p>

               <p><strong>7. Your Rights</strong><br/>You can access, correct, or delete your personal information at any time from your account settings, or by contacting support@eviacares.com.</p>

               <p><strong>8. Children's Privacy</strong><br/>Evia is not directed at children under 18. We do not knowingly collect information from minors.</p>

               <p><strong>9. Contact</strong><br/>For privacy questions, contact support@eviacares.com.</p>
             </>
           )}
        </div>

        <div className="p-6 border-t hairline bg-paper-100 flex justify-end">
           <button
             onClick={onClose}
             className="btn-depth-primary rounded-full px-6 py-2.5 min-h-[44px] font-semibold text-[15px] transition-colors"
           >
             I Understand
           </button>
        </div>
      </div>
    </div>
  );
};
