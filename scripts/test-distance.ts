
import { matchService } from '../services/matchService';
import { Caregiver, Senior } from '../types';

// Coordinates
// Point A: New York, NY (40.7128, -74.0060)
// Point B: Jersey City, NJ (40.7178, -74.0431) -> Approx 2 miles
// Point C: Philadelphia, PA (39.9526, -75.1652) -> Approx 80 miles

const seniorNY: Senior = {
    id: 1,
    name: "Senior NY",
    age: 80,
    needs: [],
    personality: "Introvert",
    location: "New York, NY",
    latitude: 40.7128,
    longitude: -74.0060,
    scheduleNeeded: []
};

const caregiverJersey: Caregiver = {
    id: 101,
    name: "Jersey Caregiver",
    imageUrl: "",
    hourlyRate: 30,
    verified: true,
    instantPayAvailable: false,
    personalityTags: [],
    matchScore: 0,
    rating: 5,
    distance: 0, // Should be recalculated
    latitude: 40.7178,
    longitude: -74.0431,
    availability: [],
    medicalSkills: [],
    reliabilityScore: 100
};

const caregiverPhilly: Caregiver = {
    id: 102,
    name: "Philly Caregiver",
    imageUrl: "",
    hourlyRate: 30,
    verified: true,
    instantPayAvailable: false,
    personalityTags: [],
    matchScore: 0,
    rating: 5,
    distance: 0, // Should be recalculated
    latitude: 39.9526,
    longitude: -75.1652,
    availability: [],
    medicalSkills: [],
    reliabilityScore: 100
};

const runTest = () => {
    console.log("--- Geolocation Test ---");

    // Test 1: Close Match
    const match1 = matchService.scoreCaregiver(caregiverJersey, seniorNY, []);

    if (match1) {
        console.log(`\nMatch 1 (NY -> Jersey)`);
        console.log(`Calculated Distance: ${match1.distance} miles`);
        console.log(`Score: ${match1.matchScore}`);
        console.log(`Reasoning: ${match1.matchReasoning}`);

        if (match1.distance < 5 && match1.matchScore >= 40) {
            console.log("✅ SUCCESS: Close distance calculated correctly and scored appropriately.");
        } else {
            console.log("❌ FAILURE: Distance or score incorrect for close match.");
        }
    } else {
        console.log("❌ FAILURE: Close match returned null.");
    }

    // Test 2: Far Match (Should be filtered out > 30 miles)
    const match2 = matchService.scoreCaregiver(caregiverPhilly, seniorNY, []);

    if (match2 === null) {
        console.log("\nMatch 2 (NY -> Philly)");
        console.log("✅ SUCCESS: Remote caregiver filtered out (Distance > 30 miles).");
    } else {
        console.log("\nMatch 2 (NY -> Philly)");
        console.log(`❌ FAILURE: Remote caregiver NOT filtered. Distance: ${match2.distance}`);
    }
};

runTest();
