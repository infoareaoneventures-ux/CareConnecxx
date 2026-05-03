import React from 'react';
import { User, Gift } from 'lucide-react';
import { EmergencySOS } from '../EmergencySOS';
import { NotificationDropdown } from '../ui/NotificationDropdown';
import { AddToastFunction } from '../../types';

interface DashboardHeaderProps {
    onShowToast: AddToastFunction;
    onNavigateProfile: () => void;
    onOpenReferral?: () => void;
    userName?: string;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({ onShowToast, onNavigateProfile, onOpenReferral, userName }) => {
    // Get time-based greeting
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';
    
    return (
        <div className="flex justify-between items-center mb-6">
            <div>
                <h1 className="text-2xl font-bold text-slate-900">{greeting}, {userName?.split(' ')[0] || 'Welcome'}</h1>
                <p className="text-slate-500">Your care team is active today.</p>
            </div>
            <div className="flex gap-2 items-center">
                {onOpenReferral && (
                    <button
                        onClick={onOpenReferral}
                        className="px-4 py-2 bg-gradient-to-r from-accent-500 to-accent-500 text-white rounded-xl font-semibold hover:from-accent-600 hover:to-accent-600 transition-all flex items-center gap-2 shadow-md"
                        title="Refer friends & earn $25"
                    >
                        <Gift className="w-5 h-5" />
                        <span className="hidden sm:inline">Earn $25</span>
                    </button>
                )}
                <EmergencySOS onShowToast={onShowToast} initiatorType="client" className="px-4 py-2" />
                <NotificationDropdown />
                <button
                    onClick={onNavigateProfile}
                    className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold border-2 border-white shadow-sm ml-2"
                    aria-label="View Profile"
                >
                    <User className="w-6 h-6" />
                </button>
            </div>
        </div>
    );
};
