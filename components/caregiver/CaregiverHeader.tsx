import React from 'react';
import { ShieldAlert, Loader2, ArrowUpRight } from 'lucide-react';
import { Button } from '../ui/Button';
import { Caregiver, ViewType } from '../../types';
import { NotificationDropdown } from '../ui/NotificationDropdown';

interface CaregiverHeaderProps {
    currentUser: any; // Using 'any' briefly to match authService return, ideally typed stronger
    profile: Caregiver | null;
    onNavigate: (view: ViewType) => void;
}

export const CaregiverHeader: React.FC<CaregiverHeaderProps> = ({
    currentUser,
    profile,
    onNavigate,
}) => {
    return (
        <>
            {/* Greeting Header */}
            <div className="flex justify-between items-center mb-6 relative z-10">
                <div>
                    <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Hello, {currentUser?.displayName?.split(' ')[0] || 'Caregiver'}</h2>
                    <p className="text-slate-500 font-medium">Ready to make a difference today?</p>
                </div>
                <div className="flex items-center gap-3">
                    <NotificationDropdown />
                    <button
                        onClick={() => onNavigate('caregiver-profile')}
                        className="w-12 h-12 rounded-full bg-gradient-to-br from-primary-100 to-primary-200 flex items-center justify-center text-primary-700 font-bold text-lg border-2 border-white shadow-lg hover:scale-105 transition-transform overflow-hidden"
                    >
                        {(profile?.photo || profile?.imageUrl) ? (
                            <img 
                                src={profile.photo || profile.imageUrl} 
                                alt="Profile" 
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                    // If image fails to load, show initials instead
                                    e.currentTarget.style.display = 'none';
                                }}
                            />
                        ) : (
                            <span>{currentUser?.displayName?.substring(0, 2).toUpperCase() || 'ME'}</span>
                        )}
                    </button>
                </div>
            </div>

            {profile && !profile.verified && (
                <div className="mb-8 bg-white/80 backdrop-blur-md border border-red-100 rounded-3xl p-5 flex items-start gap-5 shadow-xl shadow-red-100/50 animate-pulse relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-8 opacity-5">
                        <ShieldAlert size={120} className="text-red-500" />
                    </div>
                    <div className="bg-red-50 p-3 rounded-2xl relative z-10">
                        <ShieldAlert className="w-8 h-8 text-red-600" />
                    </div>
                    <div className="flex-grow relative z-10">
                        <h3 className="font-bold text-slate-900 text-lg">Action Required: Verification Pending</h3>
                        <p className="text-slate-600 mb-4 leading-relaxed">
                            {(profile.verificationStatus === 'submitted' || profile.backgroundCheckStatus === 'pending')
                                ? "Your verification is currently under review by our team. This typically takes 24-48 hours."
                                : "You must complete verification before you can accept jobs."}
                        </p>
                        {(profile.verificationStatus === 'submitted' || profile.backgroundCheckStatus === 'pending') ? (
                            <div className="inline-flex items-center text-sm font-bold text-red-800 bg-red-50 px-4 py-2 rounded-xl border border-red-100">
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Review in Progress
                            </div>
                        ) : (
                            <Button size="sm" onClick={() => onNavigate('caregiver-membership')} className="bg-red-600 hover:bg-red-700 text-white border-none shadow-lg shadow-red-500/30 rounded-xl px-6">
                                Complete Registration <ArrowUpRight className="w-4 h-4 ml-2" />
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </>
    );
};
