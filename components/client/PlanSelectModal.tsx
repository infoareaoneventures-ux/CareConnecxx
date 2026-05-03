import React, { useState } from 'react';
import { X, Loader2, Check } from 'lucide-react';
import { auth } from '../../lib/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useNavigate } from 'react-router-dom';

// Client monthly — live Stripe price ID; override via VITE_STRIPE_PRICE_ID if needed.
const CLIENT_MONTHLY_PRICE_ID = import.meta.env.VITE_STRIPE_PRICE_ID || 'price_1TO8D5L7Ss5iuUb73AQ3zHKO';

const PLANS = [
  {
    id: 'monthly',
    label: 'Monthly plan',
    priceId: CLIENT_MONTHLY_PRICE_ID,
    price: '$29.95',
    period: '/month',
    billing: 'Billed now at $29.95 and then every month at $29.95',
  },
];

const RENEWAL_TERMS = `Monthly, Quarterly, and Annual Memberships continue and automatically renew for the same membership period (e.g., monthly, quarterly, or annually) until you cancel. Unless you cancel before your Membership renews, you will be charged the then-current Membership rate (which is subject to change) for your plan. You may cancel anytime via your Account Settings, and your cancellation will be effective at the end of your current Membership term. Memberships are non-refundable.`;

interface Props {
  onClose: () => void;
  currentPriceId?: string;
  caregiverName?: string;
  caregiverAvatar?: string;
  context?: 'message' | 'interview' | 'booking';
}

export function PlanSelectModal({ onClose, currentPriceId, caregiverName, caregiverAvatar, context }: Props) {
  const navigate = useNavigate();
  const defaultPlan = PLANS.find(p => p.priceId === currentPriceId) ?? PLANS[0];
  const [selected, setSelected] = useState(defaultPlan.id);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelectPlan = async () => {
    if (!auth.currentUser) {
      navigate('/login');
      return;
    }

    const plan = PLANS.find(p => p.id === selected)!;
    setIsProcessing(true);
    setError(null);

    try {
      const functions = getFunctions();
      const createCheckoutSession = httpsCallable(functions, 'v1-createCheckoutSession');

      const result = await createCheckoutSession({
        priceId: plan.priceId,
        successUrl: `${window.location.origin}/client/membership?success=true`,
        cancelUrl: `${window.location.origin}/client/membership?canceled=true`,
      });

      const { url } = result.data as { url: string };
      if (url) {
        window.location.href = url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err: any) {
      console.error('Checkout error:', err);
      setError(err.message || 'Failed to start checkout. Please try again.');
      setIsProcessing(false);
    }
  };

  return (
    /* Backdrop */
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">

        {/* Header — teal bar with optional caregiver context, matches UrbanSitter "Select a plan to contact X" */}
        <div className="flex items-center justify-between px-5 py-3 bg-primary-600 text-white">
          <div className="flex items-center gap-2.5 min-w-0">
            {caregiverName && caregiverAvatar && (
              <img
                src={caregiverAvatar}
                alt={caregiverName}
                className="w-8 h-8 rounded-full object-cover border-2 border-white/80 flex-shrink-0"
              />
            )}
            <h2 className="text-base font-semibold truncate">
              {caregiverName
                ? (context === 'booking'
                    ? `Select a plan to book ${caregiverName}`
                    : context === 'interview'
                      ? `Select a plan to interview ${caregiverName}`
                      : `Select a plan to contact ${caregiverName}`)
                : 'Select a plan'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col md:flex-row">

          {/* ── Left panel — plan selection ─────────────────────────── */}
          <div className="flex-1 p-6">
            <p className="text-sm text-slate-500 mb-6">
              All plans include full access to CareConnex caregivers, plus easy on-demand booking.
            </p>

            {/* Plan radio cards */}
            <div className="space-y-3 mb-6">
              {PLANS.map(plan => {
                const isSelected = selected === plan.id;
                return (
                  <label
                    key={plan.id}
                    className={`flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
                      isSelected
                        ? 'border-primary-500 bg-primary-50'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    {/* Radio */}
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      isSelected ? 'border-primary-500' : 'border-slate-300'
                    }`}>
                      {isSelected && <div className="w-2.5 h-2.5 rounded-full bg-primary-500" />}
                    </div>
                    <input
                      type="radio"
                      className="sr-only"
                      checked={isSelected}
                      onChange={() => setSelected(plan.id)}
                    />

                    {/* Plan info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900">{plan.label}</p>
                      <p className="text-sm text-slate-500">{plan.billing}</p>
                    </div>

                    {/* Price */}
                    <div className="text-right flex-shrink-0">
                      <span className="text-lg font-bold text-slate-900">{plan.price}</span>
                      <span className="text-sm text-slate-500">{plan.period}</span>
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Error */}
            {error && (
              <p className="text-sm text-red-600 mb-4">{error}</p>
            )}

            {/* Agreement text */}
            <p className="text-xs text-slate-500 mb-5">
              By clicking the button, you agree to the renewal offer terms provided.
            </p>

            {/* CTA */}
            <button
              onClick={handleSelectPlan}
              disabled={isProcessing}
              className="w-full py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing…
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  Select plan
                </>
              )}
            </button>
          </div>

          {/* ── Right panel — renewal terms ─────────────────────────── */}
          <div className="md:w-56 bg-slate-50 border-t md:border-t-0 md:border-l border-slate-200 p-6 flex-shrink-0">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Renewal offer terms</h3>
            <p className="text-xs text-slate-500 leading-relaxed">{RENEWAL_TERMS}</p>
          </div>

        </div>
      </div>
    </div>
  );
}
