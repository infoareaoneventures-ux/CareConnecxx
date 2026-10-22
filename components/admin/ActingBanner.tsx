import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Square, ArrowLeft } from 'lucide-react';
import { useCareConnex } from '../../context/CareConnexContext';
import { adminService } from '../../services/api';

// Acting-for banner (2026-10-22): pinned above every page while an admin is
// using a person's own pages for them. Shows who, until when, and two ways out:
// Back to admin keeps the window open (the strip on the admin page can reopen
// the pages); Stop ends the window and tells the person.

export const ActingBanner: React.FC = () => {
  const { actingFor, adminUser, stopActing, addToast } = useCareConnex();
  const navigate = useNavigate();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // View mode (2026-10-22, founder: "I shouldn't be able to click actions, more like tabs"): action
  // buttons are blocked before they open anything — Apply, Save, Send, Accept, Start, Pay… — and
  // every form submit. Navigation stays: the top menu, links, page tabs, filters, the banner.
  const viewing = actingFor?.mode === 'view';
  useEffect(() => {
    if (!viewing) return;
    let lastToast = 0;
    const warn = () => {
      const now = Date.now();
      if (now - lastToast < 2000) return;
      lastToast = now;
      addToast("Viewing only — nothing can be changed. Ask them for a YES from their admin page to make changes.", 'info');
    };
    const ACTION = /^(apply|submit|save|send|accept|decline|start|end|finish|done|undo|log|request|book|hire|post|publish|update|delete|remove|upload|pay|set up|setup|confirm|reschedule|propose|withdraw|leave|edit|message|schedule|block|report|mark|cancel (visit|shift|booking|interview|request|membership)|approve|retry|resend|change|add|create|invite|connect|verify|sign|complete|continue|next|get started|yes,)/i;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const el = target.closest('button, [type="submit"], [role="button"]') as HTMLElement | null;
      if (!el) return;
      if (el.closest('[data-acting-banner], nav, header, [role="tablist"], [role="tab"], [role="alert"], a[href]')) return;
      const text = (el.getAttribute('aria-label') || el.textContent || '').trim();
      // Closing / dismissing is never an action (the toast's own X, modal close buttons).
      if (/^(dismiss|close)\b/i.test(text)) return;
      // A <button> with no type attribute reports itself as "submit" — only an explicit submit, or
      // an untyped button inside a form, counts (the first version blocked the toast's X this way).
      const isSubmit = el.getAttribute('type') === 'submit' || (!el.getAttribute('type') && !!el.closest('form'));
      if (!isSubmit && !ACTION.test(text)) return;
      e.preventDefault(); e.stopPropagation(); warn();
    };
    const onSubmit = (e: Event) => { e.preventDefault(); e.stopPropagation(); warn(); };
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    return () => { document.removeEventListener('click', onClick, true); document.removeEventListener('submit', onSubmit, true); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing]);

  if (!actingFor || !adminUser) return null;

  if (actingFor.mode === 'view') {
    return (
      <div data-acting-banner className="sticky top-0 z-[60] bg-slate-700 text-white text-sm px-4 py-2 flex items-center gap-3 flex-wrap shadow">
        <Shield className="w-4 h-4 shrink-0" />
        <span>Viewing <strong>{actingFor.name}</strong>'s pages as the Evia team — <strong>nothing is saved or texted</strong>. To make a change, ask them for a YES from their admin page.</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { stopActing(); navigate('/admin'); }} className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-900">
            <ArrowLeft className="w-3 h-3" /> Back to admin
          </button>
        </div>
      </div>
    );
  }

  const remaining = Math.max(0, Date.parse(actingFor.until) - now);
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
  const untilLabel = new Date(actingFor.until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const stop = async () => {
    try {
      await adminService.queueAdminAssist({ type: 'end_consent', uid: actingFor.uid, role: actingFor.role, adminUid: actingFor.adminUid, adminName: actingFor.adminName });
    } catch { addToast('Could not tell the server to stop — the window ends on its own', 'error'); }
    stopActing();
    navigate('/admin');
  };

  return (
    <div data-acting-banner className="sticky top-0 z-[60] bg-emerald-700 text-white text-sm px-4 py-2 flex items-center gap-3 flex-wrap shadow">
      <Shield className="w-4 h-4 shrink-0" />
      <span>
        Acting for <strong>{actingFor.name}</strong> as the Evia team, allowed by their YES until {untilLabel}
        <span className="ml-2 font-mono text-xs opacity-90">{mm}:{ss}</span>
      </span>
      <span className="text-xs opacity-80 hidden md:inline">Everything you do here is recorded under your name and texted to them. Payment, identity and background-check steps stay with them: send the link from their admin page.</span>
      <div className="ml-auto flex items-center gap-2">
        <button onClick={() => { stopActing(); navigate('/admin'); }} className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg bg-emerald-800 hover:bg-emerald-900">
          <ArrowLeft className="w-3 h-3" /> Back to admin
        </button>
        <button onClick={stop} className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg bg-white text-emerald-800 hover:bg-emerald-50">
          <Square className="w-3 h-3" /> Stop acting
        </button>
      </div>
    </div>
  );
};

export default ActingBanner;
