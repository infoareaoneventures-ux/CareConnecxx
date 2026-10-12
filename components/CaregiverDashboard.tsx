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

   // Return from the membership checkout (CaregiverMembership.tsx successUrl
   // `/care-provider/dashboard?membership=success`): same pattern as the client
   // Membership page's `?success=true` — acknowledge once, strip the param.
   // The membership fields themselves arrive through the live caregivers/{uid}
   // listener above once the payment webhook writes them.
   useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('membership') !== 'success') return;
      onShowToast('Membership payment complete — thank you.', 'success');
      window.history.replaceState({}, '', '/care-provider/dashboard');
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []);

   // Payout fields (stripeAccountId/payoutsEnabled/chargesEnabled) live on the
   // owner-only private/payout subdoc, not the caregivers/{uid} doc the
   // onSnapshot above watches — fetch and merge separately, same pattern
   // CaregiverPaymentsPage.tsx already uses. Needed by CaregiverProgressCard's
   // "Payout Setup" onboarding step (Hamse, 2026-08-23).
   useEffect(() => {
      if (!currentUser?.uid) return;
      let active = true;
      dbService.getOwnCaregiverPayoutFields(currentUser.uid)
         .then(payout => { if (active) setProfile((prev: any) => prev ? { ...prev, ...payout } : prev); })
         .catch(() => {});
      return () => { active = false; };
   }, [currentUser?.uid]);

   // No profile doc yet — the setup wizard is owned by the CaregiverRoute overlay
   // (App.tsx renders it whenever the record is missing or not profile_complete),
   // so this page never mounts a second copy; it shows the handoff screen only
   // for a caregiver who has not connected with Evia yet.
   if (docMissing && !profile) {
      if (currentUser?.eviaConnected && currentUser?.uid) {
         return (
            <div className="min-h-screen bg-paper-50 pb-24">
               <CaregiverTopNav />
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
                        Text Evia to finish setting up your care provider profile. She'll walk you through the rest.
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
