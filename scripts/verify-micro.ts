
import { matchService } from '../services/matchService';
import { Caregiver, Senior, MatchFeedback } from '../types';

console.log("Starting Micro-Shift Verification...");

const mockCaregiver: Caregiver = {
    id: '1',
    uid: 'c1',
    name: 'Test Caregiver',
    hourlyRate: 25,
    verified: true,
    distance: 2, // Nearby < 5 miles
    latitude: 34.05,
    longitude: -118.25,
    personalityTags: [],
    matchScore: 0,
    instantPayAvailable: false,
    availability: [], // Legacy
    matchFlags: [],
    acceptsMicroVisits: true
};

const mockSenior: Senior = {
    id: 1,
    name: 'Test Senior',
    age: 80,
    needs: [],
    personality: 'Ambivert',
    location: 'Downtown',
    latitude: 34.05,
    longitude: -118.25 // Exact same location essentially
};

const history: MatchFeedback[] = [];

// Test 1: Normal Hourly Match
const scoreHourly = matchService.scoreCaregiver({ ...mockCaregiver }, mockSenior, history);
console.log(`Hourly Match Score (Dist < 5): ${scoreHourly?.matchScore}`);
console.log(`Reasons: ${scoreHourly?.matchReasoning}`);

// Test 2: Micro-Visit Match
const scoreMicro = matchService.scoreCaregiver({ ...mockCaregiver }, mockSenior, history, { isMicroVisit: true });
console.log(`Micro Match Score (Dist < 5): ${scoreMicro?.matchScore}`);
console.log(`Reasons: ${scoreMicro?.matchReasoning}`);

if ((scoreMicro?.matchScore || 0) > (scoreHourly?.matchScore || 0)) {
    console.log("SUCCESS: Micro-Visit match boosted correctly.");
} else {
    console.error("FAILURE: Micro-Visit match was NOT boosted.");
}

// Test 3: Far Distance Penalty
const mockFarCaregiver = { ...mockCaregiver, distance: 20, latitude: 34.2, longitude: -118.2 }; // > 15 miles
// Re-calc distance manually or mock it? service calculates it.
// We'll trust the input distance if lat/lng are missing or service logic.
// Logic: if (lat && lng ... ) distance = calc(). 
// Check service: 
// if (seniorProfile.latitude && seniorProfile.longitude && caregiver.latitude && caregiver.longitude) {
//     distance = calculateDistance(...);
//     caregiver.distance = distance; 
// }
// So we need to provide lat/lng that gives distance.

// Let's just check the logic branch with a mocked distance and NO lat/lng to force using input distance?
// No, the service overwrites it if lat/lng exist. So removing lat/lng from mock.
const mockFarCaregiverNoGeo = { ...mockCaregiver, distance: 20, latitude: undefined, longitude: undefined };

const scoreFarMicro = matchService.scoreCaregiver(mockFarCaregiverNoGeo as any, mockSenior, history, { isMicroVisit: true });
console.log(`Far Micro Match Score (Dist 20): ${scoreFarMicro?.matchScore}`);
if (scoreFarMicro?.matchFlags?.includes("Far for a short visit")) {
    console.log("SUCCESS: Far Micro-Visit flagged correctly.");
} else {
    console.error("FAILURE: Far Micro-Visit NOT flagged.");
}
