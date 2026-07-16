import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Star, MapPin, ShieldCheck, Calendar, Loader2 } from 'lucide-react';
import { functions } from '../../lib/firebase';
import { LookingForSection } from './LookingForSection';
import type { Caregiver } from '../../types';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';
import { BloomMark } from '../ui/BloomMark';

export const PublicCaregiverProfile: React.FC = () => {
  const { id } = useParams();
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id || !functions) { setLoading(false); setNotFound(true); return; }
      try {
        // Server callable, NOT direct Firestore: caregivers/{id} and users/{id}
        // reads are rules-gated, so unauthenticated visitors from a texted
        // /p/{id} link used to land on "Profile not found". The callable is
        // public and returns only the safe profile subset.
        const getProfile = functions.httpsCallable('v1-publicCaregiverProfile');
        const res: any = await getProfile({ id });
        if (!active) return;
        if (res?.data?.found && res.data.profile) setProfile(res.data.profile as Caregiver);
        else setNotFound(true);
      } catch {
        if (active) setNotFound(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
      </div>
    );
  }

  if (notFound || !profile) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4 text-center">
        <p className="text-2xl font-bold text-slate-900 mb-2">Profile not found</p>
        <p className="text-sm text-slate-500 mb-6">This caregiver profile doesn't exist or is no longer available.</p>
        <Link to="/" className="text-sm font-semibold text-primary-600 hover:text-primary-700">← Back to Evia</Link>
      </div>
    );
  }

  const hidden = (profile as any).profileVisibility === 'hidden';
  if (hidden) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 px-4 text-center">
        <p className="text-2xl font-bold text-slate-900 mb-2">Profile unavailable</p>
        <p className="text-sm text-slate-500 mb-6">This caregiver has hidden their profile.</p>
        <Link to="/" className="text-sm font-semibold text-primary-600 hover:text-primary-700">← Back to Evia</Link>
      </div>
    );
  }

  const photo = profile.photo || profile.imageUrl || (profile as any).profilePhoto || (profile as any).photoURL;
  const city = [profile.city, profile.state].filter(Boolean).join(', ') || profile.location;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-ink-900 flex items-center justify-center shadow-sm"><BloomMark className="w-5 h-5 text-white" /></div>
            <span className="font-bold text-slate-900 tracking-tight">Evia</span>
          </Link>
          <Link to="/client/signup" className="text-sm font-semibold text-primary-600 hover:text-primary-700">
            Find a caregiver →
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 md:px-6 py-6 pb-24">
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-6">
          <div className="bg-gradient-to-r from-primary-500 to-primary-600 h-24" />
          <div className="px-6 pb-5">
            <div className="flex items-end justify-between -mt-10 mb-4">
              <div className="w-20 h-20 rounded-full border-4 border-white bg-slate-200 overflow-hidden shadow-md flex-shrink-0 flex items-center justify-center text-slate-500 text-xl font-bold">
                {photo ? <img src={photo} alt={profile.name} className="w-full h-full object-cover" /> : profile.name?.charAt(0).toUpperCase()}
              </div>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              {profile.name}
              {profile.verified && <ShieldCheck className="w-5 h-5 text-blue-500" fill="currentColor" />}
            </h1>
            <CaregiverVerificationBadges verified={profile.verified} backgroundCheckStatus={profile.backgroundCheckStatus} className="mt-2" />
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500 mt-1">
              {profile.rating != null && (
                <span className="flex items-center gap-1">
                  <Star className="w-3.5 h-3.5 text-primary-400" fill="currentColor" />
                  <span className="font-medium text-slate-700">{profile.rating.toFixed(1)}</span>
                  <span>({profile.reviewCount ?? 0} reviews)</span>
                </span>
              )}
              {city && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {city}
                </span>
              )}
              {profile.hourlyRate > 0 && (
                <span className="font-semibold text-primary-600">${profile.hourlyRate}/hr</span>
              )}
            </div>
          </div>
        </div>

        {profile.introVideoUrl && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6">
            <p className="font-bold text-slate-900 mb-3">Meet {profile.name.split(' ')[0]}</p>
            <div className="rounded-xl overflow-hidden bg-slate-900">
              <video src={profile.introVideoUrl} controls className="w-full max-h-96" />
            </div>
          </div>
        )}

        <LookingForSection profile={profile} />

        {profile.bio && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 mt-4">
            <p className="font-bold text-slate-900 mb-2">About {profile.name.split(' ')[0]}</p>
            <p className="text-sm text-slate-700 whitespace-pre-line">{profile.bio}</p>
          </div>
        )}

        {profile.skills && profile.skills.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 mt-4">
            <p className="font-bold text-slate-900 mb-3">Skills &amp; Services</p>
            <div className="flex flex-wrap gap-2">
              {profile.skills.map(s => (
                <span key={s} className="px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-medium">{s}</span>
              ))}
            </div>
          </div>
        )}


        <div className="bg-primary-50 border border-primary-200 rounded-2xl p-5 mt-6 flex items-center justify-between gap-4">
          <div>
            <p className="font-bold text-slate-900">Want to book {profile.name.split(' ')[0]}?</p>
            <p className="text-sm text-slate-600">Create an Evia account to send a booking request.</p>
          </div>
          <Link to="/client/signup" className="px-5 py-2.5 rounded-full bg-primary-500 hover:bg-primary-600 text-white text-sm font-semibold whitespace-nowrap">
            Get started
          </Link>
        </div>
      </main>
    </div>
  );
};
