import React, { useState } from 'react';
import { X, ShieldCheck, ChevronDown, ExternalLink, Lock, Facebook } from 'lucide-react';

interface IdentityGateModalProps {
  onClose: () => void;
  onGetVerified: () => void;
  onLinkFacebook?: () => void;
  caregiverName?: string;
  /** What the person was trying to do, so the message names it (2026-11-11: posting a request said "to contact care providers"). */
  action?: 'message' | 'interview' | 'booking' | 'post';
}

export const IdentityGateModal: React.FC<IdentityGateModalProps> = ({
  onClose,
  onGetVerified,
  onLinkFacebook,
  caregiverName,
  action,
}) => {
  const [whyOpen, setWhyOpen] = useState(false);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
        {/* Title bar */}
        <div className="bg-primary-600 px-5 py-3 flex items-center justify-between text-white">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" />
            <span className="text-sm font-semibold">Identity Check</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/15 rounded-full transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          <h2 className="text-lg font-bold text-slate-900 mb-2">
            Complete Your Identity Check
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed mb-3">
            {action === 'post' ? (
              'To post a care request, you need to complete a quick identity check. Pick up where you left off!'
            ) : caregiverName ? (
              <>To {action === 'interview' ? 'interview' : action === 'booking' ? 'book' : 'contact'} <span className="font-semibold text-slate-800">{caregiverName}</span>, you need to complete a quick identity check. Pick up where you left off!</>
            ) : (
              `To ${action === 'booking' ? 'book a care provider' : 'contact care providers'}, you need to complete a quick identity check. Pick up where you left off!`
            )}
          </p>
          <p className="text-sm text-slate-600 leading-relaxed mb-5">
            Securely complete a quick identity check with our safety partner <span className="font-semibold">Stripe Identity</span>. You'll take a photo of your government ID and a quick selfie — it takes about a minute.
          </p>

          {/* Primary CTA */}
          <button
            onClick={onGetVerified}
            className="w-full py-3 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-full transition-colors text-sm inline-flex items-center justify-center gap-1.5"
          >
            Continue Identity Check
            <ExternalLink className="w-4 h-4" />
          </button>
          <p className="text-xs text-slate-500 text-center mt-2.5">
            Allow popups if prompted. Having trouble? Try a new browser or device.
          </p>

          {/* Facebook fallback */}
          {onLinkFacebook && (
            <>
              <div className="my-5 border-t border-slate-200" />
              <p className="text-sm text-slate-600 leading-relaxed mb-3">
                Alternatively, you can easily log in to Facebook to confirm your identity. Nothing will be shared or posted.
              </p>
              <button
                onClick={onLinkFacebook}
                className="w-full py-2.5 bg-[#1877F2] hover:bg-[#166FE0] text-white font-semibold rounded-full transition-colors text-sm inline-flex items-center justify-center gap-2"
              >
                <Facebook className="w-4 h-4 fill-current" />
                Link Facebook
              </button>
            </>
          )}

          {/* Why accordion */}
          <div className="mt-5 border-t border-slate-200 pt-3">
            <button
              onClick={() => setWhyOpen(v => !v)}
              className="w-full flex items-center justify-between text-sm font-medium text-slate-700 hover:text-slate-900 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-slate-500" />
                Why an ID check?
              </span>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${whyOpen ? 'rotate-180' : ''}`} />
            </button>
            {whyOpen && (
              <div className="mt-3 text-xs text-slate-600 leading-relaxed space-y-2">
                <p>
                  Evia requires every client to verify their identity before contacting care providers. This keeps the people receiving care, and the care providers who serve them, safe.
                </p>
                <ul className="list-disc pl-4 space-y-1 text-slate-500">
                  <li>Protects care providers from fake or fraudulent requests</li>
                  <li>Confirms you are who you say you are</li>
                  <li>Information is processed by Stripe and never stored on our servers</li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
