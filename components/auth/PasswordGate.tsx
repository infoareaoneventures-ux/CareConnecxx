import React, { useState } from 'react';
import { dbService } from '../../services/api';

// The access code's hash lives in Firestore (config/sitePassword — hash+salt
// only, never the plaintext) instead of being compiled into the JS bundle.
// VITE_-prefixed vars are baked into the client bundle in plain text, which is
// how the previous client-side comparison leaked the password to anyone
// opening devtools. This flag is just a public on/off switch; it carries no
// secret. Verification happens entirely client-side against the public hash —
// this is a soft beta wall, not a security boundary, so a determined visitor
// could still brute-force the hash offline; it just isn't handed to them for free.
const STORAGE_KEY = 'evia_beta_access';
const UNLOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const GATE_ENABLED = import.meta.env.VITE_SITE_PASSWORD_GATE_ENABLED === 'true';

function hasValidStoredUnlock(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  const unlockedAt = Number(raw);
  return Number.isFinite(unlockedAt) && Date.now() - unlockedAt < UNLOCK_TTL_MS;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

let cachedSaltHash: { salt: string; hash: string } | null = null;
async function fetchSaltHash(): Promise<{ salt: string; hash: string } | null> {
  if (cachedSaltHash) return cachedSaltHash;
  const saltHash = await dbService.getSitePasswordHash();
  if (!saltHash) return null;
  cachedSaltHash = saltHash;
  return cachedSaltHash;
}

export const PasswordGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [unlocked, setUnlocked] = useState(() => !GATE_ENABLED || hasValidStoredUnlock());
  const [input, setInput] = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (unlocked) return <>{children}</>;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || submitting) return;
    setSubmitting(true);
    setError(false);
    try {
      const saltHash = await fetchSaltHash();
      if (!saltHash) throw new Error('access code unavailable');
      const attemptHash = await sha256Hex(saltHash.salt + input);
      if (attemptHash !== saltHash.hash) throw new Error('incorrect code');
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
      setUnlocked(true);
    } catch {
      setError(true);
      setInput('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper-50 flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-8">

        <div className="text-center space-y-2">
          <div className="text-2xl font-display font-semibold text-ink-900 tracking-[-0.02em]">Evia</div>
          <p className="text-ink-500 text-sm">Enter access code to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            autoFocus
            placeholder="Access code"
            value={input}
            onChange={e => { setInput(e.target.value); setError(false); }}
            className={`w-full bg-white border rounded-xl px-4 py-3.5 text-ink-900 placeholder-ink-400 focus:outline-none text-base text-center tracking-widest ${error ? 'border-red-400 focus:border-red-400' : 'hairline focus:border-ink-400'}`}
          />
          {error && <p className="text-red-500 text-sm text-center">Incorrect code — try again</p>}
          <button
            type="submit"
            disabled={!input || submitting}
            className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
          >
            {submitting ? 'Checking…' : 'Continue →'}
          </button>
        </form>

      </div>
    </div>
  );
};
