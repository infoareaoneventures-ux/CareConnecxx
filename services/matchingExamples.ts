/**
 * CARECONNEX MATCHING SYSTEM - USAGE EXAMPLES
 * 
 * This file shows how to properly use the updated availability and matching services
 * after the security and algorithm fixes.
 */

import { matchService } from './matchService';
import { availabilityService } from './availabilityService';
import { aiService } from './ai';
import { Caregiver, Senior, MatchFeedback } from '../types';

// ==========================================
// EXAMPLE 1: Basic Caregiver Matching (Fixed)
// ==========================================

export const findMatchesForSenior = async (
  caregivers: Caregiver[],
  seniorProfile: Senior,
  feedbackHistory: MatchFeedback[]
) => {
  // Get top 5 matches using the FIXED algorithm
  const topMatches = await matchService.getTopMatches(
    caregivers,
    seniorProfile,
    feedbackHistory,
    5
  );

  return topMatches;
};

// ==========================================
// EXAMPLE 2: Matching with Specific Time (CRITICAL FIX)
// ==========================================

export const findAvailableMatches = async (
  caregivers: Caregiver[],
  seniorProfile: Senior,
  requestedDate: Date,      // e.g., new Date('2026-02-10')
  requestedTime: string,    // e.g., '14:00' (2 PM)
  duration: number          // e.g., 3 (hours)
) => {
  // This now checks REAL availability including existing bookings!
  const availableMatches = await matchService.scoreCaregivers(
    caregivers,
    seniorProfile,
    [], // feedback history
    {
      requestedDate,
      requestedTime,
      requestedDuration: duration
    }
  );

  return availableMatches.filter(c => c.matchScore > 50);
};

// ==========================================
// EXAMPLE 3: Micro-Visit Matching
// ==========================================

export const findMicroVisitMatches = async (
  caregivers: Caregiver[],
  seniorProfile: Senior,
  requestedDate: Date,
  requestedTime: string
) => {
  const matches = await matchService.scoreCaregivers(
    caregivers,
    seniorProfile,
    [],
    {
      isMicroVisit: true,  // Special scoring for short visits
      requestedDate,
      requestedTime,
      requestedDuration: 0.5 // 30 minutes
    }
  );

  return matches;
};

// ==========================================
// EXAMPLE 4: Direct Availability Check
// ==========================================

export const checkCaregiverAvailability = async (
  caregiver: Caregiver,
  date: Date,
  startTime: string,
  durationHours: number
): Promise<boolean> => {
  // This now checks BOTH weekly schedule AND existing appointments
  const isAvailable = await availabilityService.isAvailable(
    caregiver,
    date,
    startTime,
    durationHours
  );

  return isAvailable;
};

// ==========================================
// EXAMPLE 5: Find Next Available Slot
// ==========================================

export const findNextAvailableTime = async (
  caregiver: Caregiver,
  startFrom: Date,
  durationHours: number
) => {
  const nextSlot = await availabilityService.getNextAvailableSlot(
    caregiver,
    startFrom,
    durationHours
  );

  if (nextSlot) {
    console.log(`${caregiver.name} is next available on ${nextSlot.date.toDateString()} at ${nextSlot.time}`);
  }

  return nextSlot;
};

// ==========================================
// EXAMPLE 6: Batch Availability Check (Performance)
// ==========================================

export const batchCheckAvailability = async (
  caregivers: Caregiver[],
  date: Date,
  startTime: string,
  durationHours: number
): Promise<Caregiver[]> => {
  // More efficient than checking one by one
  const availabilityMap = await availabilityService.batchCheckAvailability(
    caregivers,
    date,
    startTime,
    durationHours
  );

  // Filter to only available caregivers
  return caregivers.filter(c => availabilityMap.get(c.id));
};

// ==========================================
// EXAMPLE 7: Updated AI Search with Availability
// ==========================================

// In your AiSearchAgent or SimpleSearchWizard:

export const searchWithAvailability = async (
  query: string,
  caregivers: Caregiver[],
  seniorProfile: Senior,
  requestedDate?: Date,
  requestedTime?: string,
  requestedDuration?: number
) => {
  // 1. First, get AI recommendations (natural language understanding)
  const aiResult = await aiService.searchCaregivers(query, caregivers, seniorProfile);

  // 2. Get the recommended caregivers
  let candidates = aiResult.recommendedIds
    .map(id => caregivers.find(c => c.id === id))
    .filter((c): c is Caregiver => c !== undefined);

  // 3. If specific time requested, check real availability
  if (requestedDate && requestedTime && requestedDuration) {
    candidates = await matchService.scoreCaregivers(
      candidates,
      seniorProfile,
      [],
      {
        requestedDate,
        requestedTime,
        requestedDuration
      }
    );
    
    // Filter out unavailable caregivers
    candidates = candidates.filter(c => c.matchScore > 0);
  }

  // 4. Return top matches
  return candidates.slice(0, 5);
};

// ==========================================
// EXAMPLE 8: Display Match Score with Reasons
// ==========================================

// In your React component:
/*
const CaregiverCard = ({ caregiver }: { caregiver: Caregiver }) => {
  return (
    <div className="caregiver-card">
      <h3>{caregiver.name}</h3>
      
      // Show match score with color coding
      <div className={`score ${getScoreClass(caregiver.matchScore)}`}>
        {caregiver.matchScore}% Match
      </div>
      
      // Show reasoning
      <p className="reasoning">{caregiver.matchReasoning}</p>
      
      // Show detailed reasons
      {caregiver.matchReasons?.map((reason, i) => (
        <span key={i} className="reason-tag">✓ {reason}</span>
      ))}
      
      // Show flags if any
      {caregiver.matchFlags?.map((flag, i) => (
        <span key={i} className="flag-tag">⚠ {flag}</span>
      ))}
    </div>
  );
};

const getScoreClass = (score?: number) => {
  if (!score) return 'unknown';
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
};
*/

// ==========================================
// MIGRATION GUIDE: Updating Your Code
// ==========================================

/*
BEFORE (Old Code):
-----------------
const matches = caregivers.map(c => 
  matchService.scoreCaregiver(c, seniorProfile, feedback)
).filter(c => c.matchScore > 50);

AFTER (Fixed Code):
------------------
const matches = await matchService.scoreCaregivers(
  caregivers,
  seniorProfile,
  feedback,
  {
    requestedDate: new Date('2026-02-10'),
    requestedTime: '14:00',
    requestedDuration: 3
  }
);

Key Changes:
1. Function is now ASYNC (uses await)
2. Pass date/time context for availability checking
3. Returns properly capped scores (0-100)
4. Checks real appointment conflicts
*/

// ==========================================
// IMPORTANT: Update Your Components
// ==========================================

// In AiSearchAgent.tsx:
// Change line ~186 from:
//   processClientSideFilter();
// To:
//   const availableCaregivers = await availabilityService.findAvailableCaregivers(
//     filteredCaregivers,
//     requestedDate,
//     requestedTime,
//     requestedDuration
//   );

// In SimpleSearchWizard.tsx:
// Change handleSearchWithPriorities to use:
//   const matches = await matchService.scoreCaregivers(
//     caregivers,
//     seniorProfile,
//     [],
//     {
//       requestedDate: new Date(), // or selected date
//       requestedTime: '09:00',    // or selected time
//       requestedDuration: 4       // or calculated from care type
//     }
//   );
