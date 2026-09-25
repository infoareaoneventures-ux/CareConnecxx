import React, { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { functions } from '../../lib/firebase';

// Evia's tokened upload page. Two kinds (2026-09-25, matching the caregiver
// wizard): /upload/photo (the profile photo) and /upload/transport (the three
// transportation documents — driver's license, vehicle insurance, vehicle
// registration). Both write the same record the site's own pages write
// (caregivers/{uid}.photo / documents.{type}) through v1-uploadOnboardingFile.
// The old certification upload (/upload/document) is gone — the site never had it.

const LINQ_PHONE = import.meta.env.VITE_LINQ_PHONE_NUMBER || '';
const MAX_BYTES  = 6 * 1024 * 1024; // must match uploadOnboardingFile server cap

type TransportType = 'driversLicense' | 'insurance' | 'registration';
const TRANSPORT_DOCS: { type: TransportType; label: string; desc: string }[] = [
  { type: 'driversLicense', label: "Driver's License", desc: "Front of your valid driver's license" },
  { type: 'insurance',      label: 'Vehicle Insurance',    desc: 'Current auto insurance showing active coverage' },
  { type: 'registration',   label: 'Vehicle Registration', desc: 'Current vehicle registration document' },
];

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

async function uploadFile(file: File, isPhoto: boolean, documentType?: TransportType): Promise<void> {
  if (!functions) throw Object.assign(new Error('not connected'), { code: 'unavailable' });
  const token = new URLSearchParams(window.location.search).get('t') ?? '';
  if (!token) throw Object.assign(new Error('no token'), { code: 'unauthenticated' });
  if (file.size > MAX_BYTES * 2) {
    throw Object.assign(new Error('That file is too large — 6MB max. A photo straight from your camera works great.'), { code: 'invalid-argument' });
  }
  let payload = file.type.startsWith('image/') ? await compressImage(file) : null;
  if (!payload) {
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
  await upload({ token, dataBase64: payload.base64, contentType: payload.contentType, fileName: file.name, ...(documentType ? { documentType } : {}) });
}

function errorCode(err: unknown): string {
  const e = err as { code?: string };
  // Compat SDK surfaces HttpsError codes without the "functions/" prefix,
  // modular with it — accept both.
  return (e?.code ?? '').replace(/^functions\//, '');
}

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center px-6 py-10 gap-8">{children}</div>
);

const ExpiredScreen: React.FC = () => (
  <Shell>
    <div className="w-16 h-16 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
      <span className="text-3xl">⏳</span>
    </div>
    <div className="text-center">
      <p className="text-white text-xl font-semibold">This link has expired</p>
      <p className="text-white/50 text-sm mt-1">
        For your security these links expire after a couple of hours. Text Evia and I'll send you a fresh one.
      </p>
    </div>
    <a href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'} className="w-full max-w-xs py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl text-base text-center transition-all active:scale-95">
      Text Evia for a new link
    </a>
  </Shell>
);

const DoneScreen: React.FC<{ title: string }> = ({ title }) => (
  <Shell>
    <div className="w-16 h-16 rounded-full bg-green-500/20 border border-green-500/30 flex items-center justify-center">
      <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </div>
    <div className="text-center">
      <p className="text-white text-xl font-semibold">{title}</p>
      <p className="text-white/50 text-sm mt-1">Returning to your conversation...</p>
    </div>
    <a href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'} className="text-blue-400 text-sm underline underline-offset-2">
      Tap here to return to Evia
    </a>
  </Shell>
);

const Spinner: React.FC<{ label?: string }> = ({ label = 'Uploading...' }) => (
  <div className="flex items-center gap-3 text-white/60">
    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
    <span>{label}</span>
  </div>
);

// ── Profile photo ─────────────────────────────────────────────────────────────
function PhotoUpload() {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error' | 'expired'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setStatus('uploading');
    setErrorMsg(null);
    try {
      await uploadFile(file, true);
      setStatus('done');
      setTimeout(() => { if (LINQ_PHONE) window.location.href = `sms:${LINQ_PHONE}`; }, 1500);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'unauthenticated') { setStatus('expired'); return; }
      console.error('uploadOnboardingFile failed:', err);
      if (code === 'invalid-argument' && (err as Error)?.message) setErrorMsg((err as Error).message);
      setStatus('error');
    }
  };

  if (status === 'expired') return <ExpiredScreen />;
  if (status === 'done') return <DoneScreen title="Photo uploaded!" />;

  return (
    <Shell>
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto">
          <span className="text-2xl">📷</span>
        </div>
        <h1 className="text-white text-xl font-semibold">Upload your profile photo</h1>
        <p className="text-white/50 text-sm">Families want to see who they're trusting. A clear headshot works great.</p>
      </div>

      {preview && (
        <div className="w-32 h-32 rounded-2xl overflow-hidden border border-white/10">
          <img src={preview} alt="Preview" className="w-full h-full object-cover" />
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="user"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPreview(URL.createObjectURL(f)); handleFile(f); } }}
        className="hidden"
      />

      {status === 'uploading' ? <Spinner /> : (
        <button onClick={() => fileRef.current?.click()} className="w-full max-w-xs py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-2xl text-base transition-all active:scale-95">
          📷 Choose Photo
        </button>
      )}

      {status === 'error' && <p className="text-red-400 text-sm">{errorMsg ?? 'Upload failed. Please try again.'}</p>}

      <a href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'} className="text-white/30 text-xs underline underline-offset-2">
        Cancel — return to conversation
      </a>
    </Shell>
  );
}

