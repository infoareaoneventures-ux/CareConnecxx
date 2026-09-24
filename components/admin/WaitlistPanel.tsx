import React, { useEffect, useState } from 'react';
import { MapPin, Phone, MessageSquare, Globe } from 'lucide-react';
import { dbService } from '../../services/api';

// Out-of-area leads. Both doors write here: Evia's onboarding gate
// (functions/src/agents/serviceAreaGate.ts, source "text") and the site
// wizard's "Notify me when you reach my area" (source "site").
interface WaitlistLead {
  id: string;
  phone?: string;
  name?: string | null;
  role?: 'client' | 'caregiver';
  attemptedCity?: string | null;
  attemptedZip?: string | null;
  source?: 'site' | 'text';
  reason?: string;
  createdAt?: string;
}

export const WaitlistPanel: React.FC = () => {
  const [leads, setLeads] = useState<WaitlistLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'client' | 'caregiver'>('all');

  useEffect(() => {
    const unsub = dbService.subscribeWaitlist((rows) => { setLeads(rows as WaitlistLead[]); setLoading(false); }, () => setLoading(false));
    return () => unsub();
  }, []);

  const shown = leads.filter((l) => filter === 'all' || (l.role ?? 'client') === filter);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-slate-500">
          People outside Santa Clara County who asked to be told when we reach their area.
        </p>
        <div className="flex space-x-2 border-b border-slate-200">
          {(['all', 'client', 'caregiver'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 font-medium text-sm capitalize transition-colors ${filter === f
                ? 'text-primary-600 border-b-2 border-primary-600'
                : 'text-slate-500 hover:text-slate-700'}`}
            >
              {f === 'all' ? 'All' : f === 'client' ? 'Families' : 'Caregivers'}
              <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-slate-100">
                {leads.filter((l) => f === 'all' || (l.role ?? 'client') === f).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <MapPin className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-lg">No waitlist leads</p>
          <p className="text-sm mt-2">Out-of-area signups from the site and from Evia over text appear here</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Where</th>
                <th className="px-4 py-3">Came in via</th>
                <th className="px-4 py-3">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{l.name || <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-3 text-slate-700 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><Phone className="w-3.5 h-3.5 text-slate-400" />{l.phone || l.id}</span></td>
                  <td className="px-4 py-3 capitalize text-slate-700">{(l.role ?? 'client') === 'client' ? 'Family' : 'Caregiver'}</td>
                  <td className="px-4 py-3 text-slate-700">{[l.attemptedCity, l.attemptedZip].filter(Boolean).join(' · ') || <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-3 text-slate-700">
                    <span className="inline-flex items-center gap-1.5">
                      {l.source === 'site' ? <Globe className="w-3.5 h-3.5 text-slate-400" /> : <MessageSquare className="w-3.5 h-3.5 text-slate-400" />}
                      {l.source === 'site' ? 'Website' : 'Text (Evia)'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{l.createdAt ? new Date(l.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
