import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { ViewType } from '../types';
import { useCareConnex } from '../context/CareConnexContext';

import { CaregiverOnboardingDashboard } from './caregiver/CaregiverOnboardingDashboard';
import { CaregiverOnboardingWizard } from './caregiver/CaregiverOnboardingWizard';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';

interface CaregiverDashboardProps {
   onNavigate: (view: ViewType, data?: any) => void;
}

export const CaregiverDashboard: React.FC<CaregiverDashboardProps> = ({ onNavigate }) => {
   const { currentUser, caregiverProfile, refreshCaregiverProfile, addToast: onShowToast } = useCareConnex();
   const [showWizard, setShowWizard] = useState(false);

   useEffect(() => {
      if (!caregiverProfile) return;
      const fromSignup = sessionStorage.getItem('careconnex_show_caregiver_wizard') === 'true';
      if (fromSignup) {
         sessionStorage.removeItem('careconnex_show_caregiver_wizard');
         setShowWizard(true);
      } else if ((caregiverProfile as any)?.onboardingStatus === 'incomplete') {
         setShowWizard(true);
      }
   }, [caregiverProfile]);

   if (!caregiverProfile) {
      return (
         <div className="min-h-screen flex items-center justify-center bg-slate-50">
            <Loader2 className="w-8 h-8 text-accent-500 animate-spin" />
         </div>
      );
   }

   return (
      <div className="min-h-screen bg-slate-50 pb-24">
         <CaregiverTopNav />

         {showWizard && currentUser?.uid && (
            <CaregiverOnboardingWizard
               uid={currentUser.uid}
               firstName={(caregiverProfile as any).firstName || currentUser.displayName?.split(' ')[0] || ''}
               city={(caregiverProfile as any).city || ''}
               state={(caregiverProfile as any).state || ''}
               onComplete={() => { setShowWizard(false); refreshCaregiverProfile(); }}
               onShowToast={onShowToast}
            />
         )}

         <CaregiverOnboardingDashboard
            profile={caregiverProfile}
            onNavigate={onNavigate}
            onShowToast={onShowToast}
         />
      </div>
   );
};
