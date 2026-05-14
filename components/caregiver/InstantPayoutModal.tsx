import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { DollarSign, Clock, AlertCircle, Check, Zap, Calendar } from 'lucide-react';

export type PayoutMethod = 'instant' | 'standard';

interface InstantPayoutModalProps {
    availableBalance: number;
    onClose: () => void;
    onConfirm: (method: PayoutMethod) => Promise<void>;
    onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const InstantPayoutModal: React.FC<InstantPayoutModalProps> = ({
    availableBalance,
    onClose,
    onConfirm,
    onShowToast,
}) => {
    const [processing, setProcessing] = useState(false);
    const [method, setMethod] = useState<PayoutMethod>('instant');

    const instantFee = Math.max(availableBalance * 0.015, 0.50);
    const fee = method === 'instant' ? instantFee : 0;
    const netAmount = availableBalance - fee;

    const handleConfirm = async () => {
        if (availableBalance < 1) {
            onShowToast('Minimum payout amount is $1.00', 'error');
            return;
        }

        setProcessing(true);
        try {
            await onConfirm(method);
            onShowToast(
                method === 'instant'
                    ? 'Instant payout initiated! Funds will arrive in 30 minutes.'
                    : 'Standard payout initiated! Funds will arrive in 2-3 business days.',
                'success',
            );
            onClose();
        } catch (error: any) {
            console.error('Payout error:', error);
            onShowToast(error.message || 'Payout failed. Please try again.', 'error');
        } finally {
            setProcessing(false);
        }
    };

    const MethodCard: React.FC<{
        value: PayoutMethod;
        icon: React.ReactNode;
        title: string;
        subtitle: string;
    }> = ({ value, icon, title, subtitle }) => {
        const selected = method === value;
        return (
            <button
                type="button"
                onClick={() => setMethod(value)}
                className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${
                    selected
                        ? 'border-blue-500 bg-blue-50 shadow-sm'
                        : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
            >
                <div className="flex items-center gap-2 mb-1">
                    {icon}
                    <span className="font-semibold text-gray-900 text-sm">{title}</span>
                </div>
                <p className="text-xs text-gray-600">{subtitle}</p>
            </button>
        );
    };

    return createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center space-x-3">
                        <div className="bg-blue-100 p-3 rounded-xl">
                            <DollarSign className="w-6 h-6 text-blue-600" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-gray-900">Cash Out</h2>
                            <p className="text-sm text-gray-500">Transfer earnings to your bank</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-gray-600 transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Method picker */}
                <div className="flex gap-2 mb-4">
                    <MethodCard
                        value="instant"
                        icon={<Zap className="w-4 h-4 text-blue-600" />}
                        title="Instant"
                        subtitle="30 min · 1.5% fee"
                    />
                    <MethodCard
                        value="standard"
                        icon={<Calendar className="w-4 h-4 text-blue-600" />}
                        title="Standard"
                        subtitle="2-3 days · free"
                    />
                </div>

                {/* Amount Breakdown */}
                <div className="bg-gradient-to-br from-blue-50 to-blue-50 rounded-xl p-6 mb-6">
                    <div className="space-y-4">
                        <div className="flex justify-between items-center">
                            <span className="text-gray-600">Available Balance</span>
                            <span className="text-2xl font-bold text-gray-900">${availableBalance.toFixed(2)}</span>
                        </div>
                        <div className="border-t border-gray-200 pt-4">
                            <div className="flex justify-between items-center text-sm mb-2">
                                <span className="text-gray-600">
                                    {method === 'instant' ? 'Instant Payout Fee (1.5%)' : 'Standard Payout Fee'}
                                </span>
                                <span className="text-gray-900 font-medium">
                                    {method === 'instant' ? `-$${fee.toFixed(2)}` : 'Free'}
                                </span>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-gray-900 font-semibold">You'll Receive</span>
                                <span className="text-3xl font-bold text-green-600">${netAmount.toFixed(2)}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Info Cards */}
                <div className="space-y-3 mb-6">
                    <div className="flex items-start space-x-3 bg-blue-50 p-3 rounded-lg">
                        <Clock className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                        <div>
                            <p className="text-sm font-medium text-blue-900">
                                {method === 'instant' ? 'Arrives in 30 minutes' : 'Arrives in 2-3 business days'}
                            </p>
                            <p className="text-xs text-blue-700">Funds will be sent to your connected bank account</p>
                        </div>
                    </div>

                    {availableBalance < 1 && (
                        <div className="flex items-start space-x-3 bg-red-50 p-3 rounded-lg">
                            <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
                            <div>
                                <p className="text-sm font-medium text-red-900">Minimum amount not met</p>
                                <p className="text-xs text-red-700">You need at least $1.00 to request a payout</p>
                            </div>
                        </div>
                    )}

                    <div className="flex items-start space-x-3 bg-green-50 p-3 rounded-lg">
                        <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                        <div>
                            <p className="text-sm font-medium text-green-900">Secure & Verified</p>
                            <p className="text-xs text-green-700">Powered by Stripe</p>
                        </div>
                    </div>
                </div>

                {/* Action Buttons */}
                <div className="flex space-x-3">
                    <button
                        onClick={onClose}
                        className="flex-1 px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-xl font-semibold hover:bg-gray-50 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={processing || availableBalance < 1}
                        className="flex-1 px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-600 text-white rounded-xl font-semibold hover:from-blue-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-500/30"
                    >
                        {processing ? (
                            <span className="flex items-center justify-center">
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                                Processing...
                            </span>
                        ) : (
                            'Confirm Payout'
                        )}
                    </button>
                </div>

                {/* Disclaimer */}
                <p className="text-xs text-gray-500 text-center mt-4">
                    Standard payouts (2-3 business days) are always free. Instant payout fees help cover processing costs.
                </p>
            </div>
        </div>
    , document.body);
};
