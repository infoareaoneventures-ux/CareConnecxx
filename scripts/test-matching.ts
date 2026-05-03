
import { matchService } from '../services/matchService';
import { Caregiver, Senior, MatchFeedback } from '../types';

// Mock Data
const seniorWithDementia: Senior = {
    id: 1,
    name: "Martha",
    age: 80,
    needs: ["Dementia Care"],
    personality: "Introvert",
    location: "90210",
    scheduleNeeded: ["Monday Morning"],
    genderPreference: "Female",
    familyMembers: []
};

const caregiverQualified: Caregiver = {
    id: 101,
    name: "Nurse Sarah",
    imageUrl: "",
    hourlyRate: 30,
    verified: true,
    instantPayAvailable: true,
    personalityTags: ["Patient", "Calm"],
    matchScore: 0,
    rating: 5,
    distance: 2,
    availability: ["Monday Morning", "Tuesday Afternoon"],
    medicalSkills: ["Dementia Care", "CPR"],
    reliabilityScore: 95,
    experience: 5
};

const caregiverUnqualified: Caregiver = {
    id: 102,
    name: "Newbie Dave",
    imageUrl: "",
    hourlyRate: 20,
    verified: false,
    instantPayAvailable: false,
    personalityTags: ["High Energy", "Chatty"],
    matchScore: 0,
    rating: 3,
    distance: 10,
    availability: ["Friday Night"],
    medicalSkills: [],
    reliabilityScore: 70,
    experience: 1
};

const feedbackHistory: MatchFeedback[] = [];

// Test Function
const runTest = () => {
    console.log("--- Running Matching Algorithm Test ---");

    const score1 = matchService.scoreCaregiver(caregiverQualified, seniorWithDementia, feedbackHistory);
    const score2 = matchService.scoreCaregiver(caregiverUnqualified, seniorWithDementia, feedbackHistory);

    if (!score1 || !score2) {
        console.error("Error: Scoring returned null");
        return;
    }

    console.log(`Qualified Caregiver Score: ${score1.matchScore}`);
    console.log(`Reasoning: ${score1.matchReasoning}`);
    console.log(`Flags: ${score1.matchFlags?.join(", ")}`);

    console.log(`\nUnqualified Caregiver Score: ${score2.matchScore}`);
    console.log(`Reasoning: ${score2.matchReasoning}`);
    console.log(`Flags: ${score2.matchFlags?.join(", ")}`);

    if (score1.matchScore > score2.matchScore) {
        console.log("\n✅ SUCCESS: Qualified caregiver scored higher.");
    } else {
        console.error("\n❌ FAILURE: Logic flaw detected.");
    }
};

runTest();
