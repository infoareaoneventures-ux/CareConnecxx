import React, { useEffect, useRef, useState } from 'react';
import { registerConfirmHost, PendingConfirm } from '../../utils/confirmDialog';

/** Shows the confirmation asked for by askConfirm(). Mount once, near the root. */
export const ConfirmDialogHost: React.FC = () => {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerConfirmHost((p) => setPending((prev) => { prev?.resolve(false); return p; }));
    return () => registerConfirmHost(null);
  }, []);

  useEffect(() => { if (pending) confirmRef.current?.focus(); }, [pending]);

  if (!pending) return null;
  const close = (ok: boolean) => { pending.resolve(ok); setPending(null); };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 px-4"
      onClick={() => close(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') close(false); }}
      >
        <h2 id="confirm-title" className="text-lg font-semibold text-ink-900">{pending.title ?? 'Are you sure?'}</h2>
        <p id="confirm-message" className="mt-2 text-sm text-ink-600">{pending.message}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => close(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            {pending.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => close(true)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${pending.destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-ink-900 hover:bg-ink-600'}`}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
