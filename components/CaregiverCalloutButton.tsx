import React, { useState } from 'react';
import { AlertTriangle, Phone, X, Check, Loader2 } from 'lucide-react';
import { Button } from './ui/Button';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useCareConnex } from '../context/CareConnexContext';

interface CaregiverCalloutButtonProps {
    appointmentId: string;
    clientName: string;
    date: string;
    time: string;
    onCalloutSubmitted: () => void;
}

export const CaregiverCalloutButton: React.FC<CaregiverCalloutButtonProps> = ({
    appointmentId,
    clientName,
    date,
    time,
    onCalloutSubmitted
}) => {
    const { addToast } = useCareConnex();
    const [showConfirm, setShowConfirm] = useState(false);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const handleCallout = async () => {
        if (!reason.trim()) return;
        
        try {
            setSubmitting(true);
            const functions = getFunctions();
            
            // Update appointment status to trigger the callout flow
            const { getFirestore, doc, updateDoc } = await import('firebase/firestore');
            const { db } = await import('../lib/firebase');
            if (!db) throw new Error('Firestore not initialized');

            await updateDoc(doc(db, 'appointments', appointmentId), {
                status: 'caregiver_cancelled',
                cancelledBy: 'caregiver',
                caregiverCalloutReason: reason,
                cancelledAt: new Date().toISOString(),
                needsBackup: true
            });

            setSubmitted(true);
            setTimeout(() => {
                onCalloutSubmitted();
                setShowConfirm(false);
            }, 2000);
        } catch (error) {
            console.error('Error calling out:', error);
            addToast('Failed to submit callout. Please try again or contact support.', 'error');
        } finally {
            setSubmitting(false);
        }
    };

    if (submitted) {
        return (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
                <div className="bg-green-100 p-2 rounded-full">
                    <Check className="w-5 h-5 text-green-600" />
                </div>
                <div>
                    <p className="font-semibold text-green-900">Callout Submitted</p>
                    <p className="text-sm text-green-700">The client has been notified and backup options are being found.</p>
                </div>
            </div>
        );
    }

    return (
        <>
            <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-2 text-red-600 hover:text-red-700 font-medium text-sm px-3 py-2 rounded-lg hover:bg-red-50 transition-colors"
            >
                <AlertTriangle className="w-4 h-4" />
                Can't Make This Shift?
            </button>

            {showConfirm && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="bg-red-100 p-2 rounded-full">
                                <AlertTriangle className="w-6 h-6 text-red-600" />
                            </div>
                            <div>
                                <h3 className="text-lg font-bold text-slate-900">Call Out of Shift</h3>
                                <p className="text-sm text-slate-500">
                                    {clientName} - {date} at {time}
                                </p>
                            </div>
                        </div>

                        <div className="mb-4">
                            <label className="block text-sm font-medium text-slate-700 mb-2">
                                Reason for callout (required)
                            </label>
                            <textarea
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="Please explain why you can't make this shift..."
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-red-100 focus:border-red-300 outline-none resize-none"
                                rows={3}
                            />
                        </div>

                        <div className="bg-accent-50 border border-accent-200 rounded-lg p-3 mb-4">
                            <p className="text-sm text-accent-800">
                                <strong>Note:</strong> This will immediately notify the client and trigger a search for backup caregivers. 
                                Please only use this for legitimate emergencies or unavoidable conflicts.
                            </p>
                        </div>

                        <div className="flex gap-3">
                            <Button
                                onClick={() => setShowConfirm(false)}
                                variant="secondary"
                                className="flex-1"
                                disabled={submitting}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={handleCallout}
                                disabled={!reason.trim() || submitting}
                                className="flex-1 bg-red-600 hover:bg-red-700"
                            >
                                {submitting ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    'Confirm Callout'
                                )}
                            </Button>
                        </div>

                        <button
                            onClick={() => setShowConfirm(false)}
                            className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            )}
        </>
    );
};

export default CaregiverCalloutButton;
