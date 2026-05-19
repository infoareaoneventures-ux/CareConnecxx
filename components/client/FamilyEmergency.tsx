import React, { useState } from 'react';
import { AlertTriangle, X, Phone, Loader2 } from 'lucide-react';
import { getFunctions, httpsCallable } from 'firebase/functions';

interface FamilyEmergencyProps {
  appointmentId: string;
}

export const FamilyEmergency: React.FC<FamilyEmergencyProps> = ({ appointmentId }) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleConfirm = async () => {
    setSending(true);
    try {
      const triggerEmergency = httpsCallable(getFunctions(), 'triggerFamilyEmergency');
      await triggerEmergency({ appointmentId });
      setSent(true);
      setShowConfirm(false);
    } catch (err) {
      console.error('Emergency trigger failed:', err);
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="fixed bottom-6 right-6 z-50 bg-green-600 text-white rounded-2xl p-4 shadow-2xl max-w-xs">
        <div className="flex items-start gap-3">
          <Phone className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold">Help is on the way</p>
            <p className="text-xs opacity-90 mt-0.5">
              Your caregiver and our support team have been notified.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Persistent red button */}
      <button
        onClick={() => setShowConfirm(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white rounded-full px-4 py-3 shadow-2xl font-semibold text-sm transition-colors"
        aria-label="Family emergency alert"
      >
        <AlertTriangle className="w-5 h-5" />
        Emergency
      </button>

      {/* Confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <button
                onClick={() => setShowConfirm(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <h2 className="text-lg font-bold text-slate-900 mb-2">Send Emergency Alert?</h2>
            <p className="text-sm text-slate-600 mb-6">
              This will immediately alert your caregiver, our support team, and your emergency contact.
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={sending}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={sending}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2"
              >
                {sending && <Loader2 className="w-4 h-4 animate-spin" />}
                {sending ? 'Alerting…' : 'Yes, Send Alert'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
