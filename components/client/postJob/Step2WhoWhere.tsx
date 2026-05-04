import React, { useState, useEffect } from 'react';
import { Loader2, UserCircle2, User, X, Plus, Minus, MapPin } from 'lucide-react';
import { StepProps } from './types';
import { useCareConnex } from '../../../context/CareConnexContext';
import { dbService } from '../../../services/api';
import { db } from '../../../lib/firebase';
import firebase from '../../../lib/firebase';

const RELATIONSHIP_CHIPS = ['Parent', 'Spouse or Partner', 'Other'];

interface SavedPerson {
  id: string;
  firstName: string;
  lastName: string;
  relationship?: string;
  isSelf?: boolean;
}

interface SavedLocation {
  id: string;
  street: string;
  city: string;
  state: string;
  zipCode: string;
}

export const Step2WhoWhere: React.FC<StepProps> = ({ data, onChange, onContinue, onBack, onShowToast }) => {
  const { currentUser } = useCareConnex();

  // People state
  const [savedPeople, setSavedPeople] = useState<SavedPerson[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newPerson, setNewPerson] = useState({ firstName: '', lastName: '', relationship: '' });

  // Location state
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [selectedLocationId, setSelectedLocationId] = useState('');
  const [showLocationForm, setShowLocationForm] = useState(false);
  const [newLocation, setNewLocation] = useState({ street: '', zipCode: '', city: '', state: '' });
  const [locZipLoading, setLocZipLoading] = useState(false);

  useEffect(() => {
    if (!currentUser?.uid) {
      setLoadingSaved(false);
      setLoadingLocations(false);
      return;
    }

    // --- People ---
    const people: SavedPerson[] = [];
    const seenNames = new Set<string>();
    const displayName = currentUser.displayName || '';
    const nameParts = displayName.trim().split(' ');
    const selfFirst = nameParts[0] || '';
    const selfLast = nameParts.slice(1).join(' ');
    people.push({ id: `self-${currentUser.uid}`, firstName: selfFirst || 'Me', lastName: selfLast, relationship: 'Myself', isSelf: true });
    if (selfFirst) seenNames.add(`${selfFirst.toLowerCase()} ${selfLast.toLowerCase()}`.trim());

    Promise.all([
      dbService.getSeniorProfile(currentUser.uid).catch(() => null),
      db ? db.collection('job_postings').doc(currentUser.uid).get().catch(() => null) : Promise.resolve(null),
    ]).then(([profile, jobSnap]) => {
      // People from senior_profiles
      if (profile) {
        const pFirst = ((profile as any).firstName || profile.name?.split(' ')[0] || '').trim();
        const pLast = ((profile as any).lastName || profile.name?.split(' ').slice(1).join(' ') || '').trim();
        const key = `${pFirst.toLowerCase()} ${pLast.toLowerCase()}`.trim();
        if (pFirst && !seenNames.has(key)) {
          seenNames.add(key);
          people.push({ id: currentUser.uid, firstName: pFirst, lastName: pLast, relationship: (profile as any).relationship });
        }
      }

      // People + locations from job_postings
      const locations: SavedLocation[] = [];
      const seenAddresses = new Set<string>();

      if (jobSnap && (jobSnap as any).exists) {
        const jp = (jobSnap as any).data() as any;

        // Primary recipient
        const jpFirst = (jp.careRecipientFirstName || '').trim();
        const jpLast = (jp.careRecipientLastName || '').trim();
        const jpKey = `${jpFirst.toLowerCase()} ${jpLast.toLowerCase()}`.trim();
        if (jpFirst && !seenNames.has(jpKey)) {
          seenNames.add(jpKey);
          people.push({ id: `jp-primary`, firstName: jpFirst, lastName: jpLast, relationship: jp.relationship });
        }
        if (Array.isArray(jp.additionalRecipients)) {
          jp.additionalRecipients.forEach((r: any, i: number) => {
            const rFirst = (r.firstName || '').trim();
            const rLast = (r.lastName || '').trim();
            const rKey = `${rFirst.toLowerCase()} ${rLast.toLowerCase()}`.trim();
            if (rFirst && !seenNames.has(rKey)) {
              seenNames.add(rKey);
              people.push({ id: `jp-add-${i}`, firstName: rFirst, lastName: rLast, relationship: r.relationship });
            }
          });
        }

        // Primary address
        if (jp.street && jp.zipCode) {
          const addrKey = `${jp.street.toLowerCase()}${jp.zipCode}`;
          if (!seenAddresses.has(addrKey)) {
            seenAddresses.add(addrKey);
            locations.push({ id: 'primary', street: jp.street, city: jp.city || '', state: jp.state || '', zipCode: jp.zipCode });
          }
        }

        // Additional saved locations
        if (Array.isArray(jp.savedLocations)) {
          jp.savedLocations.forEach((loc: any, i: number) => {
            if (loc.street && loc.zipCode) {
              const addrKey = `${loc.street.toLowerCase()}${loc.zipCode}`;
              if (!seenAddresses.has(addrKey)) {
                seenAddresses.add(addrKey);
                locations.push({ id: `saved-${i}`, street: loc.street, city: loc.city || '', state: loc.state || '', zipCode: loc.zipCode });
              }
            }
          });
        }
      }

      setSavedPeople(people);
      setSavedLocations(locations);
      setLoadingSaved(false);
      setLoadingLocations(false);
    });
  }, [currentUser?.uid]);

  // --- People logic ---
  const maxReached = data.careRecipients.length >= data.recipientsCount;
  const isSelected = (id: string) => data.careRecipients.some(r => r.id === id);

  const toggleSavedPerson = (person: SavedPerson) => {
    if (isSelected(person.id)) {
      onChange({ careRecipients: data.careRecipients.filter(r => r.id !== person.id) });
    } else {
      if (maxReached) return;
      onChange({ careRecipients: [...data.careRecipients, { id: person.id, firstName: person.firstName, lastName: person.lastName, relationship: person.relationship || '' }] });
    }
  };

  const removeRecipient = (idx: number) => onChange({ careRecipients: data.careRecipients.filter((_, i) => i !== idx) });

  const setCount = (count: 1 | 2 | 3 | 4) => onChange({ recipientsCount: count, careRecipients: data.careRecipients.slice(0, count) });

  const addNewPerson = () => {
    if (!newPerson.firstName.trim()) { onShowToast('First name is required', 'error'); return; }
    if (!newPerson.relationship) { onShowToast('Please select a relationship', 'error'); return; }
    const entry = { firstName: newPerson.firstName.trim(), lastName: newPerson.lastName.trim(), relationship: newPerson.relationship };
    onChange({ careRecipients: [...data.careRecipients, entry] });
    if (db && currentUser?.uid) {
      db.collection('job_postings').doc(currentUser.uid).set(
        { additionalRecipients: firebase.firestore.FieldValue.arrayUnion({ ...entry, age: '' }) },
        { merge: true }
      ).catch(() => {});
      setSavedPeople(prev => {
        const key = `${entry.firstName.toLowerCase()} ${entry.lastName.toLowerCase()}`.trim();
        if (prev.some(p => `${p.firstName.toLowerCase()} ${p.lastName.toLowerCase()}`.trim() === key)) return prev;
        return [...prev, { id: `new-${Date.now()}`, ...entry }];
      });
    }
    setNewPerson({ firstName: '', lastName: '', relationship: '' });
    setShowNewForm(false);
  };

  // --- Location logic ---
  const selectLocation = (loc: SavedLocation) => {
    setSelectedLocationId(loc.id);
    onChange({ streetAddress: loc.street, city: loc.city, state: loc.state, zipCode: loc.zipCode });
  };

  const handleLocZipChange = async (zip: string) => {
    const clean = zip.replace(/\D/g, '');
    setNewLocation(l => ({ ...l, zipCode: clean, city: clean.length < 5 ? l.city : l.city, state: clean.length < 5 ? l.state : l.state }));
    if (clean.length === 5) {
      setLocZipLoading(true);
      try {
        const res = await fetch(`https://api.zippopotam.us/us/${clean}`);
        if (res.ok) {
          const json = await res.json();
          const place = json.places?.[0];
          if (place) setNewLocation(l => ({ ...l, zipCode: clean, city: place['place name'], state: place['state abbreviation'] }));
        }
      } catch { /* silent */ } finally { setLocZipLoading(false); }
    }
  };

  const addNewLocation = () => {
    if (!newLocation.street.trim()) { onShowToast('Please enter a street address', 'error'); return; }
    if (!/^\d{5}$/.test(newLocation.zipCode)) { onShowToast('Zip code must be 5 digits', 'error'); return; }
    if (!newLocation.city.trim()) { onShowToast('Please enter a city', 'error'); return; }

    const loc: SavedLocation = {
      id: `new-loc-${Date.now()}`,
      street: newLocation.street.trim(),
      city: newLocation.city.trim(),
      state: newLocation.state.trim(),
      zipCode: newLocation.zipCode,
    };

    // Select it immediately
    setSelectedLocationId(loc.id);
    onChange({ streetAddress: loc.street, city: loc.city, state: loc.state, zipCode: loc.zipCode });

    // Save to care plan
    if (db && currentUser?.uid) {
      db.collection('job_postings').doc(currentUser.uid).set(
        { savedLocations: firebase.firestore.FieldValue.arrayUnion({ street: loc.street, city: loc.city, state: loc.state, zipCode: loc.zipCode }) },
        { merge: true }
      ).catch(() => {});
    }

    setSavedLocations(prev => [...prev, loc]);
    setNewLocation({ street: '', zipCode: '', city: '', state: '' });
    setShowLocationForm(false);
  };

  const handleContinue = () => {
    if (data.careRecipients.length === 0) { onShowToast('Select at least one care recipient', 'error'); return; }
    for (const r of data.careRecipients) {
      if (!r.relationship.trim()) { onShowToast(`Please select a relationship for ${r.firstName}`, 'error'); return; }
    }
    if (!data.streetAddress.trim()) { onShowToast('Please select or add a care location', 'error'); return; }
    if (!data.city.trim()) { onShowToast('Please enter a city', 'error'); return; }
    if (!data.state.trim()) { onShowToast('Please enter a state', 'error'); return; }
    if (!/^\d{5}$/.test(data.zipCode.trim())) { onShowToast('Zip code must be 5 digits', 'error'); return; }
    onContinue();
  };

  return (
    <div>
      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center mb-1">Who's receiving care?</h2>
      <p className="text-center text-slate-500 mb-8">Your address and care recipient details are never shown to caregivers — only distance.</p>

      <div className="space-y-6">

        {/* How many people */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-3">How many people need care?</label>
          <div className="inline-flex items-center gap-3 bg-white border-2 border-slate-200 rounded-xl px-3 py-2">
            <button type="button" onClick={() => setCount((Math.max(1, data.recipientsCount - 1)) as 1 | 2 | 3 | 4)} disabled={data.recipientsCount === 1}
              className="w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40">
              <Minus className="w-4 h-4" />
            </button>
            <span className="w-8 text-center text-lg font-semibold text-slate-900">{data.recipientsCount}</span>
            <button type="button" onClick={() => setCount((Math.min(4, data.recipientsCount + 1)) as 1 | 2 | 3 | 4)} disabled={data.recipientsCount === 4}
              className="w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40">
              <Plus className="w-4 h-4" />
            </button>
            <span className="text-sm text-slate-500">{data.recipientsCount === 1 ? 'Care Recipient' : 'Care Recipients'}</span>
          </div>
          {data.recipientsCount > 2 && (
            <p className="mt-2 text-xs text-amber-600 font-medium">For more than 2 care recipients, multiple caregivers may be needed.</p>
          )}
        </div>

        {/* Care recipients */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="block text-sm font-semibold text-slate-700">Select care recipient{data.recipientsCount > 1 ? 's' : ''}</label>
            <span className="text-xs text-slate-400">{data.careRecipients.length} / {data.recipientsCount} selected</span>
          </div>

          {loadingSaved ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm mb-3"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : (
            <div className="flex flex-col gap-2 mb-3">
              {savedPeople.map(person => {
                const selected = isSelected(person.id);
                const disabled = !selected && maxReached;
                return (
                  <button key={person.id} type="button" onClick={() => toggleSavedPerson(person)} disabled={disabled}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all ${
                      selected ? 'border-primary-600 bg-primary-50' : disabled ? 'border-slate-100 bg-slate-50 opacity-40 cursor-not-allowed' : 'border-slate-200 bg-white hover:border-primary-300'
                    }`}>
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${person.isSelf ? (selected ? 'bg-teal-100' : 'bg-teal-50') : (selected ? 'bg-primary-100' : 'bg-slate-100')}`}>
                      {person.isSelf ? <User className={`w-5 h-5 ${selected ? 'text-teal-600' : 'text-teal-400'}`} /> : <UserCircle2 className={`w-5 h-5 ${selected ? 'text-primary-600' : 'text-slate-400'}`} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 text-sm">
                        {person.isSelf ? `Myself${person.firstName && person.firstName !== 'Me' ? ` (${person.firstName} ${person.lastName})`.trim() : ''}` : `${person.firstName} ${person.lastName}`.trim()}
                      </p>
                      <p className="text-xs text-slate-500 capitalize">{person.isSelf ? "I'm the one receiving care" : person.relationship || ''}</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${selected ? 'border-primary-600 bg-primary-600' : 'border-slate-300'}`}>
                      {selected && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Relationship prompt */}
          {data.careRecipients.map((r, idx) => (!r.relationship && !r.isSelf) ? (
            <div key={idx} className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-2">
              <div className="flex items-center justify-between mb-2">
                <p className="font-semibold text-slate-800 text-sm">{r.firstName} {r.lastName}</p>
                <button type="button" onClick={() => removeRecipient(idx)} className="text-slate-400 hover:text-red-500"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-amber-600 mb-2">What is your relationship to this person?</p>
              <div className="flex flex-wrap gap-2">
                {RELATIONSHIP_CHIPS.map(chip => (
                  <button key={chip} type="button"
                    onClick={() => { const u = [...data.careRecipients]; u[idx] = { ...u[idx], relationship: chip }; onChange({ careRecipients: u }); }}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:border-primary-400 hover:text-primary-600 transition-all">
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          ) : null)}

          {/* Add new person — hidden once saved pool hits 4 */}
          {!maxReached && savedPeople.length < 4 && (showNewForm ? (
            <div className="border-2 border-primary-200 bg-primary-50 rounded-xl p-4 flex flex-col gap-3">
              <p className="text-sm font-semibold text-slate-700">Who are they to you?</p>
              <div className="flex flex-wrap gap-2">
                {RELATIONSHIP_CHIPS.map(chip => (
                  <button key={chip} type="button" onClick={() => setNewPerson(p => ({ ...p, relationship: chip }))}
                    className={`px-4 py-2 rounded-xl border-2 text-sm font-semibold transition-all ${newPerson.relationship === chip ? 'border-primary-600 bg-primary-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-primary-300'}`}>
                    {chip}
                  </button>
                ))}
              </div>
              {newPerson.relationship && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <input type="text" placeholder="First name *" value={newPerson.firstName} onChange={e => setNewPerson(p => ({ ...p, firstName: e.target.value }))} className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-100" />
                    <input type="text" placeholder="Last name" value={newPerson.lastName} onChange={e => setNewPerson(p => ({ ...p, lastName: e.target.value }))} className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-100" />
                  </div>
                  <button type="button" onClick={addNewPerson} className="w-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold py-2 rounded-lg transition-colors">Add & save to care plan</button>
                </>
              )}
              <button type="button" onClick={() => { setShowNewForm(false); setNewPerson({ firstName: '', lastName: '', relationship: '' }); }} className="w-full bg-white border border-slate-200 text-slate-600 text-sm font-medium py-2 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setShowNewForm(true)} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-slate-300 text-slate-500 hover:border-primary-400 hover:text-primary-600 transition-all text-sm font-medium">
              <Plus className="w-4 h-4" /> Add another person
            </button>
          ))}
        </div>

        {/* Care location */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-3">Care location</label>

          {loadingLocations ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm mb-3"><Loader2 className="w-4 h-4 animate-spin" /> Loading saved locations…</div>
          ) : savedLocations.length > 0 && (
            <div className="flex flex-col gap-2 mb-3">
              {savedLocations.map(loc => {
                const selected = selectedLocationId === loc.id;
                return (
                  <button key={loc.id} type="button" onClick={() => selectLocation(loc)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all ${selected ? 'border-primary-600 bg-primary-50' : 'border-slate-200 bg-white hover:border-primary-300'}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${selected ? 'bg-primary-100' : 'bg-slate-100'}`}>
                      <MapPin className={`w-5 h-5 ${selected ? 'text-primary-600' : 'text-slate-400'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 text-sm">{loc.street}</p>
                      <p className="text-xs text-slate-500">{loc.city}{loc.city && loc.state ? ', ' : ''}{loc.state} {loc.zipCode}</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${selected ? 'border-primary-600 bg-primary-600' : 'border-slate-300'}`}>
                      {selected && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Add new location form */}
          {showLocationForm ? (
            <div className="border-2 border-primary-200 bg-primary-50 rounded-xl p-4 flex flex-col gap-3">
              <p className="text-sm font-semibold text-slate-700">New location</p>
              <input type="text" placeholder="Street address *" value={newLocation.street} onChange={e => setNewLocation(l => ({ ...l, street: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-100" />
              <div className="relative w-40">
                <input type="text" inputMode="numeric" maxLength={5} placeholder="Zip code *" value={newLocation.zipCode} onChange={e => handleLocZipChange(e.target.value)} className="w-full px-3 py-2 pr-8 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-100" />
                {locZipLoading && <Loader2 className="w-4 h-4 text-primary-500 absolute right-2 top-1/2 -translate-y-1/2 animate-spin" />}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input type="text" placeholder="City" value={newLocation.city} onChange={e => setNewLocation(l => ({ ...l, city: e.target.value }))} className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-100" />
                <input type="text" placeholder="State" maxLength={2} value={newLocation.state} onChange={e => setNewLocation(l => ({ ...l, state: e.target.value.toUpperCase() }))} className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-100 uppercase" />
              </div>
              <button type="button" onClick={addNewLocation} className="w-full bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold py-2 rounded-lg transition-colors">Add & save to care plan</button>
              <button type="button" onClick={() => { setShowLocationForm(false); setNewLocation({ street: '', zipCode: '', city: '', state: '' }); }} className="w-full bg-white border border-slate-200 text-slate-600 text-sm font-medium py-2 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
            </div>
          ) : savedLocations.length < 4 ? (
            <button type="button" onClick={() => setShowLocationForm(true)} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-slate-300 text-slate-500 hover:border-primary-400 hover:text-primary-600 transition-all text-sm font-medium">
              <Plus className="w-4 h-4" />
              {savedLocations.length === 0 ? 'Add a care location' : 'Add another location'}
            </button>
          ) : (
            <p className="text-center text-xs text-slate-400 py-2">Maximum of 4 care locations reached.</p>
          )}
        </div>

      </div>

      <div className="mt-8 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700 font-medium">Back</button>
        <button type="button" onClick={handleContinue} className="bg-primary-600 hover:bg-primary-700 text-white font-semibold px-10 py-3 rounded-xl shadow-md transition-colors">Continue</button>
      </div>
    </div>
  );
};
