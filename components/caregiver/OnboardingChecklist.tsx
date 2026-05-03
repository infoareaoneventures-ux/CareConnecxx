import React, { useState } from 'react';
import { Check, Shield, User, FileText, ChevronRight, Lock } from 'lucide-react';
import { dbService } from '../../services/api';
import { Caregiver, WeeklySchedule } from '../../types';
import { Button } from '../ui/Button';
import { SkillsSelector } from './SkillsSelector';
import { AvailabilityCalendar } from './AvailabilityCalendar';
import { RateSuggestion } from './RateSuggestion';
import { BackgroundCheckModal } from '../BackgroundCheckModal';

interface OnboardingChecklistProps {
    profile: Caregiver;
    onUpdate: () => void;
    onNavigate: (view: any) => void;
    onShowToast?: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const OnboardingChecklist: React.FC<OnboardingChecklistProps> = ({ profile, onUpdate, onNavigate, onShowToast }) => {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showBgModal, setShowBgModal] = useState(false);
    const [profileData, setProfileData] = useState({
        skills: profile.skills || [],
        weeklyAvailability: profile.weeklyAvailability || {
            monday: [],
            tuesday: [],
            wednesday: [],
            thursday: [],
            friday: [],
            saturday: [],
            sunday: []
        } as WeeklySchedule,
        hourlyRate: profile.hourlyRate || 25
    });

    const currentStep = profile.onboardingStep || 1;

    const bgCandidateId = profile.backgroundCheckData?.checkrCandidateId;
    const bgStatus = profile.backgroundCheckData?.status;
    const bgInvitationStatus = profile.backgroundCheckData?.invitationStatus;
    const bgApproved = bgStatus === 'clear' || profile.verificationStatus === 'approved';
    const bgSubmitted = !!bgCandidateId;
    const bgExpired = bgSubmitted && bgInvitationStatus === 'expired';

    const onShowToastSafe = (msg: string, type: 'success' | 'error' | 'info') =>
        onShowToast?.(msg, type);

