import React, { useState } from 'react';

const STORAGE_KEY = 'evia_beta_access';
const PASSWORD = import.meta.env.VITE_SITE_PASSWORD as string | undefined;

export const PasswordGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [unlocked, setUnlocked] = useState(() => {
    if (!PASSWORD) return true;
    return localStorage.getItem(STORAGE_KEY) === PASSWORD;
  });
  const [input, setInput] = useState('');
  const [error, setError] = useState(false);

  if (unlocked) return <>{children}</>;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input === PASSWORD) {
      localStorage.setItem(STORAGE_KEY, PASSWORD!);
      setUnlocked(true);
    } else {
      setError(true);
      setInput('');
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
            disabled={!input}
            className="w-full py-3.5 btn-depth-primary rounded-full disabled:opacity-30 disabled:cursor-not-allowed font-semibold text-[15px]"
          >
            Continue →
          </button>
        </form>

      </div>
    </div>
  );
};
