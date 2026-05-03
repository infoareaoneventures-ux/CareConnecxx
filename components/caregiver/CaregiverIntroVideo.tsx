import React, { useEffect, useRef, useState } from 'react';
import { Video, Upload, Loader2, CheckCircle } from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import { uploadMedia } from '../../services/storageService';
import type { Caregiver } from '../../types';

// Sample videos shown in the right sidebar. Drop matching files in
// /public/sample-caregiver-videos/ and they'll play automatically; missing files
// render as a placeholder card without breaking layout.
interface SampleVideo {
  id: number;
  label: string;
  videoPath: string;
  posterPath?: string;
  durationHint: string;
}

const SAMPLE_VIDEOS: SampleVideo[] = [
  { id: 1, label: 'Laura C.', videoPath: '/sample-caregiver-videos/sample-1.mp4', posterPath: '/sample-caregiver-videos/sample-1.jpg', durationHint: '~28 seconds' },
  { id: 2, label: 'Sarah S.', videoPath: '/sample-caregiver-videos/sample-2.mp4', posterPath: '/sample-caregiver-videos/sample-2.jpg', durationHint: '~24 seconds' },
];

const SampleVideoCard: React.FC<{ sample: SampleVideo }> = ({ sample }) => {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(sample.videoPath, { method: 'HEAD' });
        if (active) setAvailable(res.ok && (res.headers.get('content-type') || '').startsWith('video'));
      } catch {
        if (active) setAvailable(false);
      }
    })();
    return () => { active = false; };
  }, [sample.videoPath]);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="aspect-video rounded-lg bg-slate-100 overflow-hidden flex items-center justify-center text-slate-300">
        {available === true ? (
          <video
            src={sample.videoPath}
            poster={sample.posterPath}
            controls
            preload="metadata"
            className="w-full h-full object-cover"
          />
        ) : (
          <Video className="w-8 h-8" />
        )}
      </div>
      <p className="mt-2 text-sm font-medium text-slate-700">{sample.label}</p>
      <p className="text-xs text-slate-400">
        {sample.durationHint} · Example
      </p>
    </div>
  );
};

export const CaregiverIntroVideo: React.FC = () => {
  const { currentUser, addToast } = useCareConnex();
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) return;
      const p = await dbService.getUser(currentUser.uid);
      if (active && p) {
        setProfile(p as any);
        setPreview((p as any).introVideoUrl || null);
      }
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

  const handleFile = async (file: File | undefined) => {
    if (!file || !currentUser?.uid) return;
    if (file.size > 100 * 1024 * 1024) {
      addToast('Video must be under 100 MB.', 'error');
      return;
    }
    setUploading(true);
    try {
      const result = await uploadMedia({
        file,
        appointmentId: `intro-${currentUser.uid}`,
        clientId: currentUser.uid,
        caregiverId: currentUser.uid,
      });
      await dbService.updateUser('caregivers', currentUser.uid, { introVideoUrl: result.url } as any);
      setPreview(result.url);
      addToast('Intro video uploaded!', 'success');
    } catch (e) {
      console.error(e);
      addToast((e as Error).message || 'Upload failed. Please try again.', 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Say "hello" in a 30-second video</h1>
        <p className="text-sm text-slate-500 mb-6">Make a short video so families can get to know you.</p>

        <div className="grid md:grid-cols-[1fr_280px] gap-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
            <div className="space-y-3 text-sm text-slate-700">
              <div>
                <p className="font-semibold text-slate-900">1) Practice what to say</p>
                <ul className="list-disc pl-5 text-slate-600">
                  <li>30 seconds = about 6 sentences about you</li>
                  <li>Do NOT say your last name or contact info</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-slate-900">2) Record your video</p>
                <ul className="list-disc pl-5 text-slate-600">
                  <li>Your phone is usually the easiest camera</li>
                  <li>Use good lighting — face a window when possible</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-slate-900">3) Upload</p>
                <ul className="list-disc pl-5 text-slate-600">
                  <li>2 minutes max length, almost any format works</li>
                  <li>All videos are reviewed before posting</li>
                </ul>
              </div>
            </div>

            {preview && (
              <div className="rounded-xl overflow-hidden bg-slate-900">
                <video src={preview} controls className="w-full max-h-80" />
              </div>
            )}

            <div>
              <input
                ref={fileRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={e => handleFile(e.target.files?.[0])}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="w-full inline-flex items-center justify-center gap-2 bg-primary-500 hover:bg-primary-600 disabled:bg-primary-300 text-white rounded-full py-3 px-6 font-semibold"
              >
                {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                {preview ? 'Replace Video' : 'Select and Upload Video'}
              </button>
              {profile?.introVideoUrl && (
                <p className="mt-2 text-xs text-primary-600 flex items-center gap-1 justify-center">
                  <CheckCircle className="w-3.5 h-3.5" /> Intro video saved
                </p>
              )}
            </div>
          </div>

          <aside className="space-y-4">
            <p className="font-semibold text-slate-900">Sample videos from great caregivers</p>
            <p className="text-xs text-slate-500">Caregivers with videos get more than twice as many jobs as those without.</p>
            {SAMPLE_VIDEOS.map((sample) => (
              <SampleVideoCard key={sample.id} sample={sample} />
            ))}
          </aside>
        </div>
      </div>
    </div>
  );
};
