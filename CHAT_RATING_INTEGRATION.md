/**
 * Chat & Rating System Integration Example
 * 
 * This file shows how to integrate the new Chat and Rating components
 * into your existing CareConnex application.
 */

import { ChatInbox, ChatBadge } from './components/ChatInbox';
import { Chat } from './components/Chat';
import { ReviewModal, CaregiverRatingDisplay, ReviewCard } from './components/Review';
import { chatService } from './services/chatService';
import { ratingService } from './services/ratingService';

// =============================================================================
// EXAMPLE 1: Add Chat to Navigation
// =============================================================================

/* In your navigation component (e.g., ClientDashboard.tsx or CaregiverDashboard.tsx):

import { ChatBadge } from './components/ChatInbox';
import { MessageSquare } from 'lucide-react';

function Navigation() {
  const currentUser = { uid: 'user123', name: 'John Doe' };
  
  return (
    <nav>
      <NavLink to="/dashboard">Dashboard</NavLink>
      <NavLink to="/appointments">Appointments</NavLink>
      
      // Add this chat link with badge
      <NavLink to="/messages" className="relative">
        <MessageSquare className="w-5 h-5" />
        <span>Messages</span>
        <ChatBadge userId={currentUser.uid} />
      </NavLink>
      
      <NavLink to="/profile">Profile</NavLink>
    </nav>
  );
}
*/

// =============================================================================
// EXAMPLE 2: Chat Inbox Page
// =============================================================================

/* Create a new page: pages/MessagesPage.tsx

import { ChatInbox } from '../components/ChatInbox';

export function MessagesPage() {
  const currentUser = {
    uid: 'user123',
    name: 'John Doe',
    userType: 'client' as const
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Messages</h1>
      <ChatInbox 
        userId={currentUser.uid}
        userName={currentUser.name}
        userType={currentUser.userType}
      />
    </div>
  );
}
*/

// =============================================================================
// EXAMPLE 3: Start Chat from Appointment
// =============================================================================

/* In your appointment details component:

import { useState } from 'react';
import { Chat } from './components/Chat';
import { MessageSquare } from 'lucide-react';
import { Button } from './components/ui/Button';

function AppointmentDetails({ appointment, caregiver, currentUser }) {
  const [showChat, setShowChat] = useState(false);
  const [chatRoomId, setChatRoomId] = useState<string | undefined>();

  const startChat = async () => {
    // Create or get existing chat room
    const roomId = await chatService.getOrCreateChatRoom(
      currentUser.uid,
      currentUser.name,
      caregiver.uid,
      caregiver.name
    );
    setChatRoomId(roomId);
    setShowChat(true);
  };

  return (
    <div>
      <h2>Appointment with {caregiver.name}</h2>
      <p>Date: {appointment.date}</p>
      <p>Time: {appointment.time}</p>
      
      <Button onClick={startChat} className="flex items-center gap-2">
        <MessageSquare className="w-4 h-4" />
        Message {caregiver.name}
      </Button>

      {showChat && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-2xl h-[600px]">
            <Chat
              chatRoomId={chatRoomId}
              currentUserId={currentUser.uid}
              currentUserName={currentUser.name}
              otherUserId={caregiver.uid}
              otherUserName={caregiver.name}
              otherUserAvatar={caregiver.photo}
              onClose={() => setShowChat(false)}
              isModal
            />
          </div>
        </div>
      )}
    </div>
  );
}
*/

// =============================================================================
// EXAMPLE 4: Submit Review After Appointment
// =============================================================================

/* In your appointment completion flow:

import { useState } from 'react';
import { ReviewModal } from './components/Review';
import { Button } from './components/ui/Button';

function AppointmentCompletion({ appointment, caregiver, currentUser }) {
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [hasReviewed, setHasReviewed] = useState(appointment.hasReview);

  const checkCanReview = async () => {
    const canReview = await ratingService.canReviewAppointment(
      currentUser.uid,
      appointment.id
    );
    return canReview;
  };

  return (
    <div>
      <h2>Appointment Completed</h2>
      
      {!hasReviewed && (
        <Button 
          onClick={() => setShowReviewModal(true)}
          className="bg-gradient-to-r from-yellow-400 to-orange-500"
        >
          ⭐ Rate Your Experience
        </Button>
      )}

      {hasReviewed && (
        <p className="text-green-600">✓ Thank you for your review!</p>
      )}

      <ReviewModal
        isOpen={showReviewModal}
        onClose={() => setShowReviewModal(false)}
        appointmentId={appointment.id}
        clientId={currentUser.uid}
        clientName={currentUser.name}
        caregiverId={caregiver.uid}
        caregiverName={caregiver.name}
        caregiverImage={caregiver.photo}
        onSubmit={() => setHasReviewed(true)}
      />
    </div>
  );
}
*/