    // Waiting / processing screen shown after caregiver advances to step 3
    if (currentStep === 3) {
        return (
            <div className="max-w-2xl mx-auto mt-10">
                <div className="text-center p-8 bg-white rounded-2xl shadow-xl border border-slate-200 mb-6">
                    <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                        <Shield className="w-10 h-10 text-blue-500" />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-900 mb-2">
                        {bgApproved ? 'Approved!' : 'Verification in Progress'}
                    </h2>
                    <p className="text-slate-500 mb-6 max-w-md mx-auto">
                        {bgApproved
                            ? 'You are approved and can start accepting jobs!'
                            : 'Thanks for submitting your information! Our team is reviewing your profile.'}
                    </p>
                </div>

                <div className="space-y-4">
                    <div className={`p-4 rounded-xl border flex items-center justify-between ${bgApproved ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${bgApproved ? 'bg-green-100' : 'bg-yellow-100'}`}>
                                <Lock className={`w-5 h-5 ${bgApproved ? 'text-green-600' : 'text-yellow-600'}`} />
                            </div>
                            <div>
                                <p className="font-medium text-slate-900">Background Check</p>
                                <p className="text-sm text-slate-500">
                                    {bgApproved ? 'Approved' : 'Under Review (24-48 hours)'}
                                </p>
                            </div>
                        </div>
                        {bgApproved && <Check className="w-5 h-5 text-green-500" />}
                    </div>
                </div>

                {!bgApproved && (
                    <div className="mt-6 p-4 bg-slate-50 rounded-lg text-sm text-slate-600">
                        <p className="font-medium">Your background check is processing. We'll notify you when it's approved.</p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <>
            {showBgModal && (
                <BackgroundCheckModal
                    onClose={() => setShowBgModal(false)}
                    onShowToast={onShowToastSafe}
                    onSuccess={() => {
                        setShowBgModal(false);
                        onUpdate();
                    }}
                />
            )}

            <div className="max-w-4xl mx-auto p-6 md:p-10">
                <div className="text-center mb-10">
                    <h1 className="text-3xl font-bold text-slate-900 mb-2">Welcome to CareConnex!</h1>
                    <p className="text-slate-500">Complete these steps to activate your account and start accepting jobs.</p>
                </div>

                <div className="grid md:grid-cols-3 gap-8">
                    {/* Steps Sidebar */}
                    <div className="space-y-4">
                        <div className={`p-4 rounded-xl border transition-all ${currentStep === 1 ? 'bg-white border-blue-500 shadow-md ring-1 ring-blue-500' : 'bg-slate-50 border-slate-200 opacity-70'}`}>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Step 1</span>
                                {currentStep > 1 && <Check className="w-4 h-4 text-green-500" />}
                            </div>
                            <h3 className="font-bold flex items-center"><User className="w-4 h-4 mr-2" /> Profile Setup</h3>
                        </div>

                        <div className={`p-4 rounded-xl border transition-all ${currentStep === 2 ? 'bg-white border-blue-500 shadow-md ring-1 ring-blue-500' : 'bg-slate-50 border-slate-200 opacity-70'}`}>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Step 2</span>
                                {currentStep > 2 && <Check className="w-4 h-4 text-green-500" />}
                            </div>
                            <h3 className="font-bold flex items-center"><Shield className="w-4 h-4 mr-2" /> Verification</h3>
                            <p className="text-xs text-slate-500 mt-1">Background Check</p>
                        </div>

                        <div className={`p-4 rounded-xl border transition-all ${currentStep === 3 ? 'bg-white border-blue-500 shadow-md ring-1 ring-blue-500' : 'bg-slate-50 border-slate-200'}`}>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Step 3</span>
                            </div>
                            <h3 className="font-bold flex items-center"><Check className="w-4 h-4 mr-2" /> Admin Approval</h3>
                        </div>
                    </div>

                    {/* Content Area */}
                    <div className="md:col-span-2">
                        {currentStep === 1 && (
                            <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 space-y-8">
                                <div>
                                    <h2 className="text-xl font-bold mb-4">Complete Your Profile</h2>
                                    <p className="text-slate-500 mb-6">Clients are 5x more likely to hire caregivers with a complete profile.</p>
                                </div>

                                <div className="pb-8 border-b border-slate-200">
                                    <SkillsSelector
                                        selectedSkills={profileData.skills}
                                        onSkillsChange={(skills) => setProfileData({ ...profileData, skills })}
                                    />
                                </div>

                                <div className="pb-8 border-b border-slate-200">
                                    <AvailabilityCalendar
                                        availability={profileData.weeklyAvailability}
                                        onAvailabilityChange={(availability) => setProfileData({ ...profileData, weeklyAvailability: availability })}
                                    />
                                </div>

                                <div className="pb-8 border-b border-slate-200">
                                    <RateSuggestion
                                        location={profile.location || 'Unknown'}
                                        skills={profileData.skills}
                                        certifications={profile.certifications}
                                        currentRate={profileData.hourlyRate}
                                        onRateChange={(rate) => setProfileData({ ...profileData, hourlyRate: rate })}
                                    />
                                </div>

                                <div>
                                    <h3 className="font-semibold text-slate-800 mb-4">Additional Profile Items</h3>
                                    <div className="space-y-4 mb-8">
                                        <div className="flex items-center p-3 bg-slate-50 rounded-lg">
                                            <div className={`w-3 h-3 rounded-full mr-3 ${profile.bio ? 'bg-green-500' : 'bg-slate-300'}`}></div>
                                            <span className={profile.bio ? 'text-slate-700' : 'text-slate-400'}>Bio & Experience</span>
                                        </div>
                                        <div className="flex items-center p-3 bg-slate-50 rounded-lg">
                                            <div className={`w-3 h-3 rounded-full mr-3 ${profile.photo ? 'bg-green-500' : 'bg-slate-300'}`}></div>
                                            <span className={profile.photo ? 'text-slate-700' : 'text-slate-400'}>Profile Photo</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex justify-between">
                                    <Button onClick={() => onNavigate('caregiver-profile')} variant="secondary">Edit Profile</Button>
                                    <Button onClick={async () => {
                                        await dbService.updateUser('caregivers', profile.uid!, {
                                            skills: profileData.skills,
                                            weeklyAvailability: profileData.weeklyAvailability,
                                            hourlyRate: profileData.hourlyRate,
                                            onboardingStep: 2
                                        });
                                        onUpdate();
                                    }} disabled={profileData.skills.length === 0}>
                                        Continue to Verification <ChevronRight className="w-4 h-4 ml-2" />
                                    </Button>
                                </div>
                            </div>
                        )}

                        {currentStep === 2 && (
                            <div className="space-y-6">
                                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                                    <h2 className="text-xl font-bold mb-2">Complete Verification</h2>
                                    <p className="text-slate-500">A background check is required to work on CareConnex.</p>
                                </div>

                                {/* Background Check Section */}
                                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                                    <div className="flex items-center mb-4">
                                        <Lock className="w-5 h-5 text-blue-500 mr-2" />
                                        <h3 className="text-lg font-bold">Background Check</h3>
                                        {bgApproved && (
                                            <span className="ml-auto text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">Approved</span>
                                        )}
                                        {!bgApproved && bgStatus === 'pending' && !bgExpired && (
                                            <span className="ml-auto text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded-full">Pending Review</span>
                                        )}
                                        {bgExpired && (
                                            <span className="ml-auto text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full">Link Expired</span>
                                        )}
                                        {bgStatus === 'consider' && (
                                            <span className="ml-auto text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded-full">Under Review</span>
                                        )}
                                        {bgStatus === 'suspended' && (
                                            <span className="ml-auto text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full">Action Required</span>
                                        )}
                                    </div>

                                    {bgSubmitted && !bgExpired ? (
                                        <div className="bg-slate-50 p-4 rounded-lg">
                                            <p className="text-sm text-slate-600">
                                                {bgApproved
                                                    ? 'Your background check has been approved.'
                                                    : bgStatus === 'suspended'
                                                        ? 'Your background check could not be completed. Please contact support.'
                                                        : 'Your background check is being processed. Check your email for a link from Checkr to complete your identity verification. This usually takes 24-48 hours.'}
                                            </p>
                                        </div>
                                    ) : bgExpired ? (
                                        <div className="space-y-4">
                                            <div className="bg-red-50 border border-red-200 p-4 rounded-lg">
                                                <p className="text-sm text-red-700 font-medium mb-1">Your verification link expired</p>
                                                <p className="text-sm text-red-600">The Checkr link sent to your email expired after 7 days. Request a new link to continue.</p>
                                            </div>
                                            <Button
                                                onClick={() => setShowBgModal(true)}
                                                className="w-full"
                                            >
                                                <Shield className="w-4 h-4 mr-2" />
                                                Resend Verification Link
                                            </Button>
                                        </div>
                                    ) : (
                                        <div className="space-y-4">
                                            <p className="text-sm text-slate-500">
                                                Start your background check powered by Checkr. You'll receive an email with a secure link to complete your identity verification — your SSN never touches CareConnecxx.
                                            </p>
                                            <Button
                                                onClick={() => setShowBgModal(true)}
                                                className="w-full"
                                            >
                                                <Shield className="w-4 h-4 mr-2" />
                                                Start Background Check
                                            </Button>
                                        </div>
                                    )}
                                </div>

                                {/* Navigation */}
                                <div className="flex justify-between pt-4">
                                    <Button variant="secondary" onClick={async () => {
                                        await dbService.updateUser('caregivers', profile.uid!, { onboardingStep: 1 });
                                        onUpdate();
                                    }}>Back</Button>

                                    {bgSubmitted && !bgExpired && (
                                        <Button
                                            disabled={isSubmitting}
                                            onClick={async () => {
                                                setIsSubmitting(true);
                                                try {
                                                    await dbService.updateUser('caregivers', profile.uid!, {
                                                        onboardingStep: 3,
                                                        verificationStatus: 'submitted',
                                                    });
                                                    onUpdate();
                                                } catch {
                                                    onShowToast?.('Failed to advance. Please try again.', 'error');
                                                } finally {
                                                    setIsSubmitting(false);
                                                }
                                            }}
                                        >
                                            {isSubmitting ? 'Saving...' : 'Continue'} <ChevronRight className="w-4 h-4 ml-2" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
};