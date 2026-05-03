
import React, { useState } from 'react';
import { Loader2, Landmark } from 'lucide-react';
import { stripeService } from '../../services/api';
import { AddToastFunction, ViewType } from '../../types';

interface ConnectBankButtonProps {
  onShowToast: AddToastFunction;
  onNavigate?: (view: ViewType) => void;
  className?: string;
}

export const ConnectBankButton: React.FC<ConnectBankButtonProps> = ({ onShowToast, onNavigate, className }) => {
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setLoading(true);
    try {
      onShowToast("Initializing secure setup...", "info");
      
      // Call our new API wrapper which handles Account Creation + Link Generation
      const { url } = await stripeService.initiateOnboarding();
      
      // Check if URL is local redirect for prototype or external
      if (url.includes('view=stripe-callback') && onNavigate) {
         // Prototype optimization: internal nav to avoid reload
         onNavigate('stripe-callback');
      } else {
         // Real Stripe Redirect
         window.location.href = url;
      }

    } catch (error: any) {
      console.error(error);
      const msg = error?.message || error?.details?.message || "Failed to connect to Stripe.";
      onShowToast(msg, "error");
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleConnect}
      disabled={loading}
      style={{ backgroundColor: loading ? '#a3a0e8' : '#635BFF' }}
      className={`inline-flex items-center justify-center px-5 py-2.5 rounded-full text-white text-sm font-semibold shadow-sm transition-colors hover:brightness-110 disabled:cursor-not-allowed ${className || ''}`}
    >
      {loading ? (
        <span className="flex items-center">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Setting up...
        </span>
      ) : (
        <span className="flex items-center">
          <Landmark className="w-4 h-4 mr-2" />
          Setup Payouts
        </span>
      )}
    </button>
  );
};
