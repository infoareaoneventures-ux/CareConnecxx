import React from 'react';
import { AlertCircle, X } from 'lucide-react';
import { EmergencyAlert } from '../types';

// Prominent in-app surface for active emergency_alerts. Both the EmergencySOS
// UI and the agent's trigger_emergency_alert MCP tool write the collection;
// this banner (fed by dbService.subscribeToEmergencyAlerts via
// CareConnexContext) makes an active alert visible in the app itself, not just
// via push/SMS fan-out. Dismissal is local-only: firestore.rules restrict
// emergency_alerts updates to admins, so resolving happens server-side and the
// banner also disappears when the alert's status leaves 'active'.

interface EmergencyAlertBannerProps {
    alerts: EmergencyAlert[];
    onDismiss: (alertId: string) => void;
}

export const EmergencyAlertBanner: React.FC<EmergencyAlertBannerProps> = ({ alerts, onDismiss }) => {
    if (alerts.length === 0) return null;

    return (
        <div className="fixed top-0 inset-x-0 z-[100]" role="alert" aria-live="assertive">
            {alerts.map(alert => (
                <div key={alert.id} className="px-4 py-3 bg-red-600 text-white flex items-center gap-3 shadow-md border-b border-red-700">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <p className="flex-1 text-sm font-semibold">
                        Emergency alert active — your caregiver and our support team have been notified.
                        <span className="font-normal text-white/80">
                            {' '}Started {new Date(alert.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
                            If this is a life-threatening emergency, call 911.
                        </span>
                    </p>
                    <button
                        onClick={() => onDismiss(alert.id)}
                        aria-label="Dismiss emergency alert banner"
                        className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-white/10 transition-colors flex-shrink-0"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
            ))}
        </div>
    );
};
