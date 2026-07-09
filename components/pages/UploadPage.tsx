import React, { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { functions } from '../../lib/firebase';

const LINQ_PHONE = import.meta.env.VITE_LINQ_PHONE_NUMBER || '';
const MAX_BYTES  = 6 * 1024 * 1024; // must match uploadOnboardingFile server cap

const readAsDataURL = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

// Downscale + re-encode as JPEG. Keeps the callable payload small and
// normalizes iPhone HEIC (Safari decodes it into the canvas; the export is
// plain JPEG the rest of the platform can render). Returns null when the
// browser can't decode the file — caller falls back to the raw bytes.
async function compressImage(file: File): Promise<{ base64: string; contentType: string } | null> {
  try {
    const dataUrl = await readAsDataURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload  = () => resolve(i);
      i.onerror = () => reject(new Error('decode failed'));
      i.src = dataUrl;
    });
    const MAX_DIM = 1280;
    const scale  = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = out.split(',')[1];
    return base64 ? { base64, contentType: 'image/jpeg' } : null;
  } catch {
    return null;
  }
}

export default function UploadPage() {
  const { type } = useParams<{ type: 'photo' | 'document' }>();
  const isPhoto   = type === 'photo';

  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error' | 'expired'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setStatus('uploading');
    setErrorMsg(null);
    try {
      if (!functions) { setStatus('error'); return; }
      const token = new URLSearchParams(window.location.search).get('t') ?? '';
      if (!token) { setStatus('expired'); return; }

      let payload = file.type.startsWith('image/') ? await compressImage(file) : null;
      if (!payload) {
        if (file.size > MAX_BYTES) {
          setErrorMsg('That file is too large — 6MB max. A photo straight from your camera works great.');
          setStatus('error');
          return;
        }
        const dataUrl = await readAsDataURL(file);
        payload = {
          base64: dataUrl.split(',')[1] ?? '',
          contentType: file.type || (isPhoto ? 'image/jpeg' : 'application/pdf'),
        };
      }

      // Single token-authenticated call: the server (Admin SDK) stores the file
      // AND advances onboarding. The page has no Firebase Auth session, so a
      // direct Storage write would be rejected by storage.rules.
      const upload = functions.httpsCallable('v1-uploadOnboardingFile');
      await upload({ token, dataBase64: payload.base64, contentType: payload.contentType });

      setStatus('done');
      // Hand the caregiver straight back to their iMessage/SMS thread with Evia.
      setTimeout(() => {
        if (LINQ_PHONE) {
          window.location.href = `sms:${LINQ_PHONE}`;
        }
      }, 1500);
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      // Compat SDK surfaces HttpsError codes without the "functions/" prefix,
      // modular with it — accept both.
      const code = (e?.code ?? '').replace(/^functions\//, '');
      if (code === 'unauthenticated') {
        setStatus('expired');
        return;
      }
      console.error('uploadOnboardingFile failed:', err);
      if (code === 'invalid-argument' && e?.message) setErrorMsg(e.message);
      setStatus('error');
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isPhoto) setPreview(URL.createObjectURL(file));
    handleFile(file);
  };

  if (status === 'expired') {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 text-center gap-6">
        <div className="w-16 h-16 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
          <span className="text-3xl">⏳</span>
        </div>
        <div>
          <p className="text-white text-xl font-semibold">This link has expired</p>
          <p className="text-white/50 text-sm mt-1">
            For your security these links expire after a couple of hours. Text Evia and I'll send you a fresh one.
          </p>
        </div>
        <a
          href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'}
          className="w-full max-w-xs py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl text-base text-center transition-all active:scale-95"
        >
          Text Evia for a new link
        </a>
      </div>
    );
  }

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
          Tap here to return to Evia
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
        <p className="text-red-400 text-sm">{errorMsg ?? 'Upload failed. Please try again.'}</p>
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
