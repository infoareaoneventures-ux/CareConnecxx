import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { Caregiver } from '../types';
import { hasValidTransportDocs } from '../utils/transportDocs';
import { isCaregiverBookable } from '../utils/caregiverEligibility';

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns 0–1: fraction of client's needed days the caregiver covers
function availabilityOverlap(
  cgAvailability: any,
  clientSchedule: any
): number {
  if (!clientSchedule) return 0;

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  // Normalise client schedule to a set of needed day names
  let neededDays: Set<string> = new Set();
  if (Array.isArray(clientSchedule)) {
    clientSchedule.forEach((d: string) => neededDays.add(d.toLowerCase()));
  } else if (typeof clientSchedule === 'object') {
    Object.entries(clientSchedule).forEach(([day, slots]) => {
      const s = slots as any;
      const hasSlots = Array.isArray(s) ? s.length > 0 : !!s;
      if (hasSlots) neededDays.add(day.toLowerCase());
    });
  }

  if (neededDays.size === 0) return 0;

  // Normalise caregiver availability to a set of available day names
  let availDays: Set<string> = new Set();
  if (cgAvailability && typeof cgAvailability === 'object' && !Array.isArray(cgAvailability)) {
    // WeeklySchedule format
    DAYS.forEach(day => {
      const slots = cgAvailability[day];
      if (Array.isArray(slots) && slots.length > 0) availDays.add(day);
    });
  } else if (Array.isArray(cgAvailability)) {
    cgAvailability.forEach((d: string) => availDays.add(d.toLowerCase()));
  }

  if (availDays.size === 0) return 0;

  let matched = 0;
  neededDays.forEach(day => { if (availDays.has(day)) matched++; });
  return matched / neededDays.size;
}

// Returns 0–1: fraction of client's needed care types the caregiver's skills cover
function skillsOverlap(cgSkills: string[], clientNeeds: string[]): number {
  if (!clientNeeds.length || !cgSkills.length) return 0;
  const cgLower = cgSkills.map(s => s.toLowerCase());
  let matched = 0;
  clientNeeds.forEach(need => {
    const n = need.toLowerCase();
    if (cgLower.some(s => s.includes(n) || n.includes(s))) matched++;
  });
  return matched / clientNeeds.length;
}

interface Options {
  maxDistance?: number;
  limit?: number;
}

interface Result {
  caregivers: Caregiver[];
  loading: boolean;
  clientLocations: { lat: number; lng: number }[];
}

