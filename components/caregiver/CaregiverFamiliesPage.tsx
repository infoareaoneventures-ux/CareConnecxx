import React, { useEffect, useMemo, useState } from 'react';
import { Heart, Search as SearchIcon } from 'lucide-react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { db } from '../../lib/firebase';

type FamilyFilter = 'favorites' | 'worked-with' | 'contacted' | 'all';

interface FamilyEntry {
  clientId: string;
  name: string;
  photoURL?: string;
  source: 'favorite' | 'worked-with' | 'contacted';
}

export const CaregiverFamiliesPage: React.FC = () => {
  const { currentUser, appointments } = useCareConnex();
  const [filter, setFilter] = useState<FamilyFilter>('favorites');
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<FamilyEntry[]>([]);
  const [contacted, setContacted] = useState<FamilyEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) { setLoading(false); return; }
      try {
        const [favSnap, reqSnap] = await Promise.all([
          (db as any)
            .collection('users')
            .where('savedCaregivers', 'array-contains', currentUser.uid)
            .get(),
          (db as any)
            .collection('interview_requests')
            .where('caregiverId', '==', currentUser.uid)
            .get(),
        ]);

        const favEntries: FamilyEntry[] = [];
        favSnap.forEach((doc: any) => {
          const d = doc.data();
          favEntries.push({
            clientId: doc.id,
            name: d.displayName || d.name || 'Family',
            photoURL: d.photoURL,
            source: 'favorite',
          });
        });
        if (active) setFavorites(favEntries);

        const contactedMap = new Map<string, FamilyEntry>();
        reqSnap.forEach((doc: any) => {
          const d = doc.data();
          const clientId = d.clientId || d.clientPhone || doc.id;
          if (!contactedMap.has(clientId)) {
            contactedMap.set(clientId, {
              clientId,
              name: d.clientName || d.clientDisplayName || 'Family',
              photoURL: d.clientPhotoURL,
              source: 'contacted',
            });
          }
        });
        if (active) setContacted(Array.from(contactedMap.values()));
      } catch (e) {
        console.warn('Families query failed', e);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

  const workedWith: FamilyEntry[] = useMemo(() => {
    const map = new Map<string, FamilyEntry>();
    appointments
      .filter(a => currentUser && a.caregiverId?.toString() === currentUser.uid)
      .forEach(a => {
        if (!a.clientId) return;
        if (!map.has(a.clientId)) {
          map.set(a.clientId, {
            clientId: a.clientId,
            name: a.clientName || 'Family',
            source: 'worked-with',
          });
        }
      });
    return Array.from(map.values());
  }, [appointments, currentUser]);

  const all: FamilyEntry[] = useMemo(() => {
    const seen = new Set<string>();
    const out: FamilyEntry[] = [];
    [...favorites, ...workedWith, ...contacted].forEach(e => {
      if (!seen.has(e.clientId)) { seen.add(e.clientId); out.push(e); }
    });
    return out;
  }, [favorites, workedWith, contacted]);

  const filtered = useMemo(() => {
    let list: FamilyEntry[];
    switch (filter) {
      case 'favorites':   list = favorites; break;
      case 'worked-with': list = workedWith; break;
      case 'contacted':   list = contacted; break;
      case 'all':         list = all; break;
    }
    const q = query.trim().toLowerCase();
    return q ? list.filter(f => f.name.toLowerCase().includes(q)) : list;
  }, [filter, favorites, workedWith, contacted, all, query]);

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Your Families</h1>
        <p className="text-sm text-slate-500 mb-6">Families that you've worked for, been in contact with, or favorited.</p>

        <div className="flex flex-wrap gap-4 mb-6">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Type</label>
            <select
              value={filter}
              onChange={e => setFilter(e.target.value as FamilyFilter)}
              className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm"
            >
              <option value="favorites">Favorites</option>
              <option value="worked-with">Worked with</option>
              <option value="contacted">Contacted</option>
              <option value="all">All</option>
            </select>
          </div>
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs font-semibold text-slate-600 mb-1">Name</label>
            <div className="relative">
              <SearchIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name..."
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 bg-white text-sm"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
            <Heart className="w-8 h-8 text-primary-300 mx-auto mb-3" />
            <p className="font-semibold text-slate-900 mb-1">You haven't selected any favorites.</p>
            <p className="text-sm text-slate-500">
              Find your favorite families easily by clicking the heart over their photo. You can select favorites from families that have booked or contacted you.
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {filtered.map(f => (
              <div key={f.clientId} className="bg-white border border-slate-200 rounded-2xl p-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-semibold">
                  {f.photoURL ? <img src={f.photoURL} alt={f.name} className="w-full h-full rounded-full object-cover" /> : f.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-900 truncate">{f.name}</p>
                  <p className="text-xs text-slate-500 capitalize">{f.source.replace('-', ' ')}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
