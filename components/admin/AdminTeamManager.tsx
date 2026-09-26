import React, { useState, useEffect } from 'react';
import { Search, Shield, Mail, Phone, Calendar, RefreshCw, X, KeyRound } from 'lucide-react';
import { dbService } from '../../services/api';
import { AdminUser } from '../../types';

// People → Team (2026-09-26): the one place admin and coordinator accounts
// show up in the panel. Clients lists userType 'client' and Caregivers reads
// the caregivers collection, so an account flipped to admin used to vanish
// from People entirely. Read-only: roles are still granted by hand on the
// users record (userType 'admin' / isAdmin true — the same two markers the
// Firestore rules and the site's admin gate check; userType 'coordinator'
// for the coordinator role that will manage accounts later).

type TeamRole = 'admin' | 'coordinator';

interface TeamRow extends Omit<AdminUser, 'userType'> {
  userType?: string;
  isAdmin?: boolean;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  role: TeamRole;
}

export function teamRoleOf(u: { userType?: string; isAdmin?: boolean }): TeamRole | null {
  if (u.userType === 'admin' || u.isAdmin === true) return 'admin';
  if (u.userType === 'coordinator') return 'coordinator';
  return null;
}

const ROLE_LABEL: Record<TeamRole, string> = { admin: 'Admin', coordinator: 'Coordinator' };
const ROLE_COLOR: Record<TeamRole, string> = {
  admin: 'bg-primary-100 text-primary-700',
  coordinator: 'bg-accent-50 text-accent-700',
};

const nameOf = (u: TeamRow): string =>
  u.name || u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Unnamed';

const sinceOf = (iso?: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const AdminTeamManager: React.FC = () => {
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | TeamRole>('all');
  const [selected, setSelected] = useState<TeamRow | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const all = await dbService.getAllUsers();
      const team: TeamRow[] = [];
      for (const u of all as Array<AdminUser & { isAdmin?: boolean }>) {
        const role = teamRoleOf(u);
        if (role) team.push({ ...u, role });
      }
      team.sort((a, b) => (a.role === b.role ? nameOf(a).localeCompare(nameOf(b)) : a.role === 'admin' ? -1 : 1));
      setRows(team);
    } finally {
      setLoading(false);
    }
  };

  const filtered = rows.filter(r => {
    if (roleFilter !== 'all' && r.role !== roleFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return nameOf(r).toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q) || (r.phone || '').includes(search);
  });

  const adminCount = rows.filter(r => r.role === 'admin').length;
  const coordinatorCount = rows.length - adminCount;

  return (
    <div className="flex h-full">
      {/* ── List pane ── */}
      <div className={`${selected ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-80 border-r border-slate-200 bg-white shrink-0`}>
        <div className="p-3 border-b border-slate-100 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search team…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="flex gap-1">
            {([['all', 'All'], ['admin', 'Admins'], ['coordinator', 'Coordinators']] as const).map(([f, label]) => (
              <button key={f} onClick={() => setRoleFilter(f)}
                className={`flex-1 py-1 text-xs rounded-full font-medium transition-colors ${roleFilter === f ? 'bg-primary-100 text-primary-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-slate-300">
              <Shield className="w-10 h-10 mb-2" />
              <p className="text-sm text-slate-400">
                {roleFilter === 'coordinator' ? 'No coordinators yet' : roleFilter === 'admin' ? 'No admins found' : 'No team accounts found'}
              </p>
            </div>
          ) : filtered.map(r => (
            <button key={r.uid} onClick={() => setSelected(r)}
              className={`w-full text-left flex items-center gap-3 px-4 py-3 border-b border-slate-50 hover:bg-slate-50 transition-colors ${selected?.uid === r.uid ? 'bg-primary-50 border-l-2 border-l-primary-500' : ''}`}>
              <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
                <span className="text-primary-700 font-bold text-sm">{nameOf(r).charAt(0).toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-slate-900 text-sm truncate">{nameOf(r)}</p>
                <p className="text-xs text-slate-400 truncate">{r.email}</p>
              </div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${ROLE_COLOR[r.role]}`}>{ROLE_LABEL[r.role]}</span>
            </button>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400">{adminCount} admin{adminCount === 1 ? '' : 's'} · {coordinatorCount} coordinator{coordinatorCount === 1 ? '' : 's'}</span>
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* ── Detail pane ── */}
      {selected ? (
        <div className="flex-1 flex flex-col min-w-0 bg-slate-50">
          <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-4">
            <button onClick={() => setSelected(null)} className="lg:hidden p-1.5 rounded-lg hover:bg-slate-100"><X className="w-4 h-4" /></button>
            <div className="w-11 h-11 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-lg shrink-0">
              {nameOf(selected).charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-slate-900 truncate">{nameOf(selected)}</h3>
              <p className="text-sm text-slate-500 truncate">{selected.email}</p>
            </div>
            <span className={`text-sm font-medium px-3 py-1 rounded-full shrink-0 ${ROLE_COLOR[selected.role]}`}>{ROLE_LABEL[selected.role]}</span>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-2xl space-y-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Account</h4>
                <div className="flex items-center gap-3 text-sm text-slate-700"><Mail className="w-4 h-4 text-slate-400" /><span>{selected.email || '—'}</span></div>
                <div className="flex items-center gap-3 text-sm text-slate-700"><Phone className="w-4 h-4 text-slate-400" /><span>{selected.phone || '—'}</span></div>
                <div className="flex items-center gap-3 text-sm text-slate-700"><Calendar className="w-4 h-4 text-slate-400" /><span>Since {sinceOf(selected.createdAt)}</span></div>
                <div className="flex items-center gap-3 text-sm text-slate-700"><KeyRound className="w-4 h-4 text-slate-400" /><span className="font-mono text-xs text-slate-500 break-all">{selected.uid}</span></div>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-2">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Role</h4>
                <p className="text-sm text-slate-700">
                  {selected.role === 'admin'
                    ? 'Full access to this admin panel. Granted on the user record (user type "admin" or the isAdmin flag).'
                    : 'Coordinator — will manage client and caregiver accounts. Granted on the user record (user type "coordinator").'}
                </p>
                <p className="text-xs text-slate-400">Roles are changed on the user record; there is no grant or revoke button here yet.</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="hidden lg:flex flex-1 items-center justify-center text-slate-300">
          <div className="text-center">
            <Shield className="w-12 h-12 mx-auto mb-3" />
            <p className="text-sm text-slate-400">Select a team member to view details</p>
          </div>
        </div>
      )}
    </div>
  );
};
