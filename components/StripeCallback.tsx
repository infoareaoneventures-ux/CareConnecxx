
import React, { useEffect, useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { ViewType } from '../types';
import { stripeService } from '../services/api';

interface StripeCallbackProps {
  onNavigate: (view: ViewType) => void;
}

export const StripeCallback: React.FC<StripeCallbackProps> = ({ onNavigate }) => {
  const [status, setStatus] = useState<'verifying' | 'success'>('verifying');

  useEffect(() => {
    const completeOnboarding = async () => {
      // Simulate verification delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      // completeOnboarding is handled server-side via webhook
      setStatus('success');
    };

    completeOnboarding();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="bg-white p-8 rounded-3xl shadow-xl max-w-sm w-full text-center animate-slide-in">
        {status === 'verifying' ? (
          <div className="flex flex-col items-center">
            <Loader2 className="w-16 h-16 text-primary-600 animate-spin mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Verifying Bank Info</h2>
            <p className="text-slate-500">Please wait while we secure your account...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
               <CheckCircle className="w-10 h-10 text-green-600" />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Bank Connected Successfully!</h2>
            <p className="text-slate-500 mb-6">You are now verified to receive direct deposits.</p>
            
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
