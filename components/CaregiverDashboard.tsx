import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Caregiver, ViewType } from '../types';
import { dbService } from '../services/api';
import { useCareConnex } from '../context/CareConnexContext';

import { CaregiverHeader } from './caregiver/CaregiverHeader';
import { OnboardingChecklist } from './caregiver/OnboardingChecklist';
import { CaregiverOnboardingDashboard } from './caregiver/CaregiverOnboardingDashboard';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';
import { BackgroundCheckModal } from './BackgroundCheckModal';

interface CaregiverDashboardProps {
   onNavigate: (view: ViewType, data?: any) => void;
}

export const CaregiverDashboard: React.FC<CaregiverDashboardProps> = ({ onNavigate }) => {
   const { currentUser, addToast: onShowToast } = useCareConnex();

   const [profile, setProfile] = useState<Caregiver | null>(null);
   const [showFullChecklist, setShowFullChecklist] = useState(false);
   const [showBgModal, setShowBgModal] = useState(false);

   useEffect(() => {
      let isMounted = true;
      const fetchProfile = async () => {
         if (!currentUser?.uid) return;
         try {
            const userDoc = await dbService.getUser(currentUser.uid);
            if (isMounted && userDoc) {
               setProfile(userDoc as any);
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

   const handleStartBackgroundCheck = () => setShowBgModal(true);

   return (
      <div className="min-h-screen bg-slate-50 pb-24">
         <CaregiverTopNav />

         {showBgModal && !showFullChecklist && (
            <BackgroundCheckModal
               onClose={() => setShowBgModal(false)}
               onShowToast={onShowToast}
               onSuccess={() => {
                  setShowBgModal(false);
                  refreshProfile();
               }}
            />
         )}

         {/* Mobile-only header with hamburger/avatar */}
         <div className="md:hidden">
            <CaregiverHeader
               currentUser={currentUser}
               profile={profile}
               onNavigate={onNavigate}
               onStartBackgroundCheck={handleStartBackgroundCheck}
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
               onStartBackgroundCheck={handleStartBackgroundCheck}
            />
         )}
      </div>
   );
};
