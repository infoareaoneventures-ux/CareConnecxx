import React, { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { functions } from '../../lib/firebase';

const LINQ_PHONE = import.meta.env.VITE_LINQ_PHONE_NUMBER || '';

export default function UploadPage() {
  const { type } = useParams<{ type: 'photo' | 'document' }>();
  const isPhoto   = type === 'photo';

  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setStatus('uploading');
    try {
      const storage   = getStorage();
      const token     = new URLSearchParams(window.location.search).get('t') ?? 'unknown';
      const ext       = file.name.split('.').pop() ?? (isPhoto ? 'jpg' : 'pdf');
      const path      = `${isPhoto ? 'profile_photos' : 'caregiver_docs'}/${token}_${Date.now()}.${ext}`;
      const sRef      = storageRef(storage, path);

      await uploadBytes(sRef, file);
      const url = await getDownloadURL(sRef);

      if (functions) {
        const markDone = functions.httpsCallable('markTaskComplete');
        await markDone({ token, taskId: url }).catch(() => {/* non-critical */});
      }

      setStatus('done');
      setTimeout(() => {
        if (LINQ_PHONE) {
          window.location.href = `sms:${LINQ_PHONE}`;
        }
      }, 2000);
    } catch {
      setStatus('error');
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isPhoto) setPreview(URL.createObjectURL(file));
    handleFile(file);
  };

  if (status === 'done') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center gap-6">
        <div className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center">
          <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <p className="text-white text-xl font-semibold">{isPhoto ? 'Photo uploaded!' : 'Document uploaded!'}</p>
          <p className="text-white/50 text-sm mt-1">Returning to your conversation...</p>
        </div>
        <a
          href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
          className="text-blue-400 text-sm underline underline-offset-2"
        >
          Tap here to return to Cara
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 gap-8">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto">
          <span className="text-2xl">{isPhoto ? '📷' : '📄'}</span>
        </div>
        <h1 className="text-white text-xl font-semibold">
          {isPhoto ? 'Upload your profile photo' : 'Upload your certification'}
        </h1>
        <p className="text-white/50 text-sm">
          {isPhoto
            ? "Families want to see who they're trusting. A clear headshot works great."
            : 'CNA license, CPR card, or any relevant certification.'}
        </p>
      </div>

      {preview && (
        <div className="w-32 h-32 rounded-2xl overflow-hidden border border-white/10">
          <img src={preview} alt="Preview" className="w-full h-full object-cover" />
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={isPhoto ? 'image/*' : 'image/*,.pdf'}
        capture={isPhoto ? 'user' : undefined}
        onChange={onFileChange}
        className="hidden"
      />

      {status === 'uploading' ? (
        <div className="flex items-center gap-3 text-white/60">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Uploading...</span>
        </div>
      ) : (
        <button
          onClick={() => fileRef.current?.click()}
          className="w-full max-w-xs py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl text-base transition-all active:scale-95"
        >
          {isPhoto ? '📷 Choose Photo' : '📄 Choose File'}
        </button>
      )}

      {status === 'error' && (
        <p className="text-red-400 text-sm">Upload failed. Please try again.</p>
      )}

      <a
        href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
        className="text-white/30 text-xs underline underline-offset-2"
      >
        Cancel — return to conversation
      </a>
    </div>
  );
}
