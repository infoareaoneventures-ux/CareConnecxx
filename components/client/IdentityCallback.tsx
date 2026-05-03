import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { auth, db } from '../../lib/firebase';

type Status = 'waiting' | 'verified' | 'requires_input' | 'canceled' | 'timeout';

/**
 * Landing page Stripe redirects to after the hosted Identity flow.
 * Subscribes to the user doc; the webhook flips `identityCheckStatus` to
 * 'verified' asynchronously. When that arrives, we bounce to `?next=`.
 */
export default function IdentityCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/client/find-caregivers';

  const [status, setStatus] = useState<Status>('waiting');

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      navigate('/login');
      return;
    }

    const unsub = db.collection('users').doc(uid).onSnapshot(doc => {
      const s = (doc.data() as any)?.identityCheckStatus;
      if (s === 'verified') setStatus('verified');
      else if (s === 'requires_input') setStatus('requires_input');
      else if (s === 'canceled') setStatus('canceled');
    });

    const timeout = window.setTimeout(() => {
      setStatus(prev => (prev === 'waiting' ? 'timeout' : prev));
    }, 30000);

    return () => { unsub(); window.clearTimeout(timeout); };
  }, [navigate]);

  useEffect(() => {
    if (status === 'verified') {
      const t = window.setTimeout(() => navigate(next, { replace: true }), 1200);
      return () => window.clearTimeout(t);
    }
  }, [status, next, navigate]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="bg-primary-600 px-5 py-3 flex items-center gap-2 text-white">
          <ShieldCheck className="w-4 h-4" />
          <span className="text-sm font-semibold">Identity Check</span>
        </div>

        <div className="p-8 text-center">
          {status === 'waiting' && (
            <>
              <Loader2 className="w-10 h-10 text-primary-600 animate-spin mx-auto mb-4" />
              <h1 className="text-lg font-bold text-slate-900 mb-2">Verifying your identity…</h1>
              <p className="text-sm text-slate-600 leading-relaxed">
                Stripe is checking your information. This usually takes just a few seconds — hang tight.
              </p>
            </>
          )}

          {status === 'verified' && (
            <>
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h1 className="text-lg font-bold text-slate-900 mb-2">You're verified!</h1>
              <p className="text-sm text-slate-600">Redirecting you back…</p>
            </>
          )}

          {status === 'requires_input' && (
            <>
              <div className="w-14 h-14 rounded-full bg-accent-100 flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-8 h-8 text-accent-600" />
              </div>
              <h1 className="text-lg font-bold text-slate-900 mb-2">Additional info needed</h1>
              <p className="text-sm text-slate-600 mb-5">
                Stripe couldn't verify your information. Please double-check your name, date of birth, and SSN digits, then try again.
              </p>
              <button
                onClick={() => navigate(next, { replace: true })}
                className="px-5 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700"
              >
                Go back
              </button>
            </>
          )}

          {status === 'canceled' && (
            <>
              <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-8 h-8 text-slate-500" />
              </div>
              <h1 className="text-lg font-bold text-slate-900 mb-2">Check canceled</h1>
              <p className="text-sm text-slate-600 mb-5">
                No problem — you can pick it up again anytime you want to contact a caregiver.
              </p>
              <button
                onClick={() => navigate(next, { replace: true })}
                className="px-5 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700"
              >
                Go back
              </button>
            </>
          )}

          {status === 'timeout' && (
            <>
              <Loader2 className="w-10 h-10 text-primary-600 animate-spin mx-auto mb-4" />
              <h1 className="text-lg font-bold text-slate-900 mb-2">Still reviewing</h1>
              <p className="text-sm text-slate-600 mb-5">
                Stripe is taking a little longer than usual. You can head back — we'll unlock the feature as soon as the review finishes.
              </p>
              <button
                onClick={() => navigate(next, { replace: true })}
                className="px-5 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700"
              >
                Continue
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
