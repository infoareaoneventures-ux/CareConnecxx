"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFullTestScenario = exports.createTestMatchingData = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
/**
 * Cloud Function: Create Test Data for Matching System
 *
 * Call this function to populate Firestore with test data
 * for testing the care coordinator matching workflow.
 *
 * HTTP Endpoint: POST /createTestMatchingData
 */
exports.createTestMatchingData = functions.https.onRequest(async (req, res) => {
    // Enable CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }
    try {
        const db = admin.firestore();
        const batch = db.batch();
        // ==========================================
        // Create Test Caregivers
        // ==========================================
        const caregivers = [
            {
                id: "cg-001",
                uid: "caregiver-001",
                name: "Maria Garcia",
                email: "maria.g@test.com",
                phone: "+1-555-1001",
                bio: "5 years experience with dementia patients, bilingual Spanish/English",
                hourlyRate: 28,
                verified: true,
                skills: ["Dementia Care", "Meal Preparation", "Medication Management", "Bathing Assistance"],
                certifications: ["CNA", "CPR", "First Aid"],
                yearsExperience: 5,
                rating: 4.9,
                reviewCount: 24,
                location: "San Jose, CA",
                latitude: 37.3382,
                longitude: -121.8863,
                weeklyAvailability: {
                    monday: [{ start: "08:00", end: "18:00" }],
                    tuesday: [{ start: "08:00", end: "18:00" }],
                    wednesday: [{ start: "08:00", end: "18:00" }],
                    thursday: [{ start: "08:00", end: "18:00" }],
                    friday: [{ start: "08:00", end: "18:00" }],
                    saturday: [],
                    sunday: []
                },
                gender: "Female",
                backgroundCheckStatus: "clear",
                userType: "caregiver",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            },
            {
                id: "cg-002",
                uid: "caregiver-002",
                name: "John Davis",
                email: "john.d@test.com",
                phone: "+1-555-1002",
                bio: "Former nurse, specializes in mobility assistance and physical therapy support",
                hourlyRate: 32,
                verified: true,
                skills: ["Mobility Assistance", "Physical Therapy Support", "Meal Preparation", "Transportation"],
                certifications: ["RN", "CPR", "First Aid", "Driver's License"],
                yearsExperience: 8,
                rating: 4.8,
                reviewCount: 31,
                location: "San Jose, CA",
                latitude: 37.3541,
                longitude: -121.8552,
                weeklyAvailability: {
                    monday: [{ start: "09:00", end: "17:00" }],
                    tuesday: [{ start: "09:00", end: "17:00" }],
                    wednesday: [{ start: "09:00", end: "17:00" }],
                    thursday: [{ start: "09:00", end: "17:00" }],
                    friday: [{ start: "09:00", end: "17:00" }],
                    saturday: [{ start: "10:00", end: "14:00" }],
                    sunday: []
                },
                gender: "Male",
                backgroundCheckStatus: "clear",
                userType: "caregiver",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            },
            {
                id: "cg-003",
                uid: "caregiver-003",
                name: "Lisa Chen",
                email: "lisa.c@test.com",
                phone: "+1-555-1003",
                bio: "Compassionate caregiver with 3 years experience in senior care",
                hourlyRate: 26,
                verified: true,
                skills: ["Companionship", "Meal Preparation", "Light Housekeeping", "Medication Reminders"],
                certifications: ["CPR", "First Aid"],
                yearsExperience: 3,
                rating: 4.7,
                reviewCount: 15,
                location: "San Jose, CA",
                latitude: 37.3219,
                longitude: -121.9144,
                weeklyAvailability: {
                    monday: [{ start: "08:00", end: "20:00" }],
                    tuesday: [{ start: "08:00", end: "20:00" }],
                    wednesday: [{ start: "08:00", end: "20:00" }],
                    thursday: [{ start: "08:00", end: "20:00" }],
                    friday: [{ start: "08:00", end: "20:00" }],
                    saturday: [{ start: "08:00", end: "20:00" }],
                    sunday: [{ start: "08:00", end: "20:00" }]
                },
                gender: "Female",
                backgroundCheckStatus: "clear",
                userType: "caregiver",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            },
            {
                id: "cg-004",
                uid: "caregiver-004",
                name: "Robert Wilson",
                email: "rob.w@test.com",
                phone: "+1-555-1004",
                bio: "Retired paramedic, excellent with medical needs and emergency response",
                hourlyRate: 35,
                verified: true,
                skills: ["Medical Care", "Emergency Response", "Medication Management", "Wound Care"],
                certifications: ["Paramedic", "CPR", "First Aid", "EMT"],
                yearsExperience: 12,
                rating: 5.0,
                reviewCount: 18,
                location: "San Jose, CA",
                latitude: 37.3688,
                longitude: -121.9825,
                weeklyAvailability: {
                    monday: [{ start: "07:00", end: "15:00" }],
                    tuesday: [{ start: "07:00", end: "15:00" }],
                    wednesday: [{ start: "07:00", end: "15:00" }],
                    thursday: [{ start: "07:00", end: "15:00" }],
                    friday: [{ start: "07:00", end: "15:00" }],
                    saturday: [],
                    sunday: []
                },
                gender: "Male",
                backgroundCheckStatus: "clear",
                userType: "caregiver",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            },
            {
                id: "cg-005",
                uid: "caregiver-005",
                name: "Patricia Brown",
                email: "pat.b@test.com",
                phone: "+1-555-1005",
                bio: "Specializes in dementia and Alzheimer's care, very patient and gentle",
                hourlyRate: 30,
                verified: true,
                skills: ["Dementia Care", "Alzheimer's Care", "Personal Care", "Companionship"],
                certifications: ["CNA", "Dementia Care Specialist", "CPR", "First Aid"],
                yearsExperience: 6,
                rating: 4.9,
                reviewCount: 27,
                location: "San Jose, CA",
                latitude: 37.3019,
                longitude: -121.8486,
                weeklyAvailability: {
                    monday: [{ start: "09:00", end: "17:00" }],
                    tuesday: [{ start: "09:00", end: "17:00" }],
                    wednesday: [{ start: "09:00", end: "17:00" }],
                    thursday: [{ start: "09:00", end: "17:00" }],
                    friday: [{ start: "09:00", end: "17:00" }],
                    saturday: [],
                    sunday: []
                },
                gender: "Female",
                backgroundCheckStatus: "clear",
                userType: "caregiver",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            }
        ];
        for (const cg of caregivers) {
            const ref = db.collection('caregivers').doc(cg.id);
            batch.set(ref, cg);
        }
        // ==========================================
        // Create Test Client User
        // ==========================================
        const testClientId = "test-client-001";
        const clientRef = db.collection('users').doc(testClientId);
        batch.set(clientRef, {
            uid: testClientId,
            email: "sarah.johnson@test.com",
            displayName: "Sarah Johnson",
            phone: "+1-555-0123",
            userType: "client",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            isVerified: true
        });
        // ==========================================
        // Create Test Intake
        // ==========================================
        const intakeRef = db.collection('clientIntakes').doc();
        batch.set(intakeRef, {
            userId: testClientId,
            contactName: "Sarah Johnson",
            email: "sarah.johnson@test.com",
            phone: "+1-555-0123",
            recipientName: "Mary Johnson",
            relationship: "daughter",
            careTypes: ["dementia_care", "meal_prep", "mobility_assistance", "medication_reminders"],
            streetAddress: "123 Test Street",
            city: "San Jose",
            state: "CA",
            zipCode: "95110",
            schedule: "Mon-Fri 9am-5pm",
            startDate: "2026-04-01",
            duration: "ongoing",
            additionalComments: "Mother has early-stage dementia, needs patient caregiver with experience.",
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await batch.commit();
        res.json({
            success: true,
            message: "Test data created successfully",
            data: {
                caregiversCreated: caregivers.length,
                clientId: testClientId,
                intakeId: intakeRef.id,
                nextSteps: [
                    "Check Firestore for new intake document (should trigger onIntakeCompleted)",
                    "Go to Admin Dashboard > Matching tab to see match assignment",
                    "Or manually create match assignment if cloud function hasn't run"
                ]
            }
        });
    }
    catch (error) {
        console.error('Error creating test data:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
/**
 * Cloud Function: Create Full Test Scenario
 *
 * Creates complete test data from intake through hire request
 * Call: POST /createFullTestScenario
 */
exports.createFullTestScenario = functions.https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }
    try {
        const db = admin.firestore();
        const testClientId = "test-client-001";
        const now = admin.firestore.FieldValue.serverTimestamp();
        // Create caregivers if they don't exist
        const caregivers = [
            { id: "cg-001", name: "Maria Garcia", rate: 28 },
            { id: "cg-002", name: "John Davis", rate: 32 },
            { id: "cg-003", name: "Lisa Chen", rate: 26 },
            { id: "cg-004", name: "Robert Wilson", rate: 35 },
            { id: "cg-005", name: "Patricia Brown", rate: 30 }
        ];
        for (const cg of caregivers) {
            const ref = db.collection('caregivers').doc(cg.id);
            const doc = await ref.get();
            if (!doc.exists) {
                await ref.set({
                    id: cg.id,
                    uid: `caregiver-${cg.id.split('-')[1]}`,
                    name: cg.name,
                    hourlyRate: cg.rate,
                    verified: true,
                    userType: "caregiver",
                    createdAt: now
                });
            }
        }
        // Create match assignment with 5 AI suggestions
        const matchAssignmentRef = db.collection('match_assignments').doc("ma-test-001");
        await matchAssignmentRef.set({
            id: "ma-test-001",
            clientId: testClientId,
            seniorId: testClientId,
            coordinatorId: null,
            status: "matches_ready",
            aiSuggestedMatches: [
                {
                    caregiverId: "cg-001",
                    caregiverName: "Maria Garcia",
                    matchScore: 94,
                    ranking: 1,
                    reasoning: ["5 years dementia experience", "Bilingual Spanish/English", "Available Mon-Fri 9-5"],
                    predictiveFactors: { successProbability: 92, acceptanceLikelihood: 88, retentionProbability: 90 },
                    availabilityMatch: { score: 95, overlappingHours: ["Mon-Fri 9am-5pm"] },
                    redFlags: []
                },
                {
                    caregiverId: "cg-005",
                    caregiverName: "Patricia Brown",
                    matchScore: 91,
                    ranking: 2,
                    reasoning: ["Dementia Care Specialist", "6 years experience", "Excellent reviews"],
                    predictiveFactors: { successProbability: 89, acceptanceLikelihood: 85, retentionProbability: 92 },
                    availabilityMatch: { score: 90, overlappingHours: ["Mon-Fri 9am-5pm"] },
                    redFlags: []
                },
                {
                    caregiverId: "cg-002",
                    caregiverName: "John Davis",
                    matchScore: 87,
                    ranking: 3,
                    reasoning: ["Former RN", "Medical expertise", "8 years experience"],
                    predictiveFactors: { successProbability: 85, acceptanceLikelihood: 82, retentionProbability: 88 },
                    availabilityMatch: { score: 85, overlappingHours: ["Mon-Fri 9am-5pm"] },
                    redFlags: ["Higher rate ($32)"]
                },
                {
                    caregiverId: "cg-004",
                    caregiverName: "Robert Wilson",
                    matchScore: 84,
                    ranking: 4,
                    reasoning: ["Retired paramedic", "Emergency response", "5.0 rating"],
                    predictiveFactors: { successProbability: 83, acceptanceLikelihood: 78, retentionProbability: 85 },
                    availabilityMatch: { score: 75, overlappingHours: ["Mon-Fri 9am-3pm"] },
                    redFlags: ["Limited availability", "Higher rate ($35)"]
                },
                {
                    caregiverId: "cg-003",
                    caregiverName: "Lisa Chen",
                    matchScore: 79,
                    ranking: 5,
                    reasoning: ["Flexible schedule", "Reliable", "Good value"],
                    predictiveFactors: { successProbability: 78, acceptanceLikelihood: 90, retentionProbability: 82 },
                    availabilityMatch: { score: 95, overlappingHours: ["Mon-Fri 9am-5pm"] },
                    redFlags: ["Less dementia experience"]
                }
            ],
            approvedMatches: [
                { caregiverId: "cg-001", caregiverName: "Maria Garcia", approvedAt: new Date().toISOString(), approvedBy: "coordinator-001", coordinatorNotes: "Excellent dementia experience, speaks Spanish", priority: 1, status: "pre_confirmed" },
                { caregiverId: "cg-005", caregiverName: "Patricia Brown", approvedAt: new Date().toISOString(), approvedBy: "coordinator-001", coordinatorNotes: "Dementia Care Specialist", priority: 2, status: "pre_confirmed" },
                { caregiverId: "cg-002", caregiverName: "John Davis", approvedAt: new Date().toISOString(), approvedBy: "coordinator-001", coordinatorNotes: "Former RN, medical background", priority: 3, status: "pre_confirmed" },
                { caregiverId: "cg-004", caregiverName: "Robert Wilson", approvedAt: new Date().toISOString(), approvedBy: "coordinator-001", coordinatorNotes: "Retired paramedic", priority: 4, status: "pre_confirmed" },
                { caregiverId: "cg-003", caregiverName: "Lisa Chen", approvedAt: new Date().toISOString(), approvedBy: "coordinator-001", coordinatorNotes: "Flexible, reliable backup", priority: 5, status: "pre_confirmed" }
            ],
            rejectedMatches: [],
            careNeeds: [
                { category: "cognitive", description: "Dementia care and memory support", frequency: "daily", priority: "required" },
                { category: "personal_care", description: "Bathing, dressing, grooming", frequency: "daily", priority: "required" },
                { category: "household", description: "Meal prep and light housekeeping", frequency: "daily", priority: "preferred" },
                { category: "medical", description: "Medication reminders", frequency: "daily", priority: "required" }
            ],
            priority: "high",
            notes: "Client needs caregiver with dementia experience. Prefers female caregiver but open to male candidates.",
            createdAt: now,
            sentToClientAt: now
        });
        // Add approved matches to client's subcollection
        for (let i = 0; i < caregivers.length; i++) {
            const cg = caregivers[i];
            const ref = db.collection('users').doc(testClientId).collection('approved_matches').doc();
            await ref.set({
                caregiverId: cg.id,
                caregiverName: cg.name,
                approvedAt: new Date().toISOString(),
                coordinatorNotes: `Test match ${i + 1}`,
                priority: i + 1,
                status: "pre_confirmed",
                assignmentId: "ma-test-001"
            });
        }
        res.json({
            success: true,
            message: "Full test scenario created",
            data: {
                matchAssignmentId: "ma-test-001",
                clientId: testClientId,
                caregivers: caregivers.map(c => c.name),
                testSteps: [
                    "1. Go to https://careconnex-d4c8b.web.app",
                    "2. Log in as admin - check Matching tab for match assignment",
                    "3. Log in as client (test-client-001) - see 5 matches on dashboard",
                    "4. Test interview request flow",
                    "5. Test hire request flow"
                ]
            }
        });
    }
    catch (error) {
        console.error('Error creating test scenario:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});
//# sourceMappingURL=testData.js.map