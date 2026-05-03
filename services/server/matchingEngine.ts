/**
 * SIMULATED SERVER-SIDE MATCHING ENGINE
 * 
 * In a real production app, this code would run in a Cloud Function (Node.js/Python).
 * It would access the Firestore Admin SDK to query users without exposing the entire DB to the client.
 * 
 * Security Benefit:
 * - Clients never see the full list of caregivers.
 * - Matching algorithms are hidden from the frontend.
 * - Personal identifying information (PII) is filtered before response.
 */

import { Caregiver, Senior } from '../../types';

// We import the same logic, but conceptually this runs 'on the server'
// In a real migration, we'd copy the logic from matchService.ts here and delete the client-side one.
import { matchService } from '../matchService';

// Mock Database Access (Simulating Admin SDK)
// In real life: import * as admin from 'firebase-admin';
import { dbService } from '../api';

export const matchingEngine = {
    /**
     * Securely finds matches for a senior profile.
     * @param seniorProfile The senior's requirements
     * @param limit Max number of matches to return
     * @returns List of Caregivers with PII stripped and match scores attached
     */
    async findMatches(seniorProfile: Senior, limit: number = 10): Promise<Caregiver[]> {
        console.log(`[SERVER] Processing matches for senior: ${seniorProfile.name} (${seniorProfile.id})`);

        // 1. Fetch ALL caregivers (Server-side only operation)
        // In a real app, we'd use geospatial queries to only fetch nearby ones first.
        const { caregivers: allCandidates } = await dbService.getCaregivers(1000); // 1000 is our "server" limit

        // 2. Run Scoring Algorithm
        const scoredCandidatesPromises = allCandidates.map(async caregiver => {
            // Pass empty array for feedback history in this simulation, or fetch it if possible
            const scored = await matchService.scoreCaregiver(caregiver, seniorProfile, []);

            if (!scored) return null;

            return scored;
        });
        
        const scoredCandidates = (await Promise.all(scoredCandidatesPromises)).filter(c => c !== null) as Caregiver[];

        // 3. Filter & Sort
        const bestMatches = scoredCandidates
            .filter(c => c.matchScore > 60) // Threshold filter
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, limit);

        // 4. Sanitize Data (Strip PII)
        // We remove sensitive fields that the client shouldn't see for non-booked caregivers
        const sanitizedMatches = bestMatches.map(c => ({
            ...c,
            contactEmail: undefined, // Hidden
            phoneNumber: undefined,   // Hidden
            exactAddress: undefined,  // Hidden
            stripeAccountId: undefined // Hidden
        }));

        console.log(`[SERVER] Found ${sanitizedMatches.length} matches.`);
        return sanitizedMatches;
    }
};
