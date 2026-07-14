import React, { useState } from 'react';
import {
  ShieldCheck, CheckCircle, Loader2, ChevronLeft, X,
  DollarSign, MessageCircle, Briefcase, Car,
} from 'lucide-react';
import {
  createCaregiverCheckoutSession,
  CAREGIVER_ANNUAL_PRICE_ID,
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
  onClose,
}) => {
  const { caregiverProfile } = useCareConnex();
  const p = caregiverProfile as any;
  const hasTransportation = (p?.services || p?.skills || []).includes('Transportation');
  // MVR is a real opt-in for every caregiver (default off), not auto-bundled with
  // the Transportation service. Default it on for drivers as a helpful suggestion,
  // but it remains fully toggleable.
  const [includeMVR, setIncludeMVR] = useState<boolean>(false);

  const [loading, setLoading] = useState(false);

  // $66.49/yr — the actual Stripe charge (product "Caregiver background check
  // $66.49/yr", price_1TqGrE…, unit_amount 6649). The membership fee covers the
  // required Checkr background check + verified badge. Was stale at 24.95, which
  // did NOT match what Stripe charges.
  const annualPrice = 66.49;
  const mvrPrice = 9.50;
  const annualPerMonth = (annualPrice / 12).toFixed(2);

  const selectedPrice = annualPrice;
  const selectedPriceId = CAREGIVER_ANNUAL_PRICE_ID;


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
      const url = await createCaregiverCheckoutSession(selectedPriceId, successUrl, cancelUrl, { includeMVR });
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

          {/* MVR add-on — a real opt-in offered to every caregiver */}
          <div className="mb-6">
            <button
              type="button"
              onClick={() => setIncludeMVR(v => !v)}
              aria-pressed={includeMVR}
              className={`w-full flex items-start gap-3 p-4 rounded-2xl border-2 text-left transition-colors ${includeMVR ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white hover:border-blue-300'}`}
            >
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${includeMVR ? 'border-blue-500 bg-blue-500' : 'border-slate-300'}`}>
                {includeMVR && <CheckCircle className="w-3.5 h-3.5 text-white" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Car className="w-4 h-4 text-blue-600" />
                    <p className="font-semibold text-slate-900 text-sm">Add Approved Driver status</p>
                  </div>
                  <p className="font-bold text-blue-700 text-sm">+${mvrPrice.toFixed(2)}</p>
                </div>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  Includes a Motor Vehicle Report (MVR). Families that need a driver will be able to see your Approved Driver badge.
                </p>
              </div>
            </button>
          </div>

          {/* Total */}
          <div className="py-3.5 border-t border-b border-slate-100 mb-6">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-700">Total today</span>
              <span className="text-xl font-extrabold text-slate-900">
                ${selectedPrice.toFixed(2)}
                {includeMVR && <span className="text-base font-bold text-slate-900"> + ${mvrPrice.toFixed(2)}</span>}
                <span className="text-sm font-medium text-slate-500 ml-1">/year</span>
              </span>
            </div>
            {includeMVR && (
              <p className="text-xs text-slate-400 text-right mt-1">
                ${mvrPrice.toFixed(2)} MVR is a one-time charge — your annual renewal is ${selectedPrice.toFixed(2)}/yr
              </p>
            )}
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
