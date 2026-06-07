import React, { useEffect, useMemo, useState } from 'react';
import { Heart, Search as SearchIcon, MessageSquare, User, X, Phone, FileText } from 'lucide-react';
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
  bookingStatus?: string;
  careRecipients?: Array<{ firstName?: string; name?: string; [key: string]: any }>;
}

export const CaregiverFamiliesPage: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser } = useCareConnex();
  const uid = currentUser?.uid || authService.getCurrentUser()?.uid;
  const [detailsEntry, setDetailsEntry] = useState<FamilyEntry | null>(null);
  const [detailsData, setDetailsData] = useState<any>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const openDetails = async (f: FamilyEntry) => {
    setDetailsEntry(f);
    setDetailsData(null);
    setDetailsLoading(true);
    try {
      if (f.bookingId) {
        const snap = await db!.collection('booking_requests').doc(f.bookingId).get();
        if (snap.exists) setDetailsData(snap.data());
      }
    } catch { /* non-fatal */ }
    finally { setDetailsLoading(false); }
  };

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

        // Fetch missing photos from users collection
        const allEntries = [...activeList, ...pastList];
        const missingPhoto = allEntries.filter(e => !e.photoURL);
        if (missingPhoto.length > 0) {
          await Promise.all(missingPhoto.map(async e => {
            try {
              const uSnap = await db!.collection('users').doc(e.clientId).get();
              const url = uSnap.data()?.photoURL || uSnap.data()?.photo || null;
              if (url) e.photoURL = url;
            } catch { /* non-fatal */ }
          }));
        }

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
    <>
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


                  {/* Buttons */}
                  <div className="mt-6 flex gap-2">
                    <button
                      onClick={() => openDetails(f)}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl border border-primary-600 text-primary-600 hover:bg-primary-50 transition-colors"
                    >
                      <FileText className="w-4 h-4" />
                      View Details
                    </button>
                    <button
                      onClick={() => handleMessage(f.clientId, f.name)}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-xl bg-primary-600 hover:bg-primary-700 text-white transition-colors"
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

    {/* Details Modal */}

    {detailsEntry && (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="px-6 pt-6 pb-4 border-b border-slate-100 flex items-start justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center text-primary-700 font-bold shrink-0">
                {detailsEntry.photoURL
                  ? <img src={detailsEntry.photoURL} alt={detailsEntry.name} className="w-full h-full object-cover" />
                  : detailsEntry.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">{detailsEntry.name}</h3>
                <p className="text-xs text-slate-400 mt-0.5">Care details</p>
              </div>
            </div>
            <button onClick={() => { setDetailsEntry(null); setDetailsData(null); }} className="text-slate-400 hover:text-slate-600 p-1 -mr-1 -mt-1">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
            {detailsLoading ? (
              <p className="text-sm text-slate-400 text-center py-8">Loading...</p>
            ) : (
              <>
                {detailsData?.careRecipients?.map((r: any, i: number) => {
                  const ls = r.lifestyle || null;
                  return (
                    <div key={i} className="space-y-4">
                      {/* Recipient header */}
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary-100 overflow-hidden flex items-center justify-center text-primary-700 font-bold text-sm">
                          {r.photoURL
                            ? <img src={r.photoURL} alt={r.firstName || r.name} className="w-full h-full object-cover" />
                            : (r.firstName || r.name || 'R').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-800">{r.firstName || r.name}</p>
                          {(r.relationship || r.age) && <p className="text-xs text-slate-400">{[r.relationship, r.age ? `Age ${r.age}` : null].filter(Boolean).join(' · ')}</p>}
                        </div>
                      </div>

                      {/* Care Plan */}
                      {r.careNeeds?.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Care Plan</p>
                          <div className="space-y-1.5">
                            {r.careNeeds.map((need: string) => (
                              <div key={need} className="bg-primary-50 border border-primary-100 rounded-xl px-3 py-2">
                                <p className="text-sm font-medium text-primary-700">{need}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Lifestyle */}
                      {ls && ((ls.favoriteActivities?.length || 0) > 0 || (ls.helpActivities?.length || 0) > 0 || (ls.entertainment?.length || 0) > 0 || ls.enjoysConversation !== null || ls.prefersQuiet !== null || ls.familyInArea !== null || ls.friendsVisitors !== null || ls.hasAppointments !== null) && (
                        <div>
                          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Lifestyle</p>
                          <div className="space-y-2">
                            {ls.favoriteActivities?.length > 0 && <div><p className="text-xs text-slate-400 mb-1">Enjoys</p><div className="flex flex-wrap gap-1">{ls.favoriteActivities.map((a: string) => <span key={a} className="text-xs bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>{ls.favoriteActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.favoriteActivitiesOther}</p>}</div>}
                            {ls.helpActivities?.length > 0 && <div><p className="text-xs text-slate-400 mb-1">Needs help with</p><div className="flex flex-wrap gap-1">{ls.helpActivities.map((a: string) => <span key={a} className="text-xs bg-amber-50 text-amber-700 border border-amber-100 px-2 py-0.5 rounded-full">{a}</span>)}</div>{ls.helpActivitiesOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.helpActivitiesOther}</p>}</div>}
                            {ls.entertainment?.length > 0 && <div><p className="text-xs text-slate-400 mb-1">Entertainment</p><div className="flex flex-wrap gap-1">{ls.entertainment.map((e: string) => <span key={e} className="text-xs bg-purple-50 text-purple-700 border border-purple-100 px-2 py-0.5 rounded-full">{e}</span>)}</div>{ls.entertainmentOther && <p className="text-xs text-slate-500 mt-0.5"><span className="font-medium text-slate-400">Other:</span> {ls.entertainmentOther}</p>}</div>}
                            <div className="space-y-1">
                              {([
                                { label: 'Enjoys conversation', key: 'enjoysConversation' },
                                { label: 'Prefers quiet', key: 'prefersQuiet' },
                                { label: 'Family in area', key: 'familyInArea' },
                                { label: 'Friends or visitors', key: 'friendsVisitors' },
                                { label: 'Has appointments', key: 'hasAppointments' },
                              ] as const).filter(({ key }) => ls[key] !== null && ls[key] !== undefined).map(({ label, key }) => (
                                <React.Fragment key={key}>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-500">{label}</span>
                                    <span className={`px-2 py-0.5 rounded-full font-semibold ${ls[key] === true ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{ls[key] === true ? 'Yes' : 'No'}</span>
                                  </div>
                                  {key === 'familyInArea' && ls.familyInArea === true && ls.familyVisitFreq && <div className="flex items-center justify-between text-xs"><span className="text-slate-400">Family visit frequency</span><span className="text-slate-600 font-medium">{ls.familyVisitFreq}</span></div>}
                                  {key === 'friendsVisitors' && ls.friendsVisitors === true && ls.friendsVisitFreq && <div className="flex items-center justify-between text-xs"><span className="text-slate-400">Friends visit frequency</span><span className="text-slate-600 font-medium">{ls.friendsVisitFreq}</span></div>}
                                </React.Fragment>
                              ))}
                            </div>
                            {ls.hasAppointments === true && ls.appointmentsDetails && <p className="text-xs text-slate-500"><span className="font-medium text-slate-400">Appointments:</span> {ls.appointmentsDetails}</p>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Emergency Contact */}
                {detailsData?.emergencyContact?.name && (
                  <div className="flex items-center gap-4 bg-red-50 border border-red-100 rounded-2xl px-5 py-4">
                    <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                      <Phone className="w-4 h-4 text-red-500" />
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold text-red-400 uppercase tracking-wide mb-0.5">Emergency Contact</p>
                      <p className="text-sm font-bold text-slate-800">
                        {detailsData.emergencyContact.name}
                        {detailsData.emergencyContact.relationship && <span className="text-slate-400 font-normal text-xs"> · {detailsData.emergencyContact.relationship}</span>}
                      </p>
                      {detailsData.emergencyContact.phone && <p className="text-sm font-semibold text-red-500 mt-0.5">{detailsData.emergencyContact.phone}</p>}
                    </div>
                  </div>
                )}

                {!detailsData && <p className="text-sm text-slate-400 text-center py-4">No details available.</p>}
              </>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
};
