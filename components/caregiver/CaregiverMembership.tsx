import React, { useState } from 'react';
import {
  ShieldCheck, Loader2, ChevronLeft, X,
  DollarSign, MessageCircle, Briefcase, Car,
} from 'lucide-react';
import {
  createCaregiverCheckoutSession,
  CAREGIVER_ANNUAL_PRICE,
} from '../../services/stripeService';
import { authService } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

interface CaregiverMembershipProps {
  onNavigate: (view: any) => void;
  onShowToast?: (msg: string, type: 'success' | 'error' | 'info') => void;
  onClose?: () => void;
}

const BENEFITS = [
  {
    icon: DollarSign,
    title: 'Keep 100% of your rate',
    desc: 'Families pay the service fee — your rate is never reduced. Daily payouts are free; instant cash-out carries Stripe\'s 1% fee.',
  },
  {
    icon: ShieldCheck,
    title: 'Background check included',
    desc: 'Your criminal background check is covered — and so is the driving record check if you offer transportation.',
  },
  {
    icon: Briefcase,
    title: 'Access all jobs & tools',
    desc: 'Browse every job posting, apply instantly, and manage your schedule.',
  },
  {
    icon: MessageCircle,
    title: 'Direct messaging & support',
    desc: 'Chat with families directly and reach our care team anytime.',
  },
];

// ONE flat annual fee (founder, 2026-09-25): $69.99/yr covers the criminal
// background check and, for a caregiver whose profile offers Transportation,
// the driving record (MVR) check — bundled into the same Checkr run, or run on
// its own if transportation is added later. No add-on, no toggle. The price
// itself is chosen server-side (createCheckoutSession, plan 'caregiver_annual').
export const CaregiverMembership: React.FC<CaregiverMembershipProps> = ({
  onNavigate,
  onShowToast,
  onClose,
}) => {
  const { caregiverProfile } = useCareConnex();
  const p = caregiverProfile as any;
  const hasTransportation = (p?.services || p?.skills || []).includes('Transportation');
  const [loading, setLoading] = useState(false);
  const annualPrice = CAREGIVER_ANNUAL_PRICE;

  const handleCheckout = async () => {
    const user = authService.getCurrentUser();
    if (!user) {
      onShowToast?.('Please log in to purchase a membership', 'error');
      return;
    }

    setLoading(true);
    try {
      const successUrl = `${window.location.origin}/caregiver/dashboard?membership=success`;
      const cancelUrl = `${window.location.origin}/caregiver/membership`;
      const url = await createCaregiverCheckoutSession(successUrl, cancelUrl);
      if (url) {
        window.location.href = url;
      } else {
        onShowToast?.('Could not start checkout. Please try again.', 'error');
      }
    } catch (err) {
      onShowToast?.('Checkout failed. Please try again.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const inner = (
    <div className={onClose ? 'flex flex-col lg:flex-row rounded-2xl overflow-hidden' : 'min-h-screen flex flex-col lg:flex-row'}>

      {/* ── Left: Hero / Benefits ── */}
      <div className="lg:w-[55%] bg-gradient-to-br from-primary-500 to-blue-700 text-white px-8 py-10 lg:py-16 flex flex-col">

        {/* Back button — page mode only */}
        {!onClose && (
          <button
            onClick={() => onNavigate('caregiver')}
            className="flex items-center gap-1.5 text-white/70 hover:text-white text-sm font-medium mb-10 w-fit transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to Dashboard
          </button>
        )}

        {/* Icon + headline */}
        <div className="flex-1 flex flex-col justify-center max-w-lg">
          <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mb-6">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>

          <h1 className="text-3xl lg:text-4xl font-extrabold leading-tight mb-3">
            Join Evia and find senior care jobs
          </h1>
          <p className="text-white/80 text-lg mb-10 leading-relaxed">
            Families are searching for caregivers like you right now. Activate your membership and start applying today.
          </p>

          {/* Benefits */}
          <div className="space-y-5">
            {BENEFITS.map((b, i) => (
              <div key={i} className="flex items-start gap-4">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center flex-shrink-0">
                  <b.icon className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="font-semibold text-white text-sm">{b.title}</p>
                  <p className="text-white/70 text-sm">{b.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Pricing note */}
          <div className="mt-10 pt-6 border-t border-white/20">
            <p className="text-white/90 text-sm font-medium">
              Membership: <span className="font-extrabold">${annualPrice}/year</span>
            </p>
            <p className="text-white/50 text-xs mt-1">
              One flat fee, billed annually — background check and driving record check included.
            </p>
          </div>
        </div>
      </div>

      {/* ── Right: Purchase Form ── */}
      <div className="lg:w-[45%] bg-white px-8 py-10 lg:py-16 flex flex-col justify-center">
        <div className="max-w-sm w-full mx-auto">
          <h2 className="text-2xl font-extrabold text-slate-900 mb-1">Join today</h2>
          <p className="text-slate-500 text-sm mb-8">One flat annual fee. Your background check is included.</p>

          {/* Annual plan summary */}
          <div className="mb-6">
            <div className="w-full flex items-center justify-between p-4 rounded-2xl border-2 border-primary-500 bg-primary-50">
              <div className="flex items-center gap-3 text-left">
                <div className="w-5 h-5 rounded-full border-2 border-primary-500 flex items-center justify-center flex-shrink-0">
                  <div className="w-2.5 h-2.5 rounded-full bg-primary-500" />
                </div>
                <div>
                  <p className="font-semibold text-slate-900 text-sm">Annual membership</p>
                  <p className="text-xs text-slate-500">Billed once a year</p>
                </div>
              </div>
              <p className="font-extrabold text-primary-700 text-sm">${annualPrice}/yr</p>
            </div>
          </div>

          {/* What's included */}
          <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-2.5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Included in your membership</p>
            <div className="flex items-start gap-2.5 text-sm text-slate-700">
              <ShieldCheck className="w-4 h-4 text-primary-600 flex-shrink-0 mt-0.5" />
              <span>Criminal background check through Checkr, plus your verified badge.</span>
            </div>
            <div className="flex items-start gap-2.5 text-sm text-slate-700">
              <Car className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
              <span>
                {hasTransportation
                  ? 'Driving record (MVR) check — you offer transportation, so it runs with your background check.'
                  : 'Driving record (MVR) check whenever you add transportation to your services — no extra charge.'}
              </span>
            </div>
          </div>

          {/* Total */}
          <div className="py-3.5 border-t border-b border-slate-100 mb-6">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-700">Total today</span>
              <span className="text-xl font-extrabold text-slate-900">
                ${annualPrice.toFixed(2)}
                <span className="text-sm font-medium text-slate-500 ml-1">/year</span>
              </span>
            </div>
          </div>

          {/* CTA */}
          <button
            onClick={handleCheckout}
            disabled={loading}
            className="w-full py-4 bg-primary-500 hover:bg-primary-600 text-white font-bold text-sm rounded-2xl transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-60"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
            {loading ? 'Redirecting to checkout…' : 'Start membership →'}
          </button>

          {/* Fine print */}
          <p className="text-xs text-slate-400 text-center mt-4 leading-relaxed">
            Purchase is non-refundable. Membership renews annually. Cancel anytime before renewal.
          </p>
        </div>
      </div>
    </div>
  );

  if (onClose) {
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
        <div className="relative w-full max-w-4xl my-auto">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-10 w-8 h-8 bg-white/90 hover:bg-white rounded-full flex items-center justify-center shadow-md transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-slate-600" />
          </button>
          {inner}
        </div>
      </div>
    );
  }

  return inner;
};
