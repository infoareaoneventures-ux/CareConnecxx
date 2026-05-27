import React, { useEffect, useMemo, useState } from 'react';
import { Heart, Search as SearchIcon, MessageSquare, Clock, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { db } from '../../lib/firebase';
import { chatService } from '../../services/chatService';
import { authService } from '../../services/api';

type FamilyFilter = 'active' | 'past';

interface FamilyEntry {
  clientId: string;
  bookingId?: string;
  name: string;
  photoURL?: string;
  source: 'active' | 'past';
  // booking details (active/past only)
  scheduleDays?: string[];
  rate?: number | null;
  nextShift?: string;
  bookingStatus?: string;
  careRecipients?: Array<{ firstName?: string; name?: string; [key: string]: any }>;
}

export const CaregiverFamiliesPage: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser } = useCareConnex();
  const uid = currentUser?.uid || authService.getCurrentUser()?.uid;

  const [filter, setFilter] = useState<FamilyFilter>('active');
  const [query, setQuery] = useState('');
  const [activeFamilies, setActiveFamilies] = useState<FamilyEntry[]>([]);
  const [pastFamilies, setPastFamilies] = useState<FamilyEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!uid) { setLoading(false); return; }

    (async () => {
      try {
        // Pull booking_requests + scheduled shifts in parallel
        const [bookingsSnap, scheduledShiftsSnap] = await Promise.all([
          (db as any).collection('booking_requests')
            .where('caregiverId', '==', uid)
            .limit(100)
            .get(),
          (db as any).collection('shifts')
            .where('caregiverId', '==', uid)
            .where('status', '==', 'scheduled')
            .get(),
        ]);

        // Build set of booking IDs that still have scheduled shifts
        const activeBookingIds = new Set<string>();
        scheduledShiftsSnap.docs.forEach((d: any) => {
          const bid = d.data().bookingRequestId;
          if (bid) activeBookingIds.add(bid);
        });

        const ALL_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const normDay = (d: string) =>
          d.trim().charAt(0).toUpperCase() + d.trim().slice(1, 3).toLowerCase();

        const computeNextShift = (bookingData: any): string | undefined => {
          const dst = bookingData.schedule?.dayShiftTimes;
          const scheduleDays: string[] = dst && typeof dst === 'object'
            ? Object.keys(dst)
            : (bookingData.schedule?.days || []);
          if (!scheduleDays.length) return undefined;

          const now = new Date();
          const todayNorm = ALL_DAYS[now.getDay()];
          const normalizedDays = scheduleDays.map(normDay);

          if (normalizedDays.includes(todayNorm)) {
            const todayBlocks: Array<{ start: string; end: string }> =
              dst?.[todayNorm] || [];
            const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            const inProgress = todayBlocks.some(b => b.start && b.end && hhmm >= b.start && hhmm <= b.end);
            return inProgress ? 'In progress' : 'Today';
          }

          let earliest: Date | null = null;
          scheduleDays.forEach(day => {
            const target = ALL_DAYS.indexOf(normDay(day));
            if (target === -1) return;
            const diff = (target - now.getDay() + 7) % 7 || 7;
            const next = new Date(now);
            next.setDate(now.getDate() + diff);
            if (!earliest || next < earliest) earliest = next;
          });
          if (!earliest) return undefined;
          return (earliest as Date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        };

        // Build one card per client — Active OR Past, never both.
        // First pass: identify all clients with an active booking.
        // Second pass: add to Past only clients not already in Active.
        const activeClientIds = new Set<string>();
        const activeBookingByClient = new Map<string, { bookingId: string; data: any }>();
        const pastBookingByClient  = new Map<string, { bookingId: string; data: any }>();

        bookingsSnap.forEach((doc: any) => {
          const d = doc.data();
          if (!d.clientId) return;
          const bookingId = doc.id;

          if (d.status === 'accepted' && activeBookingIds.has(bookingId)) {
            activeClientIds.add(d.clientId);
            activeBookingByClient.set(d.clientId, { bookingId, data: d });
          } else if (
            ['cancelled', 'completed'].includes(d.status) ||
            (d.status === 'accepted' && !activeBookingIds.has(bookingId))
          ) {
            // Keep most recent past booking per client
            const existing = pastBookingByClient.get(d.clientId);
            const newTs  = d.updatedAt?.seconds ?? d.createdAt?.seconds ?? 0;
            const oldTs  = existing ? (existing.data.updatedAt?.seconds ?? existing.data.createdAt?.seconds ?? 0) : -1;
            if (newTs > oldTs) pastBookingByClient.set(d.clientId, { bookingId, data: d });
          }
        });

        const activeList: FamilyEntry[] = [];
        const pastList: FamilyEntry[] = [];

        const buildEntry = (bookingId: string, data: any, source: 'active' | 'past'): FamilyEntry => {
          const dst = data.schedule?.dayShiftTimes;
          const scheduleDays: string[] = dst && typeof dst === 'object'
            ? Object.keys(dst) : (data.schedule?.days || []);
          return {
            clientId: data.clientId,
            bookingId,
            name: data.clientName || 'Family',
            photoURL: data.clientPhotoURL || undefined,
            source,
            scheduleDays,
            rate: data.rate ?? null,
            nextShift: source === 'active' ? computeNextShift(data) : undefined,
            bookingStatus: data.status,
            careRecipients: data.careRecipients || [],
          };
        };

        activeBookingByClient.forEach(({ bookingId, data }) =>
          activeList.push(buildEntry(bookingId, data, 'active'))
        );
        // Only show in Past if not currently active
        pastBookingByClient.forEach(({ bookingId, data }) => {
          if (!activeClientIds.has(data.clientId))
            pastList.push(buildEntry(bookingId, data, 'past'));
        });

        if (!active) return;
        setActiveFamilies(activeList);
        setPastFamilies(pastList);
      } catch (e) {
        console.warn('Families query failed', e);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => { active = false; };
  }, [uid]);

  const filtered = useMemo(() => {
    const list = filter === 'past' ? pastFamilies : activeFamilies;
    const q = query.trim().toLowerCase();
    return q ? list.filter(f => f.name.toLowerCase().includes(q)) : list;
  }, [filter, activeFamilies, pastFamilies, query]);

  const handleMessage = async (clientId: string, clientName: string) => {
    try {
      const currentUid = uid;
      const currentName = authService.getCurrentUser()?.displayName
        || authService.getCurrentUser()?.email?.split('@')[0]
        || 'Caregiver';
      if (currentUid) {
        const roomId = await chatService.getOrCreateChatRoom(currentUid, currentName, clientId, clientName);
        navigate(`/caregiver/inbox?room=${roomId}`);
      } else {
        navigate('/caregiver/inbox');
      }
    } catch {
      navigate('/caregiver/inbox');
    }
  };

  const TABS: { key: FamilyFilter; label: string; count?: number }[] = [
    { key: 'active', label: 'Active', count: activeFamilies.length },
    { key: 'past',   label: 'Past' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">My Families</h1>

        {/* Tabs + Search row */}
        <div className="flex flex-wrap items-end gap-4 mb-6">
          <div className="flex space-x-1 bg-gray-100 rounded-xl p-1">
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  filter === tab.key
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <span className="ml-1.5 bg-primary-100 text-primary-700 text-xs font-semibold px-1.5 py-0.5 rounded-full">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <SearchIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name…"
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 bg-white text-sm"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm">
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
            <Heart className="w-8 h-8 text-primary-300 mx-auto mb-3" />
            {filter === 'active' ? (
              <>
                <p className="font-semibold text-slate-900 mb-1">No active families yet</p>
                <p className="text-sm text-slate-500">
                  Families will appear here once you accept a booking request.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-slate-900 mb-1">Nothing here yet</p>
                <p className="text-sm text-slate-500">This list will fill up as you work with more families.</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-6">
            {filtered.map(f => (
              <div key={f.clientId} className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow">
                <div className="p-6">

                  {/* Top: Avatar + Name */}
                  <div className="flex items-start space-x-4">
                    <div className="relative">
                      <div className="w-20 h-20 rounded-full border-4 border-white shadow-md overflow-hidden bg-primary-100 flex items-center justify-center">
                        {f.photoURL
                          ? <img src={f.photoURL} alt={f.name} className="w-full h-full object-cover" />
                          : <User className="w-8 h-8 text-primary-400" />
                        }
                      </div>
                    </div>
                    <div className="flex-1">
                      <h2 className="text-xl font-bold text-gray-900">{f.name}</h2>
                      <p className="text-sm text-gray-500 mb-2">Client</p>
                      {f.source === 'active' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 px-2.5 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                          Active booking
                        </span>
                      )}
                      {f.source === 'past' && (
                        <span className="text-xs text-gray-400 italic">Past booking</span>
                      )}
                    </div>
                  </div>

                  {/* Stats Row */}
                  {f.rate && (
                    <div className="flex items-center mt-5 pt-4 border-t border-gray-100">
                      <span className="text-lg font-bold text-primary-600">${f.rate}</span>
                      <span className="text-sm text-gray-500 ml-1">/hr</span>
                    </div>
                  )}

                  {/* Schedule Days */}
                  {f.scheduleDays && f.scheduleDays.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-4">
                      {f.scheduleDays.map(day => (
                        <span key={day} className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                          {day}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Caring for */}
                  {f.careRecipients && f.careRecipients.length > 0 && (
                    <div className="flex items-center space-x-2 mt-4 text-sm text-gray-600">
                      <Heart className="w-4 h-4 text-rose-400 flex-shrink-0" />
                      <span>
                        Caring for:{' '}
                        <span className="font-medium text-gray-900">
                          {f.careRecipients.map((r: any) => r.firstName || r.name || 'Recipient').join(', ')}
                        </span>
                      </span>
                    </div>
                  )}

                  {/* Next Shift / In Progress / Today */}
                  {f.nextShift && f.source === 'active' && (
                    f.nextShift === 'In progress' ? (
                      <div className="flex items-center space-x-2 mt-3 text-sm">
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                        </span>
                        <span className="font-semibold text-green-600">Shift in progress</span>
                      </div>
                    ) : f.nextShift === 'Today' ? (
                      <div className="flex items-center space-x-2 mt-3 text-sm text-gray-600">
                        <Clock className="w-4 h-4 text-primary-500" />
                        <span>Shift <span className="font-semibold text-primary-600">today</span></span>
                      </div>
                    ) : (
                      <div className="flex items-center space-x-2 mt-3 text-sm text-gray-600">
                        <Clock className="w-4 h-4 text-gray-400" />
                        <span>Next shift: <span className="font-medium text-gray-900">{f.nextShift}</span></span>
                      </div>
                    )
                  )}

                  {/* Message button */}
                  <div className="mt-6">
                    <button
                      onClick={() => handleMessage(f.clientId, f.name)}
                      className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl bg-primary-600 hover:bg-primary-700 text-white transition-colors"
                    >
                      <MessageSquare className="w-4 h-4" />
                      Message
                    </button>
                  </div>

                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
