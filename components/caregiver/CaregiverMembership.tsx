import React, { useState } from 'react';
import {
  ShieldCheck, CheckCircle, Loader2, ChevronLeft,
  DollarSign, MessageCircle, Briefcase, Calendar,
} from 'lucide-react';
import {
  createCaregiverCheckoutSession,
  CAREGIVER_ANNUAL_PRICE_ID,
} from '../../services/stripeService';
import { authService } from '../../services/api';

interface CaregiverMembershipProps {
  onNavigate: (view: any) => void;
  onShowToast?: (msg: string, type: 'success' | 'error' | 'info') => void;
}

const BENEFITS = [
  {
    icon: DollarSign,
    title: 'No platform fees',
    desc: 'Keep 100% of every booking — we never take a cut.',
  },
  {
    icon: ShieldCheck,
    title: 'Background check badge',
    desc: 'A verified badge on your profile builds family trust.',
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

export const CaregiverMembership: React.FC<CaregiverMembershipProps> = ({
  onNavigate,
  onShowToast,
}) => {
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [loading, setLoading] = useState(false);

  const annualPrice = 24.95;
  const annualPerMonth = (annualPrice / 12).toFixed(2);

  const selectedPrice = annualPrice;
  const selectedPriceId = CAREGIVER_ANNUAL_PRICE_ID;

  const handleApplyPromo = () => {
    if (promoCode.trim().toUpperCase() === 'CARE10') {
      setPromoApplied(true);
      onShowToast?.('Promo code applied — 10% off!', 'success');
    } else {
      onShowToast?.('Invalid promo code', 'error');
    }
  };

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
      const url = await createCaregiverCheckoutSession(selectedPriceId, successUrl, cancelUrl);
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

  return (
    <div className="min-h-screen flex flex-col lg:flex-row overflow-hidden">

      {/* ── Left: Hero / Benefits ── */}
      <div className="lg:w-[55%] bg-gradient-to-br from-primary-500 to-blue-700 text-white px-8 py-10 lg:py-16 flex flex-col">

        {/* Back button */}
        <button
          onClick={() => onNavigate('caregiver')}
          className="flex items-center gap-1.5 text-white/70 hover:text-white text-sm font-medium mb-10 w-fit transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to Dashboard
        </button>

        {/* Icon + headline */}
        <div className="flex-1 flex flex-col justify-center max-w-lg">
          <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mb-6">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>

          <h1 className="text-3xl lg:text-4xl font-extrabold leading-tight mb-3">
            Join CareConnex and find senior care jobs
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
              Billed annually — includes background check and verified badge.
            </p>
          </div>
        </div>
      </div>

      {/* ── Right: Purchase Form ── */}
      <div className="lg:w-[45%] bg-white px-8 py-10 lg:py-16 flex flex-col justify-center">
        <div className="max-w-sm w-full mx-auto">
          <h2 className="text-2xl font-extrabold text-slate-900 mb-1">Join today</h2>
          <p className="text-slate-500 text-sm mb-8">Annual membership includes your background check.</p>

          {/* Annual plan summary */}
          <div className="mb-6">
            <div className="w-full flex items-center justify-between p-4 rounded-2xl border-2 border-primary-500 bg-primary-50">
              <div className="flex items-center gap-3 text-left">
                <div className="w-5 h-5 rounded-full border-2 border-primary-500 flex items-center justify-center flex-shrink-0">
                  <div className="w-2.5 h-2.5 rounded-full bg-primary-500" />
                </div>
                <div>
                  <p className="font-semibold text-slate-900 text-sm">Annual plan</p>
                  <p className="text-xs text-slate-500">${annualPerMonth}/month billed annually</p>
                </div>
              </div>
              <p className="font-extrabold text-primary-700 text-sm">${annualPrice}/yr</p>
            </div>
          </div>

          {/* Promo code */}
          <div className="mb-6">
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Promo code (optional)</label>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-400"
                placeholder="Enter code"
                value={promoCode}
                onChange={e => setPromoCode(e.target.value.toUpperCase())}
                disabled={promoApplied}
              />
              <button
                onClick={handleApplyPromo}
                disabled={promoApplied || !promoCode.trim()}
                className="px-4 py-2.5 text-sm font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition-colors disabled:opacity-50"
              >
                {promoApplied ? <CheckCircle className="w-4 h-4 text-green-500" /> : 'Apply'}
              </button>
            </div>
          </div>

          {/* Total */}
          <div className="flex items-center justify-between py-3.5 border-t border-b border-slate-100 mb-6">
            <span className="font-semibold text-slate-700">Total today</span>
            <span className="text-xl font-extrabold text-slate-900">
              ${promoApplied ? (selectedPrice * 0.9).toFixed(2) : selectedPrice.toFixed(2)}
              <span className="text-sm font-medium text-slate-500 ml-1">/year</span>
            </span>
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
};
