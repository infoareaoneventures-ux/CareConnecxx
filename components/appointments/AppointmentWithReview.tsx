import React, { useState, useEffect } from 'react';
import { Star, MessageSquare } from 'lucide-react';
import { Appointment } from '../../types';
import { ReviewModal } from '../Review';
import { ratingService } from '../../services/ratingService';
import { authService } from '../../services/api';

interface AppointmentWithReviewProps {
  appointment: Appointment;
  userType: 'client' | 'caregiver';
  onReviewSubmitted?: () => void;
}

export const AppointmentWithReview: React.FC<AppointmentWithReviewProps> = ({
  appointment,
  userType,
  onReviewSubmitted
}) => {
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [canReview, setCanReview] = useState(false);
  const [existingReview, setExistingReview] = useState<any>(null);
  const currentUser = authService.getCurrentUser();

  useEffect(() => {
    const checkReviewStatus = async () => {
      if (userType === 'client' && appointment.status === 'completed' && !appointment.hasReview) {
        const canReviewResult = await ratingService.canReviewAppointment(
          currentUser?.uid || '',
          appointment.id
        );
        setCanReview(canReviewResult);
      }
      
      // Check if there's already a review for this appointment
      if (appointment.hasReview) {
        const review = await ratingService.getReviewByAppointment(appointment.id);
        setExistingReview(review);
      }
    };
    
    checkReviewStatus();
  }, [appointment, userType, currentUser]);

  const handleReviewSubmitted = () => {
    setShowReviewModal(false);
    setCanReview(false);
    onReviewSubmitted?.();
  };

  // Show review button for clients if appointment is completed and not reviewed
  if (userType === 'client' && appointment.status === 'completed') {
    return (
      <div className="relative">
        {canReview && (
          <button
            onClick={() => setShowReviewModal(true)}
            className="w-full mt-3 py-2 bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-xl font-medium hover:bg-yellow-100 transition-colors flex items-center justify-center gap-2"
          >
            <Star className="w-4 h-4" /> Leave a Review
          </button>
        )}
        
        {existingReview && (
          <div className="mt-3 p-3 bg-slate-50 rounded-xl">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex">
                {[1, 2, 3, 4, 5].map((star) => (
                  <Star
                    key={star}
                    className={`w-3 h-3 ${
                      star <= existingReview.rating
                        ? 'fill-yellow-400 text-yellow-400'
                        : 'text-slate-200'
                    }`}
                  />
                ))}
              </div>
              <span className="text-xs text-slate-500">
                You left a review
              </span>
            </div>
            <p className="text-xs text-slate-600 line-clamp-2">{existingReview.comment}</p>
          </div>
        )}
        
        {showReviewModal && (
          <ReviewModal
            appointment={appointment}
            onClose={() => setShowReviewModal(false)}
            onSubmitted={handleReviewSubmitted}
          />
        )}
      </div>
    );
  }

  // For caregivers, show if they received a review
  if (userType === 'caregiver' && existingReview) {
    return (
      <div className="mt-3 p-3 bg-slate-50 rounded-xl">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex">
            {[1, 2, 3, 4, 5].map((star) => (
              <Star
                key={star}
                className={`w-3 h-3 ${
                  star <= existingReview.rating
                    ? 'fill-yellow-400 text-yellow-400'
                    : 'text-slate-200'
                }`}
              />
            ))}
          </div>
          <span className="text-xs text-slate-500">
            {existingReview.clientName} left a review
          </span>
        </div>
        <p className="text-xs text-slate-600 line-clamp-2">{existingReview.comment}</p>
        {existingReview.response && (
          <div className="mt-2 pt-2 border-t border-slate-200">
            <p className="text-xs text-slate-500">Your response:</p>
            <p className="text-xs text-slate-600">{existingReview.response.text}</p>
          </div>
        )}
      </div>
    );
  }

  return null;
};
