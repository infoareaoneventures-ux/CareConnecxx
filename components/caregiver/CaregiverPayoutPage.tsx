import React, { useEffect, useState } from 'react';
import { ChevronDown, Lock, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import { checkOnboardingStatus } from '../../services/stripeService';
import { ConnectBankButton } from '../ui/ConnectBankButton';
import { PayoutHistory } from './PayoutHistory';
import type { Caregiver } from '../../types';

const FAQS: Array<{ q: string; a: string }> = [
  { q: 'Why should I accept credit card payments?', a: 'Families overwhelmingly prefer paying by card. Accepting card payments significantly increases the jobs you see and land.' },
  { q: 'How long will payout setup take? What will I need?', a: 'Most caregivers finish in under 5 minutes. Have a photo ID and your bank routing info ready.' },
  { q: 'Are there any fees to accept credit card payments?', a: 'Evia covers Stripe processing fees for membership customers. See your plan for details.' },
  { q: 'How can I pay with my Evia balance?', a: 'Funds arrive in your connected bank on a rolling schedule after each credit-card booking is completed.' },
  { q: 'Can I transfer funds to my own bank account?', a: 'Yes — link any US bank account during onboarding. Instant payout options may apply on eligible accounts.' },
];

export const CaregiverPayoutPage: React.FC = () => {
  const { currentUser, addToast, setMembershipModalOpen } = useCareConnex();
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  // Profile = users+caregivers merge PLUS the owner-only private/payout
  // subdoc (stripeAccountId + Connect flags moved off the world-readable
  // parent doc).
  const loadProfile = async () => {
    if (!currentUser?.uid) return;
    const [p, payout] = await Promise.all([
      dbService.getUser(currentUser.uid),
      dbService.getOwnCaregiverPayoutFields(currentUser.uid),
    ]);
    if (p) setProfile({ ...(p as any), ...payout });
  };

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) return;
      const [p, payout] = await Promise.all([
        dbService.getUser(currentUser.uid),
        dbService.getOwnCaregiverPayoutFields(currentUser.uid),
      ]);
      if (active && p) setProfile({ ...(p as any), ...payout });
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

  // On return from Stripe onboarding, force a status refresh as a fallback
  // in case the account.updated webhook is lagging.
  useEffect(() => {
    if (!profile?.stripeAccountId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('stripe') !== 'success') return;
    (async () => {
      try {
        await checkOnboardingStatus(profile.stripeAccountId!);
        await loadProfile();
        addToast('Payout setup updated', 'success');
      } catch (err) {
        console.error('Status refresh failed:', err);
      } finally {
        const url = new URL(window.location.href);
        url.searchParams.delete('stripe');
        window.history.replaceState({}, '', url.toString());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.stripeAccountId]);

  const hasAccount = !!profile?.stripeAccountId;
  const fullyEnabled = !!(profile?.payoutsEnabled && profile?.chargesEnabled);

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Payout &amp; Payment</h1>

        <div className="grid md:grid-cols-[1fr_320px] gap-6">
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <p className="font-bold text-slate-900 mb-1">Booking payouts</p>

              {fullyEnabled ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                    <p className="text-sm font-semibold text-green-700">Bank account connected</p>
                  </div>
                  <p className="text-sm text-slate-600 mb-4">
                    You're all set to receive payouts. Earnings pay out automatically every day and
                    arrive in your bank ~2 business days after each visit is paid (free).
                    Need money sooner? Instant payouts arrive in about 30 minutes and carry Stripe's 1% fee (minimum $0.50).
                  </p>
                  <a
                    href="https://dashboard.stripe.com/express"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-semibold text-primary-700 hover:underline"
                  >
                    Manage in Stripe <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </>
              ) : hasAccount ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-5 h-5 text-amber-600" />
                    <p className="text-sm font-semibold text-amber-700">Setup incomplete</p>
                  </div>
                  <p className="text-sm text-slate-600 mb-4">
                    You've started setting up payouts but Stripe still needs more information. Finish the
                    short onboarding flow to start receiving payments.
                  </p>
                  <ConnectBankButton onShowToast={addToast} />
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-slate-800 mb-2">Activate your payout account to get paid</p>
                  <p className="text-sm text-slate-600 mb-4">
                    Set up your account for fast and secure online payments via Stripe Connect.
                    Get paid quickly to an existing bank account or debit card.
                  </p>
                  <ConnectBankButton onShowToast={addToast} />
                </>
              )}

              <p className="mt-3 text-xs text-slate-400 flex items-center gap-1"><Lock className="w-3 h-3" /> Secured by Stripe</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <p className="font-bold text-slate-900 mb-1">Membership payment method</p>
              <p className="text-sm text-slate-600 mb-3">Used for purchasing and renewing your membership.</p>
              <button onClick={() => setMembershipModalOpen(true)} className="inline-flex items-center px-4 py-2 rounded-full border border-primary-200 text-primary-700 text-sm font-semibold hover:bg-primary-50">
                Manage your credit card
              </button>
            </div>

            {currentUser?.uid && <PayoutHistory uid={currentUser.uid} />}
          </div>

          <aside className="bg-white border border-slate-200 rounded-2xl p-5 h-max">
            <p className="font-bold text-slate-900 mb-3">Credit Card Payout FAQs</p>
            <div className="divide-y divide-slate-100">
              {FAQS.map((f, i) => (
                <div key={i} className="py-2">
                  <button
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                    className="w-full flex items-center justify-between text-left text-sm font-medium text-slate-700 hover:text-slate-900"
                  >
                    {f.q}
                    <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${openFaq === i ? 'rotate-180' : ''}`} />
                  </button>
                  {openFaq === i && <p className="mt-2 text-xs text-slate-500">{f.a}</p>}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};
