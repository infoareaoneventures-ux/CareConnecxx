import { 
  collection, 
  query, 
  where, 
  orderBy, 
  limit,
  addDoc, 
  updateDoc, 
  doc, 
  getDocs,
  serverTimestamp,
  getDoc,
  writeBatch
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export interface Review {
  id: string;
  appointmentId: string;
  clientId: string;
  clientName: string;
  caregiverId: string;
  caregiverName: string;
  rating: number; // 1-5 stars
  comment: string;
  categories: {
    punctuality: number;
    professionalism: number;
    communication: number;
    careQuality: number;
  };
  wouldRecommend: boolean;
  wouldRehire: boolean;
  createdAt: string;
  timestamp: any;
  isPublic: boolean;
  response?: {
    text: string;
    respondedAt: string;
  };
}

export interface CaregiverRating {
  caregiverId: string;
  averageRating: number;
  totalReviews: number;
  fiveStarCount: number;
  fourStarCount: number;
  threeStarCount: number;
  twoStarCount: number;
  oneStarCount: number;
  categories: {
    punctuality: number;
    professionalism: number;
    communication: number;
    careQuality: number;
  };
  recentReviews: Review[];
}

/**
 * Rating and Review Service
 */
export const ratingService = {
  /**
   * Submit a review for a caregiver
   */
  async submitReview(reviewData: Omit<Review, 'id' | 'createdAt' | 'timestamp'>): Promise<string> {
    const batch = writeBatch(db);

    // Add the review
    const reviewRef = doc(collection(db, 'reviews'));
    const review = {
      ...reviewData,
      createdAt: new Date().toISOString(),
      timestamp: serverTimestamp()
    };
    batch.set(reviewRef, review);

    // Update appointment to mark as reviewed
    const appointmentRef = doc(db, 'appointments', reviewData.appointmentId);
    batch.update(appointmentRef, { hasReview: true });

    // Update caregiver's rating stats
    await this.updateCaregiverRating(reviewData.caregiverId, reviewData.rating, reviewData.categories);

    await batch.commit();

    return reviewRef.id;
  },

  /**
   * Update caregiver's aggregated rating
   */
  async updateCaregiverRating(
    caregiverId: string,
    newRating: number,
    categories: Review['categories']
  ): Promise<void> {
    const caregiverRef = doc(db, 'caregivers', caregiverId);
    const caregiverSnap = await getDoc(caregiverRef);

    if (!caregiverSnap.exists()) return;

    const caregiverData = caregiverSnap.data();
    const currentRating = caregiverData.rating || 0;
    const currentReviewCount = caregiverData.reviewCount || 0;

    // Calculate new average
    const newAverage = ((currentRating * currentReviewCount) + newRating) / (currentReviewCount + 1);

    // Update star counts
    const starCounts = {
      fiveStarCount: caregiverData.fiveStarCount || 0,
      fourStarCount: caregiverData.fourStarCount || 0,
      threeStarCount: caregiverData.threeStarCount || 0,
      twoStarCount: caregiverData.twoStarCount || 0,
      oneStarCount: caregiverData.oneStarCount || 0
    };

    switch (newRating) {
      case 5: starCounts.fiveStarCount++; break;
      case 4: starCounts.fourStarCount++; break;
      case 3: starCounts.threeStarCount++; break;
      case 2: starCounts.twoStarCount++; break;
      case 1: starCounts.oneStarCount++; break;
    }

    // Update category averages
    const currentCategories = caregiverData.ratingCategories || {
      punctuality: 0,
      professionalism: 0,
      communication: 0,
      careQuality: 0
    };

    const newCategories = {
      punctuality: ((currentCategories.punctuality * currentReviewCount) + categories.punctuality) / (currentReviewCount + 1),
      professionalism: ((currentCategories.professionalism * currentReviewCount) + categories.professionalism) / (currentReviewCount + 1),
      communication: ((currentCategories.communication * currentReviewCount) + categories.communication) / (currentReviewCount + 1),
      careQuality: ((currentCategories.careQuality * currentReviewCount) + categories.careQuality) / (currentReviewCount + 1)
    };

    await updateDoc(caregiverRef, {
      rating: Math.round(newAverage * 10) / 10,
      reviewCount: currentReviewCount + 1,
      ...starCounts,
      ratingCategories: newCategories,
      lastReviewAt: new Date().toISOString()
    });
  },

  /**
   * Get reviews for a caregiver
   */
  async getCaregiverReviews(caregiverId: string, maxResults: number = 20): Promise<Review[]> {
    const q = query(
      collection(db, 'reviews'),
      where('caregiverId', '==', caregiverId),
      where('isPublic', '==', true),
      orderBy('timestamp', 'desc'),
      limit(maxResults)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    })) as Review[];
  },

  /**
   * Get caregiver rating summary
   */
  async getCaregiverRatingSummary(caregiverId: string): Promise<CaregiverRating | null> {
    const caregiverRef = doc(db, 'caregivers', caregiverId);
    const caregiverSnap = await getDoc(caregiverRef);

    if (!caregiverSnap.exists()) return null;

    const data = caregiverSnap.data();
    const reviews = await this.getCaregiverReviews(caregiverId, 5);

    return {
      caregiverId,
      averageRating: data.rating || 0,
      totalReviews: data.reviewCount || 0,
      fiveStarCount: data.fiveStarCount || 0,
      fourStarCount: data.fourStarCount || 0,
      threeStarCount: data.threeStarCount || 0,
      twoStarCount: data.twoStarCount || 0,
      oneStarCount: data.oneStarCount || 0,
      categories: data.ratingCategories || {
        punctuality: 0,
        professionalism: 0,
        communication: 0,
        careQuality: 0
      },
      recentReviews: reviews
    };
  },

  /**
   * Check if a client can review an appointment
   */
  async canReviewAppointment(clientId: string, appointmentId: string): Promise<boolean> {
    // Check if appointment exists and belongs to client
    const appointmentRef = doc(db, 'appointments', appointmentId);
    const appointmentSnap = await getDoc(appointmentRef);

    if (!appointmentSnap.exists()) return false;

    const appointment = appointmentSnap.data();
    
    // Can only review completed appointments
    if (appointment.status !== 'completed') return false;
    
    // Can only review own appointments
    if (appointment.clientId !== clientId) return false;
    
    // Can't review if already reviewed
    if (appointment.hasReview) return false;

    return true;
  },

  /**
   * Get review by appointment ID
   */
  async getReviewByAppointment(appointmentId: string): Promise<Review | null> {
    const q = query(
      collection(db, 'reviews'),
      where('appointmentId', '==', appointmentId)
    );

    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as Review;
  },

  /**
   * Caregiver responds to a review
   */
  async respondToReview(reviewId: string, responseText: string): Promise<void> {
    const reviewRef = doc(db, 'reviews', reviewId);
    await updateDoc(reviewRef, {
      response: {
        text: responseText,
        respondedAt: new Date().toISOString()
      }
    });
  },

  /**
   * Get top-rated caregivers
   */
  async getTopRatedCaregivers(minReviews: number = 5, maxResults: number = 10): Promise<string[]> {
    // This would ideally be a Firebase function or require a composite index
    // For now, we'll query all caregivers and filter client-side
    const q = query(
      collection(db, 'caregivers'),
      where('verified', '==', true),
      orderBy('rating', 'desc'),
      limit(maxResults * 2) // Get more than needed in case some don't meet minReviews
    );

    const snapshot = await getDocs(q);
    const caregivers = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((c) => ((c as any).reviewCount || 0) >= minReviews)
      .slice(0, maxResults);

    return caregivers.map((c) => c.id);
  },

  /**
   * Calculate rating distribution
   */
  calculateRatingDistribution(rating: CaregiverRating): { stars: number; percentage: number }[] {
    const total = rating.totalReviews;
    if (total === 0) return [];

    return [
      { stars: 5, percentage: Math.round((rating.fiveStarCount / total) * 100) },
      { stars: 4, percentage: Math.round((rating.fourStarCount / total) * 100) },
      { stars: 3, percentage: Math.round((rating.threeStarCount / total) * 100) },
      { stars: 2, percentage: Math.round((rating.twoStarCount / total) * 100) },
      { stars: 1, percentage: Math.round((rating.oneStarCount / total) * 100) }
    ];
  }
};
