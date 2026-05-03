import { aiService } from '../services/ai.js';

console.log('🧪 Testing AI Service...\n');

// Mock caregiver data for testing
const mockCaregivers = [
    {
        id: 'test-1',
        name: 'Sarah Johnson',
        hourlyRate: 30,
        rating: 4.9,
        distance: 2.5,
        verified: true,
        personalityTags: ['Patient', 'Friendly'],
        medicalSkills: ['Driver', 'CPR Certified'],
        certifications: ['CNA'],
        availability: ['Monday', 'Tuesday', 'Wednesday']
    },
    {
        id: 'test-2',
        name: 'Maria Garcia',
        hourlyRate: 28,
        rating: 4.7,
        distance: 5.0,
        verified: true,
        personalityTags: ['Compassionate', 'Bilingual'],
        medicalSkills: ['Meal Preparation', 'Dementia Care'],
        certifications: [],
        availability: ['Monday', 'Wednesday', 'Friday']
    }
];

async function testAI() {
    try {
        console.log('📝 Test 1: Search Caregivers');
        console.log('Query: "I need a driver for my mom"\n');

        const result = await aiService.searchCaregivers(
            "I need a driver for my mom",
            mockCaregivers
        );

        console.log('✅ SUCCESS! AI Response:');
        console.log(JSON.stringify(result, null, 2));
        console.log('\n');

        console.log('📝 Test 2: Generate Shift Note');
        const note = await aiService.generateShiftNote(
            "Patient ate breakfast, took meds, walked around the block"
        );

        console.log('✅ SUCCESS! Generated Note:');
        console.log(note);
        console.log('\n');

        console.log('🎉 All tests passed! AI service is working correctly.');

    } catch (error) {
        console.error('❌ ERROR:', error);
        console.error('\nFull error details:', error);

        if (error.message?.includes('API key')) {
            console.error('\n⚠️  API KEY ISSUE: The Gemini API key may be invalid or missing.');
        } else if (error.message?.includes('quota')) {
            console.error('\n⚠️  QUOTA EXCEEDED: You may have hit the API rate limit.');
        } else if (error.message?.includes('model')) {
            console.error('\n⚠️  MODEL ISSUE: The model name may be incorrect or unavailable.');
        } else {
            console.error('\n⚠️  UNKNOWN ERROR: Check the error details above.');
        }
    }
}

testAI();
