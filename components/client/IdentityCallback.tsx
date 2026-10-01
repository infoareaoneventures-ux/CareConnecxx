import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, Loader2, AlertCircle, CheckCircle, MessageCircle } from 'lucide-react';
import { auth, db } from '../../lib/firebase';

type Status = 'waiting' | 'verified' | 'requires_input' | 'canceled' | 'timeout';

export default function IdentityCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/client/find-caregivers';

  const sourceCara  = params.get('source') === 'cara';
  const caraPhone   = params.get('caraPhone') ?? '';
  const isMobile    = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const showBackBtn = sourceCara && isMobile && !!caraPhone;

  const [status, setStatus] = useState<Status>('waiting');

  useEffect(() => {
    const uid = auth?.currentUser?.uid;
    const fdb = db;
    if (!uid || !fdb) {
      // SMS-originated users may not be logged in via web — just wait for webhook.
      // Stripe Identity DOCUMENT checks routinely take a few minutes to process,
      // so give it 4 min before showing the "still reviewing" fallback (was 30s,
      // which fired mid-check and pushed people off the page before it cleared).
      const timeout = window.setTimeout(() => {
        setStatus(prev => (prev === 'waiting' ? 'timeout' : prev));
      }, 240000);
      return () => window.clearTimeout(timeout);
    }

    const unsub = fdb.collection('users').doc(uid).onSnapshot(doc => {
      const s = (doc.data() as any)?.identityCheckStatus;
      if (s === 'verified') setStatus('verified');
      else if (s === 'requires_input') setStatus('requires_input');
      else if (s === 'canceled') setStatus('canceled');
    });

    const timeout = window.setTimeout(() => {
      setStatus(prev => (prev === 'waiting' ? 'timeout' : prev));
    }, 240000);

    return () => { unsub(); window.clearTimeout(timeout); };
  }, [navigate]);

  useEffect(() => {
    // On mobile Evia flow: don't auto-navigate — let the user tap "Go back to messages"
    if (status === 'verified' && !showBackBtn) {
      const t = window.setTimeout(() => navigate(next, { replace: true }), 1200);
      return () => window.clearTimeout(t);
    }
  }, [status, next, navigate, showBackBtn]);

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
                Stripe is checking your information. This can take a couple of minutes — hang tight, and I'll text you the moment it clears.
              </p>
            </>
          )}

          {status === 'verified' && (
            <>
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h1 className="text-lg font-bold text-slate-900 mb-2">You're verified!</h1>
              {showBackBtn ? (
                <>
                  <p className="text-sm text-slate-600 mb-5">
                    All done! Evia is ready to continue setting up your care.
                  </p>
                  <a
                    href={`sms:${caraPhone}`}
                    className="flex items-center justify-center gap-2 w-full py-3 px-5 rounded-full bg-primary-600 hover:bg-primary-700 text-white font-semibold text-sm transition-colors mb-3"
                  >
                    <MessageCircle className="w-4 h-4" />
                    Go back to messages
                  </a>
                  <button
                    onClick={() => navigate(next, { replace: true })}
                    className="text-xs text-slate-500 hover:text-slate-700 underline"
                  >
                    Continue
                  </button>
                </>
              ) : (
                <p className="text-sm text-slate-600">Redirecting you back…</p>
              )}
            </>
          )}

          {status === 'requires_input' && (
            <>
              <div className="w-14 h-14 rounded-full bg-accent-100 flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-8 h-8 text-accent-600" />
              </div>
              <h1 className="text-lg font-bold text-slate-900 mb-2">Additional info needed</h1>
              <p className="text-sm text-slate-600 mb-5">
                Stripe couldn't verify your information. Please retake the photo of your ID and your selfie in good light, then try again.
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
                Stripe is taking a little longer than usual — no need to wait here. You can head back to your messages, and I'll text you the moment it clears and pick right back up.
              </p>
              {showBackBtn ? (
                <>
                  <a
                    href={`sms:${caraPhone}`}
                    className="flex items-center justify-center gap-2 w-full py-3 px-5 rounded-full bg-primary-600 hover:bg-primary-700 text-white font-semibold text-sm transition-colors mb-3"
                  >
                    <MessageCircle className="w-4 h-4" />
                    Go back to messages
                  </a>
                  <button
                    onClick={() => navigate(next, { replace: true })}
                    className="text-xs text-slate-500 hover:text-slate-700 underline"
                  >
                    Continue
                  </button>
                </>
              ) : (
                <button
                  onClick={() => navigate(next, { replace: true })}
                  className="px-5 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700"
                >
                  Continue
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
