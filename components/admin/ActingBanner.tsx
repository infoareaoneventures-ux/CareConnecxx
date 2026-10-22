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
  if (!actingFor || !adminUser) return null;

  if (actingFor.mode === 'view') {
    return (
      <div className="sticky top-0 z-[60] bg-slate-700 text-white text-sm px-4 py-2 flex items-center gap-3 flex-wrap shadow">
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
    <div className="sticky top-0 z-[60] bg-emerald-700 text-white text-sm px-4 py-2 flex items-center gap-3 flex-wrap shadow">
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