// =============================================================================
// EXAMPLE 5: Display Caregiver Rating
// =============================================================================

/* In caregiver profile or card:

import { CaregiverRatingDisplay } from './components/Review';

function CaregiverCard({ caregiver }) {
  return (
    <div className="caregiver-card">
      <img src={caregiver.photo} alt={caregiver.name} />
      <h3>{caregiver.name}</h3>
      
      // Add this rating display
      <CaregiverRatingDisplay
        rating={caregiver.rating || 0}
        reviewCount={caregiver.reviewCount || 0}
        size="md"
        showCount
      />
      
      <p>${caregiver.hourlyRate}/hour</p>
    </div>
  );
}
*/

// =============================================================================
// EXAMPLE 6: Display Caregiver Reviews
// =============================================================================

/* In caregiver profile page:

import { useEffect, useState } from 'react';
import { ReviewCard } from './components/Review';
import { ratingService } from './services/ratingService';

function CaregiverReviews({ caregiverId }) {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadReviews = async () => {
      const reviewsData = await ratingService.getCaregiverReviews(caregiverId, 10);
      setReviews(reviewsData);
      setLoading(false);
    };
    loadReviews();
  }, [caregiverId]);

  if (loading) return <div>Loading reviews...</div>;

  return (
    <div className="reviews-section">
      <h2>Reviews ({reviews.length})</h2>
      
      {reviews.map(review => (
        <ReviewCard key={review.id} review={review} />
      ))}
    </div>
  );
}
*/

// =============================================================================
// EXAMPLE 7: Caregiver Responds to Review
// =============================================================================

/* In caregiver dashboard for responding to reviews:

import { useState } from 'react';
import { ratingService } from './services/ratingService';

function ReviewResponse({ review }) {
  const [response, setResponse] = useState('');
  const [hasResponded, setHasResponded] = useState(!!review.response);

  const submitResponse = async () => {
    if (!response.trim()) return;
    
    await ratingService.respondToReview(review.id, response);
    setHasResponded(true);
  };

  if (hasResponded) {
    return (
      <div className="response">
        <p><strong>Your response:</strong></p>
        <p>{review.response?.text}</p>
      </div>
    );
  }

  return (
    <div>
      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="Thank the client and address any concerns..."
        className="w-full p-3 border rounded-lg"
        rows={3}
      />
      <button onClick={submitResponse}>
        Post Response
      </button>
    </div>
  );
}
*/

// =============================================================================
// FIRESTORE SECURITY RULES (Add to firestore.rules)
// =============================================================================

/*
Add these rules to your firestore.rules file:

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Existing rules...
    
    // Chat Rooms
    match /chatRooms/{roomId} {
      allow read: if request.auth != null && 
        request.auth.uid in resource.data.participants;
      allow create: if request.auth != null;
      allow update: if request.auth != null && 
        request.auth.uid in resource.data.participants;
    }
    
    // Messages
    match /chatRooms/{roomId}/messages/{messageId} {
      allow read: if request.auth != null && 
        request.auth.uid in get(/databases/$(database)/documents/chatRooms/$(roomId)).data.participants;
      allow create: if request.auth != null && 
        request.auth.uid == request.resource.data.senderId;
      allow update: if request.auth != null && 
        request.auth.uid in get(/databases/$(database)/documents/chatRooms/$(roomId)).data.participants;
    }
    
    // Reviews
    match /reviews/{reviewId} {
      allow read: if resource.data.isPublic == true || 
        request.auth.uid == resource.data.clientId ||
        request.auth.uid == resource.data.caregiverId;
      allow create: if request.auth != null && 
        request.auth.uid == request.resource.data.clientId;
      allow update: if request.auth != null && 
        request.auth.uid == resource.data.caregiverId && // Only caregiver can respond
        request.resource.data.diff(resource.data).affectedKeys().hasOnly(['response']);
    }
  }
}
*/

// =============================================================================
// DEPLOYMENT CHECKLIST
// =============================================================================

/*
Before deploying chat and ratings:

□ Update Firestore security rules (see above)
□ Create Firestore indexes for:
  - chatRooms: participants (array), lastMessageTimestamp (desc)
  - chatRooms/{roomId}/messages: timestamp (asc)
  - reviews: caregiverId (asc), timestamp (desc)
  
□ Test chat functionality between two test accounts
□ Test review submission flow
□ Test caregiver response to review
□ Verify real-time message updates
□ Test unread message counters
□ Test on mobile devices
□ Add error handling for failed message sends
□ Set up Firebase Cloud Messaging for push notifications (optional)
*/
