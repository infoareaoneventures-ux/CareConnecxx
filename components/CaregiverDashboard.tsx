import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { ViewType } from '../types';
import { useCareConnex } from '../context/CareConnexContext';
import { dbService } from '../services/api';
import { db } from '../lib/firebase';
import { useDeviceClass } from '../hooks/useDeviceClass';
import { MobileHandoff } from './auth/onboarding/MobileHandoff';
import { QRHandoff } from './auth/onboarding/QRHandoff';

import { CaregiverHomeDashboard } from './caregiver/CaregiverHomeDashboard';
import { CaregiverOnboardingWizard } from './caregiver/CaregiverOnboardingWizard';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';

interface CaregiverDashboardProps {
   onNavigate: (view: ViewType, data?: any) => void;
}

export const CaregiverDashboard: React.FC<CaregiverDashboardProps> = ({ onNavigate }) => {
   const { currentUser, addToast: onShowToast } = useCareConnex();
   const [profile, setProfile] = useState<any>(null);
   const [docMissing, setDocMissing] = useState(false);
   const device = useDeviceClass();

   useEffect(() => {
      if (!currentUser?.uid || !db) return;
      const unsub = db.collection('caregivers').doc(currentUser.uid).onSnapshot(snap => {
         if (!snap.exists) {
            // Caregiver hasn't texted Evia yet — no profile doc created yet
            setDocMissing(true);
            return;
         }
         setDocMissing(false);
         const cgData = { uid: snap.id, ...snap.data() } as any;
         // lat/lng may live in the users doc for accounts created before server-side geocoding
         // — merge it in so distance filtering works the same as getUser()
         if (cgData.latitude == null && cgData.lat == null) {
            db!.collection('users').doc(currentUser.uid).get()
               .then(uSnap => setProfile({ ...(uSnap.exists ? uSnap.data() : {}), ...cgData }))
               .catch(() => setProfile(cgData));
         } else {
            setProfile(cgData);
         }
      }, () => {
         dbService.getUser(currentUser.uid).then(p => { if (p) setProfile(p); }).catch(() => {});
      });
      return unsub;
   }, [currentUser?.uid]);

   // No profile doc yet — show wizard if they've already texted Evia, handoff screen if not
   if (docMissing && !profile) {
      if (currentUser?.eviaConnected && currentUser?.uid) {
         return (
            <div className="min-h-screen bg-paper-50 pb-24">
               <CaregiverTopNav />
               <CaregiverOnboardingWizard
                  uid={currentUser.uid}
                  firstName={currentUser.displayName?.split(' ')[0] || ''}
                  onComplete={() => { /* doc will appear via onSnapshot once wizard writes it */ }}
                  onShowToast={onShowToast}
               />
            </div>
         );
      }

      const linqPhone = (() => {
         try { return sessionStorage.getItem('evia_linq_phone') || ''; } catch { return ''; }
      })();

      return (
         <div className="min-h-screen bg-paper-50 flex flex-col">
            <CaregiverTopNav />
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-10">
               <div className="w-full max-w-sm space-y-6">
                  <div className="text-center space-y-2">
                     <h2 className="text-xl font-display font-semibold text-ink-900 tracking-[-0.02em]">One step left</h2>
                     <p className="text-ink-600 text-sm leading-relaxed">
                        Text Evia to finish setting up your caregiver profile. She'll walk you through the rest.
                     </p>
                  </div>

                  {linqPhone ? (
                     device === 'mobile' ? (
                        <MobileHandoff
                           linqPhone={linqPhone}
                           tone="dark"
                           caption="Tap below to open Messages. We've filled in a quick 'Hey Evia' — just hit send."
                           ctaLabel="Open Messages"
                           helper="Evia will reply and walk you through the rest of your setup."
                        />
                     ) : (
                        <QRHandoff
                           linqPhone={linqPhone}
                           tone="dark"
                           caption="Scan with your phone's camera to open Messages with a quick 'Hey Evia' ready to send."
                           helper="No camera? Text the number above with the words Hey Evia."
                        />
                     )
                  ) : (
                     <div className="rounded-2xl bg-white border border-slate-200 px-5 py-4 text-center text-sm text-slate-600 leading-relaxed">
                        Check your phone for the text from Evia, or visit this page from your phone to open Messages directly.
                     </div>
                  )}
               </div>
            </div>
         </div>
      );
   }

   if (!profile) {
      return (
         <div className="min-h-screen flex items-center justify-center bg-paper-50">
            <Loader2 className="w-8 h-8 text-accent-500 animate-spin" />
         </div>
      );
   }

   return (
      <div className="min-h-screen bg-paper-50 pb-24">
         <CaregiverTopNav />

         <CaregiverHomeDashboard
            profile={profile}
            onNavigate={onNavigate}
            onShowToast={onShowToast}
         />
      </div>
   );
};