// ── Transportation documents (three slots on one page) ───────────────────────
function TransportUpload() {
  const [status, setStatus] = useState<Record<TransportType, 'idle' | 'uploading' | 'done' | 'error'>>({
    driversLicense: 'idle', insurance: 'idle', registration: 'idle',
  });
  const [expired, setExpired] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const refs: Record<TransportType, React.RefObject<HTMLInputElement>> = {
    driversLicense: useRef<HTMLInputElement>(null),
    insurance: useRef<HTMLInputElement>(null),
    registration: useRef<HTMLInputElement>(null),
  };

  const handleFile = async (type: TransportType, file: File) => {
    setStatus((s) => ({ ...s, [type]: 'uploading' }));
    setErrorMsg(null);
    try {
      await uploadFile(file, false, type);
      setStatus((s) => ({ ...s, [type]: 'done' }));
    } catch (err) {
      const code = errorCode(err);
      if (code === 'unauthenticated') { setExpired(true); return; }
      console.error('uploadOnboardingFile failed:', err);
      if (code === 'invalid-argument' && (err as Error)?.message) setErrorMsg((err as Error).message);
      setStatus((s) => ({ ...s, [type]: 'error' }));
    }
  };

  const allDone = TRANSPORT_DOCS.every(({ type }) => status[type] === 'done');
  if (expired) return <ExpiredScreen />;
  if (allDone) return <DoneScreen title="All three documents uploaded!" />;

  return (
    <Shell>
      <div className="text-center space-y-2">
        <div className="w-12 h-12 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto">
          <span className="text-2xl">🚗</span>
        </div>
        <h1 className="text-white text-xl font-semibold">Your transportation documents</h1>
        <p className="text-white/50 text-sm">
          All three are required to offer transportation. Our team reviews them after your background and driving-record checks.
        </p>
      </div>

      <div className="w-full max-w-sm space-y-3">
        {TRANSPORT_DOCS.map(({ type, label, desc }) => (
          <div key={type} className={`border rounded-2xl p-4 flex items-center gap-3 ${status[type] === 'done' ? 'border-green-500/40 bg-green-500/10' : 'border-white/10 bg-white/5'}`}>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-semibold">{label}</p>
              <p className="text-white/40 text-xs">{desc}</p>
            </div>
            {status[type] === 'done' ? (
              <span className="text-green-400 text-xs font-medium shrink-0">✓ Uploaded</span>
            ) : status[type] === 'uploading' ? (
              <Spinner label="" />
            ) : (
              <button onClick={() => refs[type].current?.click()} className={`shrink-0 text-xs font-semibold px-3 py-2 rounded-xl transition-all active:scale-95 ${status[type] === 'error' ? 'bg-red-500/20 text-red-300' : 'bg-blue-600 text-white hover:bg-blue-500'}`}>
                {status[type] === 'error' ? 'Retry' : 'Upload'}
              </button>
            )}
            <input
              ref={refs[type]}
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(type, f); }}
            />
          </div>
        ))}
      </div>

      {errorMsg && <p className="text-red-400 text-sm">{errorMsg}</p>}

      <a href={LINQ_PHONE ? `sms:${LINQ_PHONE}` : '/'} className="text-white/30 text-xs underline underline-offset-2">
        Return to conversation
      </a>
    </Shell>
  );
}

export default function UploadPage() {
  const { type } = useParams<{ type: string }>();
  if (type === 'transport') return <TransportUpload />;
  return <PhotoUpload />;
}
