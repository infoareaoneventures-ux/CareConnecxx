
import React, { useEffect, useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { ViewType } from '../types';
import { stripeService } from '../services/api';

interface StripeCallbackProps {
  onNavigate: (view: ViewType) => void;
}

export const StripeCallback: React.FC<StripeCallbackProps> = ({ onNavigate }) => {
  // Verification is confirmed asynchronously by the Stripe Connect webhook
  // (stripeConnectWebhook). This return page must NOT claim success it can't
  // confirm — it shows a brief processing state, then an honest "submitted /
  // we'll confirm" message and routes the caregiver back to their dashboard,
  // where their real payout status is reflected once the webhook lands.
  const [status, setStatus] = useState<'processing' | 'submitted'>('processing');

  useEffect(() => {
    const t = window.setTimeout(() => setStatus('submitted'), 1500);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="bg-white p-8 rounded-3xl shadow-xl max-w-sm w-full text-center animate-slide-in">
        {status === 'processing' ? (
          <div className="flex flex-col items-center">
            <Loader2 className="w-16 h-16 text-primary-600 animate-spin mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Finishing up</h2>
            <p className="text-slate-500">Please wait a moment…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
               <CheckCircle className="w-10 h-10 text-blue-600" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Bank details submitted</h2>
            <p className="text-slate-500 mb-6">
              Thanks! We're confirming your payout account with Stripe — this can take a few minutes.
              We'll notify you the moment it's active, and your dashboard will show the status.
            </p>

            <button
              onClick={() => onNavigate('caregiver')}
              className="w-full py-3 bg-slate-900 text-white rounded-xl font-medium hover:bg-slate-800 transition-colors"
            >
              Return to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
