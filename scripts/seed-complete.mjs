// Complete seed script - run this to populate Firebase with ALL dummy data
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyACFOXqqz1Q0PK3_ROJr1lQNncFCoInwy4",
  authDomain: "careconnex-d4c8b.firebaseapp.com",
  projectId: "careconnex-d4c8b",
  storageBucket: "careconnex-d4c8b.firebasestorage.app",
  messagingSenderId: "688697288776",
  appId: "1:688697288776:web:771c1b479ee21521d6107d"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Sample data pools
const FIRST_NAMES = ['Maria', 'John', 'Sarah', 'David', 'Lisa', 'Michael', 'Jennifer', 'Robert', 'Emily', 'James', 'Emma', 'William', 'Olivia', 'Joseph', 'Sophia', 'Thomas', 'Isabella', 'Charles', 'Mia', 'Daniel'];
const LAST_NAMES = ['Garcia', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];
const SKILLS_POOL = ['Driving', 'Meal Preparation', 'Medication Management', 'Dementia Care', 'Mobility Assistance', 'Bathing', 'Grooming', 'Companionship', 'Exercise Support', 'Housekeeping', 'Laundry', 'Grocery Shopping', 'Pet Care', 'Wound Care', 'CPR Certified', 'First Aid'];
const CERTIFICATIONS_POOL = ['CPR', 'First Aid', 'CNA', 'LVN', 'RN', 'HHA', 'PCA', 'Dementia Specialist', 'Medication Aide'];
const LOCATIONS = [
  { city: 'Los Angeles', zip: '90210', lat: 34.0901, lng: -118.4065 },
  { city: 'Santa Monica', zip: '90401', lat: 34.0195, lng: -118.4912 },
  { city: 'Beverly Hills', zip: '90210', lat: 34.0736, lng: -118.4004 },
  { city: 'Pasadena', zip: '91101', lat: 34.1478, lng: -118.1445 },
  { city: 'Glendale', zip: '91201', lat: 34.1425, lng: -118.2551 },
  { city: 'Long Beach', zip: '90802', lat: 33.7701, lng: -118.1937 },
  { city: 'Torrance', zip: '90501', lat: 33.8358, lng: -118.3406 },
  { city: 'Anaheim', zip: '92801', lat: 33.8366, lng: -117.9143 },
];
const PERSONALITY_TAGS = ['Patient', 'Punctual', 'Friendly', 'Professional', 'Experienced', 'Caring', 'Detail-oriented', 'Reliable', 'Compassionate', 'Energetic'];
const SENIOR_NEEDS = ['Mobility Assistance', 'Medication Reminders', 'Meal Preparation', 'Companionship', 'Dementia Care', 'Bathing Assistance', 'Transportation', 'Housekeeping'];
const JOB_TITLES = ['Part-time Caregiver Needed', 'Weekend Companion Care', 'Overnight Care Specialist', 'Dementia Care Expert', 'Live-in Caregiver', 'Elderly Companion', 'Post-Surgery Care', 'Respite Care Provider'];
const REVIEW_COMMENTS = [
  'Amazing caregiver! Very patient and kind with my mother.',
  'Professional and always on time. Highly recommend!',
  'Great communication and really cares about their clients.',
  'Went above and beyond expectations. Will hire again.',
  'Very knowledgeable about dementia care. Made us feel at ease.',
  'Punctual, professional, and genuinely caring.',
  'Excellent with medication management. Very thorough.',
  'My father loves having them visit. Great companion.',
  'Helped with transportation to appointments. Very reliable.',
  'Wonderful meal preparation. Mom eats so much better now.'
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
  console.log('🌱 Starting complete database seeding...\n');
  
  const created = {
    caregivers: 0,
    clients: 0,
    jobs: 0,
    appointments: 0,
    reviews: 0,
    tickets: 0,
    notifications: 0
  };
  
  try {
    // 1. Create Caregivers
    console.log('Creating 12 caregivers...');
    const caregiverIds = [];
    for (let i = 0; i < 12; i++) {
      const firstName = getRandomItem(FIRST_NAMES);
      const lastName = getRandomItem(LAST_NAMES);
      const location = getRandomItem(LOCATIONS);
      const experience = Math.floor(Math.random() * 15) + 1;
      const caregiverId = `caregiver_seed_${i}`;
      caregiverIds.push(caregiverId);
      
      const caregiver = {
        id: caregiverId,
        uid: caregiverId,
        name: `${firstName} ${lastName}`,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
        phone: `555-${String(Math.floor(Math.random() * 8999) + 1000).padStart(4, '0')}`,
        bio: `Experienced caregiver with ${experience} years of experience providing compassionate care for seniors. Specialized in ${getRandomItems(SKILLS_POOL, 3).join(', ')}.`,
        hourlyRate: Math.floor(Math.random() * 20) + 20,
        verified: true,
        verificationStatus: 'approved',
        onboardingStatus: 'complete',
        backgroundCheckStatus: 'clear',
        skills: getRandomItems(SKILLS_POOL, Math.floor(Math.random() * 5) + 3),
        certifications: getRandomItems(CERTIFICATIONS_POOL, Math.floor(Math.random() * 3) + 1),
        gender: getRandomItem(['Male', 'Female', 'Non-binary', 'Prefer not to say']),
        instantPayAvailable: Math.random() > 0.3,
        personalityTags: getRandomItems(PERSONALITY_TAGS, 3),
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
        medicalSkills: getRandomItems(['Wound Care', 'Diabetes Management', 'Blood Pressure Monitoring', 'Oxygen Therapy'], Math.floor(Math.random() * 2)),
        reliabilityScore: Math.floor(Math.random() * 20) + 80,
        acceptsMicroVisits: Math.random() > 0.5,
        ...SEED_DATA_FLAG,
      };
      
      await setDoc(doc(db, 'caregivers', caregiverId), caregiver);
      created.caregivers++;
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
        needs: getRandomItems(SENIOR_NEEDS, Math.floor(Math.random() * 4) + 2),
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
      
      await setDoc(doc(db, 'users', clientId), userData);
      await setDoc(doc(db, 'senior_profiles', clientId), seniorProfile);
      created.clients++;
      process.stdout.write(`  ✓ ${userData.name}\n`);
    }
    
    // 3. Create Job Posts
    console.log('\nCreating 10 job posts...');
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
        title: getRandomItem(JOB_TITLES),
        description: `Looking for a compassionate caregiver to assist with ${getRandomItems(SENIOR_NEEDS, 2).join(' and ')}. Must be patient, reliable, and experienced with elderly care.`,
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
      
      await setDoc(doc(db, 'job_posts', jobId), jobPost);
      created.jobs++;
      process.stdout.write(`  ✓ ${jobPost.title}\n`);
    }
    
    // 4. Create Appointments
    console.log('\nCreating 20 appointments...');
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
        notes: 'Regular care visit. Client doing well.',
        ...SEED_DATA_FLAG,
      };
      
      await setDoc(doc(db, 'appointments', appointment.id), appointment);
      created.appointments++;
      process.stdout.write(`  ✓ Appointment ${i + 1}\n`);
    }
    
    // 5. Create Reviews
    console.log('\nCreating 25 reviews...');
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
        comment: getRandomItem(REVIEW_COMMENTS),
        wouldRecommend: Math.random() > 0.1,
        wouldRehire: Math.random() > 0.15,
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        helpful: Math.floor(Math.random() * 20),
        ...SEED_DATA_FLAG,
      };
      
      await setDoc(doc(db, 'reviews', review.id), review);
      created.reviews++;
      process.stdout.write(`  ✓ Review ${i + 1}\n`);
    }
    
    // 6. Create Support Tickets
    console.log('\nCreating 8 support tickets...');
    const subjects = [
      'Issue with payment processing',
      'Need to update availability',
      'Question about background check',
      'App not showing notifications',
      'Request for receipt',
      'How do I cancel an appointment?',
      'Profile verification issue',
      'Cannot message caregiver'
    ];
    
    for (let i = 0; i < 8; i++) {
      const isClient = Math.random() > 0.5;
      const userId = isClient ? getRandomItem(clientIds) : getRandomItem(caregiverIds);
      
      const ticket = {
        id: `ticket_seed_${i}`,
        userId,
        userName: 'User Name',
        userType: isClient ? 'client' : 'caregiver',
        subject: subjects[i],
        description: 'User reported this issue via the support form. Please assist.',
        status: getRandomItem(['open', 'in_progress', 'resolved']),
        priority: getRandomItem(['low', 'medium', 'high']),
        createdAt: new Date(Date.now() - Math.random() * 1000000000).toISOString(),
        updatedAt: new Date().toISOString(),
        responses: [],
        ...SEED_DATA_FLAG,
      };
      
      await setDoc(doc(db, 'support_tickets', ticket.id), ticket);
      created.tickets++;
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
      
      await setDoc(doc(db, 'notifications', notification.id), notification);
      created.notifications++;
      process.stdout.write(`  ✓ Notification ${i + 1}\n`);
    }
    
    console.log('\n✅ Database seeding completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`  • ${created.caregivers} Caregivers`);
    console.log(`  • ${created.clients} Clients`);
    console.log(`  • ${created.jobs} Job Posts`);
    console.log(`  • ${created.appointments} Appointments`);
    console.log(`  • ${created.reviews} Reviews`);
    console.log(`  • ${created.tickets} Support Tickets`);
    console.log(`  • ${created.notifications} Notifications`);
    console.log('\n🎉 Platform is ready for testing!');
    
    return created;
    
  } catch (error) {
    console.error('\n❌ Error seeding database:', error);
    process.exit(1);
  }
}

seedDatabase().then((created) => {
  console.log('\n✨ Seed data created successfully!');
  process.exit(0);
}).catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
