import React, { useState, useEffect } from 'react';
import { AlertTriangle, User, Star, DollarSign, Check, X, RefreshCw, Phone } from 'lucide-react';
import { Button } from './ui/Button';
import { getFunctions, httpsCallable } from 'firebase/functions';

interface BackupCaregiver {
    id: string;
    name: string;
    rating: number;
    hourlyRate: number;
    photoURL?: string;
    skills?: string[];
    matchScore?: number;
}

interface CaregiverCalloutModalProps {
    appointmentId: string;
    originalCaregiverName: string;
    date: string;
    time: string;
    onClose: () => void;
    onCaregiverSelected: (caregiverId: string, caregiverName: string) => void;
    onRefundRequested: () => void;
}

export const CaregiverCalloutModal: React.FC<CaregiverCalloutModalProps> = ({
    appointmentId,
    originalCaregiverName,
    date,
    time,
    onClose,
    onCaregiverSelected,
    onRefundRequested
}) => {
    const [backupOptions, setBackupOptions] = useState<BackupCaregiver[]>([]);
    const [loading, setLoading] = useState(true);
    const [selecting, setSelecting] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showRefundConfirm, setShowRefundConfirm] = useState(false);

    const functions = getFunctions();

    useEffect(() => {
        loadBackupOptions();
    }, [appointmentId]);

    const loadBackupOptions = async () => {
        try {
            setLoading(true);
            const getBackupOptions = httpsCallable(functions, 'v1-getBackupCaregiverOptions');
            const result = await getBackupOptions({ appointmentId });
            const data = result.data as { success: boolean; caregivers: BackupCaregiver[] };
            
            if (data.success) {
                setBackupOptions(data.caregivers);
            }
        } catch (err: any) {
            setError('Failed to load backup caregivers. Please try again.');
            console.error('Error loading backup options:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleSelectCaregiver = async (caregiver: BackupCaregiver) => {
        try {
            setSelecting(caregiver.id);
            const selectBackup = httpsCallable(functions, 'v1-selectBackupCaregiver');
            const result = await selectBackup({ 
                appointmentId, 
                backupCaregiverId: caregiver.id 
            });
            const data = result.data as { success: boolean; caregiverName: string };
            
            if (data.success) {
                onCaregiverSelected(caregiver.id, data.caregiverName);
            }
        } catch (err: any) {
            setError('Failed to select caregiver. Please try again.');
            console.error('Error selecting backup:', err);
        } finally {
            setSelecting(null);
        }
    };

    const handleRequestRefund = async () => {
        try {
            setSelecting('refund');
            const requestRefund = httpsCallable(functions, 'v1-requestCalloutRefund');
            await requestRefund({ 
                appointmentId, 
                reason: 'No suitable backup caregiver available' 
            });
            onRefundRequested();
        } catch (err: any) {
            setError('Failed to request refund. Please contact support.');
            console.error('Error requesting refund:', err);
        } finally {
            setSelecting(null);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl max-w-2xl w-full max-h-[90vh] overflow-hidden shadow-2xl">
                {/* Header */}
                <div className="bg-red-50 p-6 border-b border-red-100">
                    <div className="flex items-center gap-3">
                        <div className="bg-red-100 p-2 rounded-full">
                            <AlertTriangle className="w-6 h-6 text-red-600" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-red-900">Caregiver Cancelled</h2>
                            <p className="text-red-700 text-sm">
                                {originalCaregiverName} cancelled your appointment on {date} at {time}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto max-h-[60vh]">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <RefreshCw className="w-8 h-8 text-primary-600 animate-spin mb-4" />
                            <p className="text-slate-600">Finding backup caregivers...</p>
                        </div>
                    ) : error ? (
                        <div className="text-center py-8">
                            <p className="text-red-600 mb-4">{error}</p>
                            <Button onClick={loadBackupOptions} variant="secondary">
                                Try Again
                            </Button>
                        </div>
                    ) : backupOptions.length === 0 ? (
                        <div className="text-center py-8">
                            <AlertTriangle className="w-12 h-12 text-accent-400 mx-auto mb-4" />
                            <h3 className="text-lg font-semibold text-slate-900 mb-2">No Backup Caregivers Available</h3>
                            <p className="text-slate-600 mb-6">
                                We couldn't find any available caregivers for this time slot. 
                                You can request a full refund or reschedule.
                            </p>
                            <div className="flex gap-3 justify-center">
                                <Button onClick={() => setShowRefundConfirm(true)} variant="secondary">
                                    Request Refund
                                </Button>
                                <Button onClick={onClose}>
                                    Reschedule Later
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="mb-6">
                                <h3 className="text-lg font-semibold text-slate-900 mb-2">
                                    {backupOptions.length} Backup Caregiver{backupOptions.length !== 1 ? 's' : ''} Available
                                </h3>
                                <p className="text-slate-600 text-sm">
                                    These caregivers match your requirements and are available at your scheduled time.
                                    Select one to confirm immediately.
                                </p>
                            </div>

                            <div className="space-y-4">
                                {backupOptions.map((caregiver, index) => (
                                    <div 
                                        key={caregiver.id}
                                        className="border-2 border-slate-200 rounded-2xl p-4 hover:border-primary-300 transition-colors"
                                    >
                                        <div className="flex items-start gap-4">
                                            {/* Avatar */}
                                            <div className="w-16 h-16 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden">
                                                {caregiver.photoURL ? (
                                                    <img 
                                                        src={caregiver.photoURL} 
                                                        alt={caregiver.name}
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    <User className="w-8 h-8 text-slate-400" />
                                                )}
                                            </div>

                                            {/* Info */}
                                            <div className="flex-grow">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <h4 className="font-bold text-slate-900">{caregiver.name}</h4>
                                                    {index === 0 && (
                                                        <span className="px-2 py-0.5 bg-primary-100 text-primary-700 text-xs font-semibold rounded-full">
                                                            Best Match
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex items-center gap-4 text-sm text-slate-600 mb-2">
                                                    <span className="flex items-center gap-1">
                                                        <Star className="w-4 h-4 text-accent-400 fill-current" />
                                                        {caregiver.rating ? caregiver.rating.toFixed(1) : '4.5'}
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <DollarSign className="w-4 h-4 text-green-600" />
                                                        ${caregiver.hourlyRate}/hr
                                                    </span>
                                                </div>

                                                {caregiver.skills && caregiver.skills.length > 0 && (
                                                    <div className="flex flex-wrap gap-1 mb-3">
                                                        {caregiver.skills.slice(0, 3).map((skill, i) => (
                                                            <span 
                                                                key={i}
                                                                className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full"
                                                            >
                                                                {skill}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>

                                            {/* Select Button */}
                                            <Button
                                                onClick={() => handleSelectCaregiver(caregiver)}
                                                disabled={selecting === caregiver.id}
                                                className="flex-shrink-0"
                                                size="sm"
                                            >
                                                {selecting === caregiver.id ? (
                                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                                ) : (
                                                    <>
                                                        <Check className="w-4 h-4 mr-1" />
                                                        Select
                                                    </>
                                                )}
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Other Options */}
                            <div className="mt-8 pt-6 border-t border-slate-200">
                                <p className="text-sm text-slate-600 mb-4">
                                    Don't see a caregiver you like?
                                </p>
                                <div className="flex gap-3">
                                    <Button 
                                        onClick={() => setShowRefundConfirm(true)} 
                                        variant="secondary"
                                        className="flex-1"
                                    >
                                        Request Refund
                                    </Button>
                                    <Button 
                                        onClick={onClose}
                                        variant="secondary"
                                        className="flex-1"
                                    >
                                        Reschedule
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Close Button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 hover:bg-white/20 rounded-full transition-colors"
                >
                    <X className="w-5 h-5 text-red-700" />
                </button>

                {/* Refund Confirmation Modal */}
                {showRefundConfirm && (
                    <div className="absolute inset-0 bg-white/95 backdrop-blur-sm flex items-center justify-center p-6">
                        <div className="text-center max-w-sm">
                            <AlertTriangle className="w-12 h-12 text-accent-400 mx-auto mb-4" />
                            <h3 className="text-lg font-bold text-slate-900 mb-2">Request Refund?</h3>
                            <p className="text-slate-600 mb-6">
                                We'll process a full refund for this appointment. 
                                This may take 3-5 business days to appear in your account.
                            </p>
                            <div className="flex gap-3">
                                <Button 
                                    onClick={() => setShowRefundConfirm(false)} 
                                    variant="secondary"
                                    className="flex-1"
                                >
                                    Cancel
                                </Button>
                                <Button 
                                    onClick={handleRequestRefund}
                                    disabled={selecting === 'refund'}
                                    className="flex-1"
                                >
                                    {selecting === 'refund' ? (
                                        <RefreshCw className="w-4 h-4 animate-spin" />
                                    ) : (
                                        'Confirm Refund'
                                    )}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CaregiverCalloutModal;