export function useNearbyCaregiversWithScores(uid: string | null, options: Options = {}): Result {
  const { maxDistance = 25, limit = 6 } = options;
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [clientLocations, setClientLocations] = useState<{ lat: number; lng: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid || !db) { setLoading(false); return; }
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const fdb = db!;

        // ── 1. Fetch all client data in one batch ──
        const [postsSnap, jpDoc, cpDoc, intakeDoc, seniorDoc] = await Promise.all([
          fdb.collection('job_posts').where('clientId', '==', uid).where('status', '==', 'open').get(),
          fdb.collection('job_postings').doc(uid).get(),
          fdb.collection('carePlans').doc(uid).get(),
          fdb.collection('clientIntakes').doc(uid).get(),
          fdb.collection('senior_profiles').doc(uid).get(),
        ]);

        // ── 2. Resolve client location ──
        const seenLoc = new Set<string>();
        const locs: { lat: number; lng: number }[] = [];
        const addLoc = (lat: any, lng: any) => {
          if (lat == null || lng == null) return;
          const key = `${lat},${lng}`;
          if (!seenLoc.has(key)) { seenLoc.add(key); locs.push({ lat: Number(lat), lng: Number(lng) }); }
        };

        postsSnap.docs.forEach(d => { const p = d.data() as any; addLoc(p.lat, p.lng); });
        if (jpDoc.exists) { const d = jpDoc.data() as any; addLoc(d.lat, d.lng); }
        if (cpDoc.exists) { const d = cpDoc.data() as any; (d.locationPool || []).forEach((loc: any) => addLoc(loc.lat, loc.lng)); }
        if (locs.length === 0) {
          const userDoc = await fdb.collection('users').doc(uid).get();
          if (userDoc.exists) { const d = userDoc.data() as any; addLoc(d.latitude, d.longitude); }
        }
        if (!cancelled) setClientLocations(locs);

        // ── 3. Resolve client care needs + schedule ──
        const intake = intakeDoc.exists ? intakeDoc.data() as any : null;
        const senior = seniorDoc.exists ? seniorDoc.data() as any : null;
        const carePlan = cpDoc.exists ? cpDoc.data() as any : null;
        const jobPostCareTypes = postsSnap.docs.flatMap(d => (d.data() as any).careTypes || []);
        // The wizard's own job_postings/{uid} record (careNeeds + selectedDays) —
        // the one record every family has, whether they set up on the site or by
        // text; the legacy clientIntakes doc is no longer written by either path.
        const jobPosting = jpDoc.exists ? (jpDoc.data() as any) : null;
        const jobPostingCareTypes: string[] = Array.isArray(jobPosting?.careNeeds) ? jobPosting.careNeeds : [];

        // Extract care needs from carePlans recipientPlans (care plan page saves here)
        const carePlanCareTypes: string[] = Object.values(carePlan?.recipientPlans || {})
          .flatMap((plan: any) => plan?.careNeeds || []);

        const allCareTypes: string[] = [
          ...(intake?.careTypes || []),
          ...(intake?.tasks ? Object.keys(intake.tasks).filter(k =>
            Array.isArray(intake.tasks[k]) && intake.tasks[k].length > 0
          ) : []),
          ...(senior?.needs || []),
          ...jobPostCareTypes,
          ...jobPostingCareTypes,
          ...carePlanCareTypes,
        ].filter(Boolean);

        const needsTransportation = carePlanCareTypes.some((t: string) => /transport/i.test(t));

        // Client's needed schedule — try multiple fields. job_postings.selectedDays
        // is the wizard's 3-letter day array (['MON','WED']); availabilityOverlap
        // compares full lowercase day names, so expand the codes first.
        const DAY_CODE_TO_NAME: Record<string, string> = {
          MON: 'monday', TUE: 'tuesday', WED: 'wednesday', THU: 'thursday', FRI: 'friday', SAT: 'saturday', SUN: 'sunday',
        };
        const jobPostingDays: string[] = Array.isArray(jobPosting?.selectedDays)
          ? jobPosting.selectedDays.map((d: string) => DAY_CODE_TO_NAME[String(d).toUpperCase()] || String(d).toLowerCase())
          : [];
        const clientSchedule = intake?.weeklySchedule || intake?.schedule || (jobPostingDays.length ? jobPostingDays : null);

        // ── 4. Fetch caregivers ──
        // Caregivers collection ONLY. The old parallel `users` query
        // (role==caregiver) is gone: it leaked the whole user directory to any
        // authed client, and was redundant — visibility gates on approvedIds
        // (from `caregivers`), and every profile_complete caregiver's caregivers
        // doc carries name+geo (verified against prod 2026-07-11).
        const caregiversSnap = await fdb.collection('publicCaregiverProfiles')
          .where('onboardingStatus', '==', 'profile_complete').limit(100).get().catch(() => null);

        // Bookability contract: onboardingStatus 'profile_complete' (the query above)
        // AND verificationStatus 'approved' (post-filter; the where() is pre-filtering only)
        const approvedIds = new Set<string>(
          caregiversSnap?.docs.filter(d => isCaregiverBookable(d.data() as any)).map(d => d.id) ?? []
        );
        const seenIds = new Set<string>();
        const caregiverList: (Caregiver & { _skillsScore: number; _availScore: number })[] = [];

        const pushDoc = (doc: any) => {
          if (seenIds.has(doc.id)) return;
          if (!approvedIds.has(doc.id)) return;
          const data = doc.data() || {};
          const name = data.name || `${data.firstName || ''} ${data.lastName || ''}`.trim();
          if (!name) return;
          seenIds.add(doc.id);

          const cgLat: number | undefined = data.lat ?? data.latitude ?? data.location?.lat;
          const cgLng: number | undefined = data.lng ?? data.longitude ?? data.location?.lng;
          let dist = 0;
          if (cgLat != null && cgLng != null && locs.length > 0) {
            dist = Math.min(...locs.map(loc => haversineDistance(loc.lat, loc.lng, cgLat, cgLng)));
            dist = Math.round(dist * 10) / 10;
          }

          const cgSkills: string[] = data.skills || data.specializations || [];
          const cgAvailability = data.weeklyAvailability || data.availability;

          caregiverList.push({
            id: doc.id,
            uid: doc.id,
            name,
            hourlyRate: data.hourlyRate || 25,
            rating: data.rating || 5.0,
            reviewCount: data.reviewCount ?? 0,
            city: data.city || data.location?.city || '',
            state: data.state || data.location?.state || '',
            zipCode: data.zipCode || data.zip || '',
            verified: data.verified || data.backgroundCheckComplete || false,
            verificationStatus: data.verificationStatus,
            backgroundCheckStatus: data.backgroundCheckStatus || (data.verified ? 'clear' : 'none'),
            distance: dist,
            latitude: cgLat,
            longitude: cgLng,
            imageUrl: data.photoURL || data.photo || data.imageUrl || data.profilePhoto,
            documents: data.documents || {},
            skills: cgSkills,
            certifications: data.certifications || [],
            experience: data.experience || data.yearsExperience || 0,
            bio: data.bio || data.about || '',
            availability: Array.isArray(data.availability) ? data.availability : [],
            instantPayAvailable: data.instantPayAvailable || false,
            personalityTags: data.personalityTags || [],
            serviceRadius: data.serviceRadius ?? data.travelRadius ?? null,
            matchScore: 0,
            _skillsScore: skillsOverlap(cgSkills, allCareTypes),
            _availScore: availabilityOverlap(cgAvailability, clientSchedule),
          } as any);
        };

        // Caregivers collection is the sole discovery source (richer data:
        // documents, verificationStatus, canonical name/geo).
        caregiversSnap?.forEach(pushDoc);

        // Bookability was already enforced by approvedIds in pushDoc.
        // ── 5. Hard filter: distance + caregiver's own serviceRadius ──
        const withinRange = locs.length > 0
          ? caregiverList.filter(c => {
              if ((c as any).latitude == null || (c as any).longitude == null) return true;
              if (c.distance > maxDistance) return false;
              const sr = (c as any).serviceRadius ?? (c as any).travelRadius;
              if (sr != null && sr > 0 && c.distance > sr) return false;
              return true;
            })
          : caregiverList;

        // ── 6. Hard filter: transportation if needed ──
        const filtered = needsTransportation
          ? withinRange.filter(c => hasValidTransportDocs(c as any))
          : withinRange;

        // ── 7. Sort: skills overlap → availability overlap → rating → distance ──
        const sorted = filtered
          .sort((a, b) => {
            const skillsDiff = (b as any)._skillsScore - (a as any)._skillsScore;
            if (Math.abs(skillsDiff) > 0.01) return skillsDiff;
            const availDiff = (b as any)._availScore - (a as any)._availScore;
            if (Math.abs(availDiff) > 0.01) return availDiff;
            const ratingDiff = (b.rating || 0) - (a.rating || 0);
            if (ratingDiff !== 0) return ratingDiff;
            return (a.distance || 0) - (b.distance || 0);
          })
          .slice(0, limit);

        if (!cancelled) setCaregivers(sorted);
      } catch (e) {
        console.error('useNearbyCaregiversWithScores error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [uid, maxDistance, limit]);

  return { caregivers, loading, clientLocations };
}
