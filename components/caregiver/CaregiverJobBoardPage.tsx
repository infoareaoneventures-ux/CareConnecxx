import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { JobBoard } from './JobBoard';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import type { Caregiver } from '../../types';

export const CaregiverJobBoardPage: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser, addToast } = useCareConnex();
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) { setLoading(false); return; }
      try {
        const p = await dbService.getUser(currentUser.uid);
        if (active && p) setProfile(p as any);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Find your perfect job</h1>
        <p className="text-sm text-slate-500 mb-6">Senior-care opportunities near you. Apply, save, or hide posts as you go.</p>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
          </div>
        ) : (
          <JobBoard
            onShowToast={addToast}
            profile={profile}
            onJobAccepted={() => navigate('/caregiver/bookings')}
            hideApplicationsTab
          />
        )}
      </div>
    </div>
  );
};
