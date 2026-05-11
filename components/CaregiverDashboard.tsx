import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Caregiver, ViewType } from '../types';
import { dbService } from '../services/api';
import { useCareConnex } from '../context/CareConnexContext';

import { CaregiverHeader } from './caregiver/CaregiverHeader';
import { OnboardingChecklist } from './caregiver/OnboardingChecklist';
import { CaregiverOnboardingDashboard } from './caregiver/CaregiverOnboardingDashboard';
import { CaregiverOnboardingWizard } from './caregiver/CaregiverOnboardingWizard';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';

interface CaregiverDashboardProps {
   onNavigate: (view: ViewType, data?: any) => void;
}

export const CaregiverDashboard: React.FC<CaregiverDashboardProps> = ({ onNavigate }) => {
   const { currentUser, addToast: onShowToast } = useCareConnex();

   const [profile, setProfile] = useState<Caregiver | null>(null);
   const [showFullChecklist, setShowFullChecklist] = useState(false);
   const [showWizard, setShowWizard] = useState(false);

   useEffect(() => {
      let isMounted = true;
      const fetchProfile = async () => {
         if (!currentUser?.uid) return;
         try {
            const userDoc = await dbService.getUser(currentUser.uid);
            if (isMounted && userDoc) {
               setProfile(userDoc as any);
               // Show wizard for new signups (sessionStorage flag) or incomplete onboarding
               const fromSignup = sessionStorage.getItem('careconnex_show_caregiver_wizard') === 'true';
               if (fromSignup) {
                  sessionStorage.removeItem('careconnex_show_caregiver_wizard');
                  setShowWizard(true);
               } else if ((userDoc as any)?.onboardingStatus === 'incomplete') {
                  setShowWizard(true);
               }
            }
         } catch (error) {
            console.error('Error fetching profile:', error);
         }
      };
      if (currentUser) fetchProfile();
      return () => { isMounted = false; };
   }, [currentUser]);

   const refreshProfile = async () => {
      if (currentUser) {
         const allCaregivers = await dbService.getCaregivers(100);
         const p = allCaregivers.caregivers.find(c => c.uid === currentUser?.uid);
         if (p) setProfile(p);
      }
   };

   if (!profile) {
      return (
         <div className="min-h-screen flex items-center justify-center bg-slate-50">
            <Loader2 className="w-8 h-8 text-accent-500 animate-spin" />
         </div>
      );
   }

   return (
      <div className="min-h-screen bg-slate-50 pb-24">
         <CaregiverTopNav />

         {showWizard && currentUser?.uid && profile && (
            <CaregiverOnboardingWizard
               uid={currentUser.uid}
               firstName={(profile as any).firstName || currentUser.displayName?.split(' ')[0] || ''}
               city={(profile as any).city || ''}
               state={(profile as any).state || ''}
               onComplete={() => { setShowWizard(false); refreshProfile(); }}
               onShowToast={onShowToast}
            />
         )}

         {/* Mobile-only header with hamburger/avatar */}
         <div className="md:hidden">
            <CaregiverHeader
               currentUser={currentUser}
               profile={profile}
               onNavigate={onNavigate}
            />
         </div>

         {showFullChecklist ? (
            <OnboardingChecklist
               profile={profile}
               onUpdate={refreshProfile}
               onNavigate={onNavigate}
               onShowToast={onShowToast}
            />
         ) : (
            <CaregiverOnboardingDashboard
               profile={profile}
               onNavigate={onNavigate}
               onShowToast={onShowToast}
               onViewChecklist={() => setShowFullChecklist(true)}
            />
         )}
      </div>
   );
};
