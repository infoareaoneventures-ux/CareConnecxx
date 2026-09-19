import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Crown, Shield, Star, Loader2, AlertCircle, Calendar, CreditCard } from 'lucide-react';
import { Button } from './ui/Button';
import { ClientNavigation } from './client/ClientNavigation';
import { auth } from '../lib/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  getSubscriptionStatus,
  hasActiveMembership,
  SubscriptionStatus,
  listenToSubscriptionStatus,
  getClientBillingPortalUrl,
} from '../services/stripeService';
import { PlanSelectModal } from './client/PlanSelectModal';

interface PlanFeature {
  text: string;
  included: boolean;
}

const PLAN_FEATURES: PlanFeature[] = [
  { text: 'Caregiver messaging', included: true },
  { text: 'AI-powered caregiver matching', included: true },
  { text: 'Schedule coordination tools', included: true },
  { text: 'Background-checked caregivers', included: true },
  { text: 'Interview scheduling', included: true },
  // 2026-09-18: 'GPS shift verification' removed until shift location capture ships;
  // 'emergency support' reworded to what exists (Evia by text around the clock,
  // urgent issues flagged to the team) — no one is on call.
  { text: 'Evia text support, 24/7', included: true },
];

export default function Membership() {
  const navigate = useNavigate();
  const [isProcessing, setIsProcessing] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);

  useEffect(() => {
    const user = auth?.currentUser;
    if (!user) {
      navigate('/login');
      return;
    }

    // Initial fetch (async — no cleanup to return from here).
    loadSubscriptionStatus();

    // Real-time listener. Its unsubscribe MUST be returned synchronously from the
    // effect — previously it was returned from the async loadSubscriptionStatus,
    // so React received a Promise (not a function) and never cleaned up: the
    // Firestore listener leaked on unmount and a second one stacked on every re-run.
    const unsubscribe = listenToSubscriptionStatus(user.uid, (updatedStatus) => {
      setSubscription(updatedStatus);
    });
    return () => unsubscribe();
  }, []);

  const loadSubscriptionStatus = async () => {
    try {
      const status = await getSubscriptionStatus();
      setSubscription(status);
    } catch (err) {
      console.error('Error loading subscription:', err);
      setError('Failed to load subscription status');
    } finally {
      setLoading(false);
    }
  };

  const handleManageBilling = async () => {
    setOpeningPortal(true);
    try {
      const url = await getClientBillingPortalUrl();
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setError(err?.message || 'Could not open billing portal. Please try again.');
    } finally {
      setOpeningPortal(false);
    }
  };


  const handleCancel = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      const functions = getFunctions();
      const cancelSubscriptionFn = httpsCallable(functions, 'v1-cancelSubscription');
      await cancelSubscriptionFn({});
      
      setShowCancelConfirm(false);
      // Status will update via listener
    } catch (err: any) {
      console.error('Error canceling subscription:', err);
      setError(err.message || 'Failed to cancel subscription');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReactivate = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      const functions = getFunctions();
      const reactivateSubscriptionFn = httpsCallable(functions, 'v1-reactivateSubscription');
      await reactivateSubscriptionFn({});
      // Status will update via listener
    } catch (err: any) {
      console.error('Error reactivating subscription:', err);
      setError(err.message || 'Failed to reactivate subscription');
    } finally {
      setIsProcessing(false);
    }
  };

  // Check URL params for Stripe redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      // Subscription successful - reload status
      loadSubscriptionStatus();
      // Clean up URL
      window.history.replaceState({}, '', '/client/membership');
    } else if (params.get('canceled') === 'true') {
      setError('Payment was canceled. You can try again when ready.');
      window.history.replaceState({}, '', '/client/membership');
    }
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
          <p className="text-slate-500">Loading membership status...</p>
        </div>
      </div>
    );
  }

  const isActive = subscription && hasActiveMembership(subscription);
  const isCanceled = subscription?.cancelAtPeriodEnd;

  return (
    <div className="min-h-screen bg-slate-50 pb-24 font-sans text-slate-900">
      <ClientNavigation />
      
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Crown className="w-8 h-8 text-accent-500" />
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Membership</h1>
              <p className="text-slate-500">Manage your Evia subscription</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Current Status Card */}
        {isActive && (
          <div className="mb-8 bg-gradient-to-r from-primary-600 to-primary-700 rounded-2xl p-6 text-white">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center">
                <Crown className="w-8 h-8" />
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold">Standard Plan</h2>
                <p className="text-primary-100">
                  {isCanceled 
                    ? `Your membership ends on ${subscription.currentPeriodEnd?.toLocaleDateString()}`
                    : `Next billing date: ${subscription.currentPeriodEnd?.toLocaleDateString()}`
                  }
                </p>
              </div>
              {isCanceled ? (
                <span className="px-4 py-2 bg-accent-500/20 text-accent-100 rounded-full text-sm font-medium">
                  Canceling
                </span>
              ) : (
                <span className="px-4 py-2 bg-green-500/20 text-green-100 rounded-full text-sm font-medium">
                  Active
                </span>
              )}
            </div>
            
            {isCanceled && (
              <div className="mt-4 p-4 bg-white/10 rounded-xl">
                <p className="text-sm">
                  Your membership is set to cancel. You'll lose access to membership features after {subscription.currentPeriodEnd?.toLocaleDateString()}.
                </p>
                <button
                  onClick={handleReactivate}
                  disabled={isProcessing}
                  className="mt-3 px-4 py-2 bg-white text-primary-700 rounded-lg font-medium hover:bg-primary-50 transition-colors disabled:opacity-50"
                >
                  {isProcessing ? 'Processing...' : 'Reactivate Membership'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Plan Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          {/* Plan Header */}
          <div className="bg-gradient-to-r from-slate-900 to-slate-800 p-8 text-white">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Star className="w-5 h-5 text-accent-400" />
                  <span className="text-sm font-medium text-slate-300">Standard Plan</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-5xl font-bold">$29.95</span>
                  <span className="text-slate-400">/month</span>
                </div>
                <p className="text-slate-400 mt-2">Billed monthly. Cancel anytime.</p>
              </div>
              <div className="hidden sm:block">
                <div className="w-24 h-24 bg-white/10 rounded-full flex items-center justify-center">
                  <Crown className="w-12 h-12 text-accent-400" />
                </div>
              </div>
            </div>
          </div>

          {/* Features */}
          <div className="p-8">
            <h3 className="text-lg font-bold text-slate-900 mb-6">What's included</h3>
            <div className="grid md:grid-cols-2 gap-4">
              {PLAN_FEATURES.map((feature, index) => (
                <div key={index} className="flex items-center gap-3">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                    feature.included ? 'bg-primary-100' : 'bg-slate-100'
                  }`}>
                    <Check className={`w-4 h-4 ${feature.included ? 'text-primary-600' : 'text-slate-400'}`} />
                  </div>
                  <span className={feature.included ? 'text-slate-700' : 'text-slate-400'}>
                    {feature.text}
                  </span>
                </div>
              ))}
            </div>

            {/* Trust Badges */}
            <div className="mt-8 pt-8 border-t border-slate-200">
              <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-slate-500">
                <div className="flex items-center gap-2">
                  <Shield className="w-5 h-5 text-primary-600" />
                  <span>Secure Payment</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-5 h-5 text-primary-600" />
                  <span>Cancel Anytime</span>
                </div>
                <div className="flex items-center gap-2">
                  <CreditCard className="w-5 h-5 text-primary-600" />
                  <span>PCI Compliant</span>
                </div>
              </div>
            </div>

            {/* CTA Button */}
            <div className="mt-8">
              {!isActive ? (
                <button
                  onClick={() => setShowPlanModal(true)}
                  className="w-full py-4 bg-primary-600 text-white rounded-xl font-bold text-lg hover:bg-primary-700 transition-colors flex items-center justify-center gap-2"
                >
                  Select a plan
                </button>
              ) : !isCanceled ? (
                <div className="space-y-3">
                  {/* "Change plan" hidden 2026-09-18: PlanSelectModal has exactly one
                      client plan, so the button opened a modal showing the plan the
                      family is already on. Restore when a second plan exists. */}
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    className="w-full py-4 border-2 border-slate-200 text-slate-600 rounded-xl font-bold text-lg hover:bg-slate-50 transition-colors"
                  >
                    Cancel Membership
                  </button>
                </div>
              ) : null}
            </div>

            {/* Payment Info */}
            {!isActive && (
              <p className="text-center text-sm text-slate-500 mt-4">
                You'll be redirected to Stripe for secure payment processing.
              </p>
            )}
          </div>
        </div>

        {/* Manage membership — Stripe's hosted portal covers payment method,
            cancellation, and full invoice/payment history in one place, same
            as the caregiver-side Payments page (CaregiverPaymentsPage.tsx). */}
        {isActive && (
          <div className="mt-8 bg-white rounded-2xl border border-slate-200 p-5 flex items-center justify-between gap-4">
            <div>
              <p className="font-semibold text-slate-900 text-sm">Manage membership</p>
              <p className="text-xs text-slate-500 mt-0.5">Update payment method, or view invoices and payment history via Stripe.</p>
            </div>
            <button
              onClick={handleManageBilling}
              disabled={openingPortal}
              className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60 flex items-center gap-2 shrink-0"
            >
              {openingPortal && <Loader2 className="w-4 h-4 animate-spin" />}
              Manage
            </button>
          </div>
        )}

      </main>

      {/* Cancel Confirmation Modal */}
      {showCancelConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Cancel Membership?</h3>
            <p className="text-slate-600 mb-6">
              You'll continue to have access until {subscription?.currentPeriodEnd?.toLocaleDateString()}. After that, you'll lose access to membership features.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 py-3 border border-slate-200 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Keep Membership
              </button>
              <button
                onClick={handleCancel}
                disabled={isProcessing}
                className="flex-1 py-3 bg-red-600 text-white rounded-xl font-medium hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {isProcessing ? 'Processing...' : 'Confirm Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPlanModal && (
        <PlanSelectModal
          onClose={() => setShowPlanModal(false)}
          currentPriceId={subscription?.priceId ?? undefined}
        />
      )}
    </div>
  );
}
