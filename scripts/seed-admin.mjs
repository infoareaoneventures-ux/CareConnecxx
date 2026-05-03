import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin
const app = initializeApp({
  projectId: 'careconnex-d4c8b'
});

const db = getFirestore();

// Sample data
const FIRST_NAMES = ['Maria', 'John', 'Sarah', 'David', 'Lisa', 'Michael', 'Jennifer', 'Robert', 'Emily', 'James', 'Emma', 'William'];
const LAST_NAMES = ['Garcia', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
const SKILLS_POOL = ['Driving', 'Meal Preparation', 'Medication Management', 'Dementia Care', 'Mobility Assistance', 'Bathing', 'Companionship', 'Exercise Support'];
const CERTIFICATIONS_POOL = ['CPR', 'First Aid', 'CNA', 'LVN', 'RN', 'HHA'];
const LOCATIONS = [
  { city: 'Los Angeles', zip: '90210', lat: 34.0901, lng: -118.4065 },
  { city: 'Santa Monica', zip: '90401', lat: 34.0195, lng: -118.4912 },
  { city: 'Beverly Hills', zip: '90210', lat: 34.0736, lng: -118.4004 },
  { city: 'Pasadena', zip: '91101', lat: 34.1478, lng: -118.1445 },
];

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomItems(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

const SEED_DATA_FLAG = { _seedData: true, seededAt: new Date().toISOString() };

async function seedDatabase() {
  console.log('🌱 Starting database seeding...\n');
  
  try {
    // 1. Create Caregivers
    console.log('Creating 12 caregivers...');
    for (let i = 0; i < 12; i++) {
      const firstName = getRandomItem(FIRST_NAMES);
      const lastName = getRandomItem(LAST_NAMES);
      const location = getRandomItem(LOCATIONS);
      const experience = Math.floor(Math.random() * 15) + 1;
      const caregiverId = `caregiver_seed_${i}`;
      
      const caregiver = {
        id: caregiverId,
        uid: caregiverId,
        name: `${firstName} ${lastName}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
        phone: `555-${String(Math.floor(Math.random() * 8999) + 1000).padStart(4, '0')}`,
        bio: `Experienced caregiver with ${experience} years of experience providing compassionate care for seniors.`,
        hourlyRate: Math.floor(Math.random() * 20) + 20,
        verified: true,
        verificationStatus: 'approved',
        onboardingStatus: 'complete',
        backgroundCheckStatus: 'clear',
        skills: getRandomItems(SKILLS_POOL, Math.floor(Math.random() * 5) + 3),
        certifications: getRandomItems(CERTIFICATIONS_POOL, Math.floor(Math.random() * 3) + 1),
        gender: getRandomItem(['Male', 'Female', 'Non-binary', 'Prefer not to say']),
        instantPayAvailable: Math.random() > 0.3,
        personalityTags: getRandomItems(['Patient', 'Punctual', 'Friendly', 'Professional', 'Experienced'], 3),
        matchScore: Math.floor(Math.random() * 30) + 70,
        rating: Math.round((3.5 + Math.random() * 1.5) * 10) / 10,
        reviewCount: Math.floor(Math.random() * 50) + 5,
        distance: Math.round(Math.random() * 20 * 10) / 10,
        availability: ['Monday', 'Wednesday', 'Friday'],
        latitude: location.lat + (Math.random() - 0.5) * 0.1,
        longitude: location.lng + (Math.random() - 0.5) * 0.1,
        location: `${location.city}, CA ${location.zip}`,
        userType: 'caregiver',
        totalEarnings: Math.floor(Math.random() * 50000) + 5000,
        completedJobs: Math.floor(Math.random() * 100) + 10,
        experience,
        hasTransportation: Math.random() > 0.2,
        isSmoker: Math.random() > 0.9,
        reliabilityScore: Math.floor(Math.random() * 20) + 80,
        acceptsMicroVisits: Math.random() > 0.5,
        ...SEED_DATA_FLAG,
      };
      
      await db.collection('caregivers').doc(caregiverId).set(caregiver);
      process.stdout.write(`  ✓ ${caregiver.name}\n`);
    }
    
    // 2. Create Clients
    console.log('\nCreating 6 clients...');
    const clientIds = [];
    for (let i = 0; i < 6; i++) {
      const firstName = getRandomItem(FIRST_NAMES);
      const lastName = getRandomItem(LAST_NAMES);
      const location = getRandomItem(LOCATIONS);
      const age = Math.floor(Math.random() * 25) + 65;
      const clientId = `client_seed_${i}`;
      clientIds.push(clientId);
      
      const userData = {
        uid: clientId,
        name: `${firstName} ${lastName}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
        userType: 'client',
        createdAt: new Date(Date.now() - Math.random() * 10000000000).toISOString(),
        isBanned: false,
        verified: true,
        zipCode: location.zip,
        location: `${location.city}, CA ${location.zip}`,
        latitude: location.lat + (Math.random() - 0.5) * 0.05,
        longitude: location.lng + (Math.random() - 0.5) * 0.05,
        ...SEED_DATA_FLAG,
      };
      
      const seniorProfile = {
        id: i,
        uid: clientId,
        name: `${firstName} ${lastName}`,
        age,
        needs: getRandomItems(['Mobility Assistance', 'Medication Reminders', 'Meal Preparation', 'Companionship', 'Dementia Care'], Math.floor(Math.random() * 4) + 2),
        personality: getRandomItem(['Introvert', 'Extrovert', 'Ambivert']),
        location: `${location.city}, CA`,
        zipCode: location.zip,
        latitude: userData.latitude,
        longitude: userData.longitude,
        phone: `555-${String(Math.floor(Math.random() * 8999) + 1000).padStart(4, '0')}`,
        scheduleNeeded: getRandomItems(['Morning', 'Afternoon', 'Evening', 'Weekends'], Math.floor(Math.random() * 3) + 1),
        genderPreference: getRandomItem(['Female', 'Male', 'No Preference']),
        excludedTags: [],
        familyMembers: [{
          id: `family_${i}`,
          name: getRandomItem(FIRST_NAMES) + ' ' + lastName,
          email: `family${i}@example.com`,
          role: 'admin',
          status: 'active'
        }]
      };
      
      await db.collection('users').doc(clientId).set(userData);
      await db.collection('senior_profiles').doc(clientId).set(seniorProfile);
      process.stdout.write(`  ✓ ${userData.name}\n`);
    }
    
    // 3. Create Job Posts
    console.log('\nCreating 10 job posts...');
    const jobTitles = ['Part-time Caregiver Needed', 'Weekend Companion Care', 'Overnight Care Specialist', 'Dementia Care Expert', 'Live-in Caregiver'];
    for (let i = 0; i < 10; i++) {
      const clientId = getRandomItem(clientIds);
      const location = getRandomItem(LOCATIONS);
      const date = new Date();
      date.setDate(date.getDate() + Math.floor(Math.random() * 30) + 1);
      const jobId = `job_seed_${i}`;
      
      const jobPost = {
        id: jobId,
        clientId,
        clientName: 'Client Name',
        title: getRandomItem(jobTitles),
        description: `Looking for a compassionate caregiver to assist with daily activities.`,
        rate: Math.floor(Math.random() * 15) + 25,
        date: date.toISOString().split('T')[0],
        startTime: `${Math.floor(Math.random() * 4) + 8}:00 AM`,
        endTime: `${Math.floor(Math.random() * 4) + 2}:00 PM`,
        location: `${location.city}, CA ${location.zip}`,
        distance: Math.round(Math.random() * 15 * 10) / 10,
        requirements: getRandomItems(SKILLS_POOL, Math.floor(Math.random() * 3) + 1),
        status: 'open',
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        ...SEED_DATA_FLAG,
      };
      
      await db.collection('job_posts').doc(jobId).set(jobPost);
      process.stdout.write(`  ✓ ${jobPost.title}\n`);
    }
    
    // 4. Create Appointments
    console.log('\nCreating 20 appointments...');
    const caregiverIds = Array.from({length: 12}, (_, i) => `caregiver_seed_${i}`);
    for (let i = 0; i < 20; i++) {
      const caregiverId = getRandomItem(caregiverIds);
      const clientId = getRandomItem(clientIds);
      const date = new Date();
      const isPast = Math.random() > 0.5;
      date.setDate(date.getDate() + (isPast ? -Math.floor(Math.random() * 30) : Math.floor(Math.random() * 30)));
      const status = isPast ? getRandomItem(['completed', 'cancelled']) : 'scheduled';
      
      const appointment = {
        id: `appointment_seed_${i}`,
        caregiverId,
        caregiverName: 'Caregiver Name',
        clientId,
        clientName: 'Client Name',
        date: date.toISOString().split('T')[0],
        isoDate: date.toISOString().split('T')[0],
        startTime: `${Math.floor(Math.random() * 4) + 8}:00 AM`,
        endTime: `${Math.floor(Math.random() * 4) + 12}:00 PM`,
        status,
        address: getRandomItem(LOCATIONS).zip,
        totalCost: Math.floor(Math.random() * 150) + 100,
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        paymentStatus: status === 'completed' ? 'paid' : 'pending',
        notes: 'Regular care visit.',
        ...SEED_DATA_FLAG,
      };
      
      await db.collection('appointments').doc(appointment.id).set(appointment);
      process.stdout.write(`  ✓ Appointment ${i + 1}\n`);
    }
    
    // 5. Create Reviews
    console.log('\nCreating 25 reviews...');
    const reviewComments = [
      'Amazing caregiver! Very patient and kind.',
      'Professional and always on time. Highly recommend!',
      'Great communication and really cares.',
      'Went above and beyond expectations.',
      'Very knowledgeable about dementia care.',
    ];
    
    for (let i = 0; i < 25; i++) {
      const caregiverId = getRandomItem(caregiverIds);
      const clientId = getRandomItem(clientIds);
      
      const review = {
        id: `review_seed_${i}`,
        caregiverId,
        clientId,
        clientName: 'Client Name',
        appointmentId: `appointment_seed_${i}`,
        ratings: {
          overall: Math.floor(Math.random() * 2) + 4,
          punctuality: Math.floor(Math.random() * 3) + 3,
          professionalism: Math.floor(Math.random() * 2) + 4,
          communication: Math.floor(Math.random() * 2) + 4,
          careQuality: Math.floor(Math.random() * 2) + 4,
        },
        comment: getRandomItem(reviewComments),
        wouldRecommend: Math.random() > 0.1,
        wouldRehire: Math.random() > 0.15,
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        helpful: Math.floor(Math.random() * 20),
        ...SEED_DATA_FLAG,
      };
      
      await db.collection('reviews').doc(review.id).set(review);
      process.stdout.write(`  ✓ Review ${i + 1}\n`);
    }
    
    // 6. Create Support Tickets
    console.log('\nCreating 8 support tickets...');
    const subjects = [
      'Issue with payment processing',
      'Need to update availability',
      'Question about background check',
      'App not showing notifications',
    ];
    
    for (let i = 0; i < 8; i++) {
      const isClient = Math.random() > 0.5;
      const userId = isClient ? getRandomItem(clientIds) : getRandomItem(caregiverIds);
      
      const ticket = {
        id: `ticket_seed_${i}`,
        userId,
        userName: 'User Name',
        userType: isClient ? 'client' : 'caregiver',
        subject: getRandomItem(subjects),
        description: 'User reported this issue via the support form.',
        status: getRandomItem(['open', 'in_progress', 'resolved']),
        priority: getRandomItem(['low', 'medium', 'high']),
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        updatedAt: new Date().toISOString(),
        responses: [],
        ...SEED_DATA_FLAG,
      };
      
      await db.collection('support_tickets').doc(ticket.id).set(ticket);
      process.stdout.write(`  ✓ Ticket ${i + 1}\n`);
    }
    
    // 7. Create Notifications
    console.log('\nCreating 15 notifications...');
    const types = ['booking', 'message', 'alert', 'system'];
    const titles = {
      booking: 'New Booking Confirmed',
      message: 'New Message Received',
      alert: 'Important Alert',
      system: 'System Update'
    };
    const messages = {
      booking: 'Your appointment has been confirmed for tomorrow.',
      message: 'You have a new message from a client.',
      alert: 'Please update your availability for next week.',
      system: 'Your profile has been verified successfully.'
    };
    
    for (let i = 0; i < 15; i++) {
      const type = getRandomItem(types);
      const userId = Math.random() > 0.5 ? getRandomItem(clientIds) : getRandomItem(caregiverIds);
      
      const notification = {
        id: `notification_seed_${i}`,
        userId,
        type,
        title: titles[type],
        message: messages[type],
        read: Math.random() > 0.5,
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        ...SEED_DATA_FLAG,
      };
      
      await db.collection('notifications').doc(notification.id).set(notification);
      process.stdout.write(`  ✓ Notification ${i + 1}\n`);
    }
    
    console.log('\n✅ Database seeding completed successfully!');
    console.log('\n📊 Summary:');
    console.log('  • 12 Caregivers');
    console.log('  • 6 Clients');
    console.log('  • 10 Job Posts');
    console.log('  • 20 Appointments');
    console.log('  • 25 Reviews');
    console.log('  • 8 Support Tickets');
    console.log('  • 15 Notifications');
    console.log('\n🎉 Platform is ready for testing!');
    
  } catch (error) {
    console.error('\n❌ Error seeding database:', error);
    process.exit(1);
  }
}

seedDatabase();
