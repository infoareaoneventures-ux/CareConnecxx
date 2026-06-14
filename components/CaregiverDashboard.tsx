import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { ViewType } from '../types';
import { useCareConnex } from '../context/CareConnexContext';
import { dbService } from '../services/api';
import { db } from '../lib/firebase';

import { CaregiverHomeDashboard } from './caregiver/CaregiverHomeDashboard';
import { CaregiverOnboardingWizard } from './caregiver/CaregiverOnboardingWizard';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';

interface CaregiverDashboardProps {
   onNavigate: (view: ViewType, data?: any) => void;
}

export const CaregiverDashboard: React.FC<CaregiverDashboardProps> = ({ onNavigate }) => {
   const { currentUser, addToast: onShowToast } = useCareConnex();
   const [profile, setProfile] = useState<any>(null);
   const [showWizard, setShowWizard] = useState(false);

   useEffect(() => {
      if (!currentUser?.uid || !db) return;
      const unsub = db.collection('caregivers').doc(currentUser.uid).onSnapshot(snap => {
         if (snap.exists) setProfile({ uid: snap.id, ...snap.data() });
      }, () => {
         dbService.getUser(currentUser.uid).then(p => { if (p) setProfile(p); }).catch(() => {});
      });
      return unsub;
   }, [currentUser?.uid]);

   const refreshProfile = async () => {
      if (!currentUser?.uid) return;
      const p = await dbService.getUser(currentUser.uid);
      if (p) setProfile(p);
   };

   useEffect(() => {
      if (!profile) return;
      // Cara SMS is the canonical onboarding (caregivers finish at onboardingStatus:'profile_complete').
      // The wizard is now only a recovery tool for legacy/web accounts left at 'incomplete'.
      if (profile?.onboardingStatus === 'incomplete') {
         setShowWizard(true);
      }
   }, [profile]);

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

         {showWizard && currentUser?.uid && (
            <CaregiverOnboardingWizard
               uid={currentUser.uid}
               firstName={(profile as any).firstName || currentUser.displayName?.split(' ')[0] || ''}
               city={(profile as any).city || ''}
               state={(profile as any).state || ''}
               onComplete={() => { setShowWizard(false); refreshProfile(); }}
               onShowToast={onShowToast}
            />
         )}

         <CaregiverHomeDashboard
            profile={profile}
            onNavigate={onNavigate}
            onShowToast={onShowToast}
         />
      </div>
   );
};
