
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, ArrowRight, MessageCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { ViewType } from '../types';

interface PaymentSuccessProps {
  onNavigate: (view: ViewType) => void;
}

export const PaymentSuccess: React.FC<PaymentSuccessProps> = ({ onNavigate }) => {
  const [searchParams] = useSearchParams();

  const sourceCara  = searchParams.get('source') === 'cara';
  const caraPhone   = searchParams.get('caraPhone') ?? '';
  const isMobile    = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const showBackBtn = sourceCara && isMobile && !!caraPhone;

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center animate-slide-in relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-2 bg-green-500"></div>

        <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6 shadow-sm">
          <CheckCircle className="w-10 h-10 text-green-600" />
        </div>

        {showBackBtn ? (
          <>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">All done!</h1>
            <p className="text-slate-500 mb-8">
              Evia is ready for you. Head back to continue setting up your care.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Payment Successful!</h1>
            <p className="text-slate-500 mb-8">
              Thank you. Your invoice has been paid.
            </p>
          </>
        )}

        {showBackBtn ? (
          <>
            <a
              href={`sms:${caraPhone}`}
              className="flex items-center justify-center gap-2 w-full py-3 px-5 rounded-2xl bg-primary-600 hover:bg-primary-700 text-white font-semibold text-base transition-colors mb-3"
            >
              <MessageCircle className="w-5 h-5" />
              Go back to messages
            </a>
            <button
              onClick={() => onNavigate('client')}
              className="text-sm text-slate-500 hover:text-slate-700 underline"
            >
              Continue in the app
            </button>
          </>
        ) : (
          <Button
            fullWidth
            onClick={() => onNavigate('client')}
            className="bg-slate-900 hover:bg-slate-800 text-white"
          >
            Return to Dashboard <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        )}
      </div>
    </div>
  );
};
