import React, { useState, useEffect } from 'react';
import { Star, X, Send, ThumbsUp, ThumbsDown, Loader2, CheckCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { Review, Appointment } from '../types';
import { ratingService, Review as ReviewData } from '../services/ratingService';
import { authService } from '../services/api';

interface ReviewModalProps {
  appointment: Appointment;
  onClose: () => void;
  onSubmitted: () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({ appointment, onClose, onSubmitted }) => {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState('');
  const [categories, setCategories] = useState({
    punctuality: 0,
    professionalism: 0,
    communication: 0,
    careQuality: 0
  });
  const [wouldRecommend, setWouldRecommend] = useState<boolean | null>(null);
  const [wouldRehire, setWouldRehire] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const currentUser = authService.getCurrentUser();

  const handleCategoryRating = (category: keyof typeof categories, value: number) => {
    setCategories(prev => ({ ...prev, [category]: value }));
  };

  const handleSubmit = async () => {
    if (rating === 0) {
      setError('Please select an overall rating');
      return;
    }
    if (comment.trim().length < 10) {
      setError('Please write a review of at least 10 characters');
      return;
    }
    if (Object.values(categories).some(v => v === 0)) {
      setError('Please rate all categories');
      return;
    }
    if (wouldRecommend === null || wouldRehire === null) {
      setError('Please answer all questions');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const reviewData: Omit<ReviewData, 'id' | 'createdAt' | 'timestamp'> = {
        appointmentId: appointment.id,
        clientId: currentUser?.uid || '',
        clientName: currentUser?.displayName || 'Anonymous',
        caregiverId: String(appointment.caregiverId),
        caregiverName: appointment.caregiverName,
        rating,
        comment: comment.trim(),
        categories,
        wouldRecommend,
        wouldRehire,
        isPublic: true
      };

      await ratingService.submitReview(reviewData);
      setSubmitted(true);
      setTimeout(() => {
        onSubmitted();
        onClose();
      }, 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to submit review. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
        <div className="bg-white rounded-3xl p-8 max-w-md w-full text-center animate-slide-in">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-600" />
          </div>
          <h3 className="text-2xl font-bold text-slate-900 mb-2">Thank You!</h3>
          <p className="text-slate-600">Your review has been submitted successfully.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-slide-in">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-100 p-6 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Rate Your Experience</h2>
            <p className="text-sm text-slate-500">How was your care with {appointment.caregiverName}?</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Overall Rating */}
          <div className="text-center">
            <label className="block text-sm font-medium text-slate-700 mb-3">Overall Rating</label>
            <div className="flex justify-center gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setRating(star)}
                  onMouseEnter={() => setHoverRating(star)}
                  onMouseLeave={() => setHoverRating(0)}
                  className="transition-transform hover:scale-110"
                >
                  <Star
                    className={`w-10 h-10 ${
                      star <= (hoverRating || rating)
                        ? 'fill-yellow-400 text-yellow-400'
                        : 'text-slate-200'
                    }`}
                  />
                </button>
              ))}
            </div>
            <p className="text-sm text-slate-500 mt-2">
              {rating > 0 && ['Poor', 'Fair', 'Good', 'Very Good', 'Excellent'][rating - 1]}
            </p>
          </div>

          {/* Category Ratings */}
          <div className="space-y-4">
            <label className="block text-sm font-medium text-slate-700">Rate Specific Areas</label>
            {[
              { key: 'punctuality', label: 'Punctuality' },
              { key: 'professionalism', label: 'Professionalism' },
              { key: 'communication', label: 'Communication' },
              { key: 'careQuality', label: 'Quality of Care' }
            ].map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-sm text-slate-600">{label}</span>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      onClick={() => handleCategoryRating(key as keyof typeof categories, star)}
                    >
                      <Star
                        className={`w-5 h-5 ${
                          star <= categories[key as keyof typeof categories]
                            ? 'fill-yellow-400 text-yellow-400'
                            : 'text-slate-200'
                        }`}
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Written Review */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Tell us about your experience
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What went well? What could be improved?"
              className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              rows={4}
            />
            <p className="text-xs text-slate-400 mt-1">{comment.length} characters (min 10)</p>
          </div>

          {/* Yes/No Questions */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Would you recommend this caregiver to others?
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => setWouldRecommend(true)}
                  className={`flex-1 py-2 px-4 rounded-lg border transition-all flex items-center justify-center gap-2 ${
                    wouldRecommend === true
                      ? 'bg-green-50 border-green-500 text-green-700'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <ThumbsUp className="w-4 h-4" /> Yes
                </button>
                <button
                  onClick={() => setWouldRecommend(false)}
                  className={`flex-1 py-2 px-4 rounded-lg border transition-all flex items-center justify-center gap-2 ${
                    wouldRecommend === false
                      ? 'bg-red-50 border-red-500 text-red-700'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <ThumbsDown className="w-4 h-4" /> No
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Would you hire this caregiver again?
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => setWouldRehire(true)}
                  className={`flex-1 py-2 px-4 rounded-lg border transition-all flex items-center justify-center gap-2 ${
                    wouldRehire === true
                      ? 'bg-green-50 border-green-500 text-green-700'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <ThumbsUp className="w-4 h-4" /> Yes
                </button>
                <button
                  onClick={() => setWouldRehire(false)}
                  className={`flex-1 py-2 px-4 rounded-lg border transition-all flex items-center justify-center gap-2 ${
                    wouldRehire === false
                      ? 'bg-red-50 border-red-500 text-red-700'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <ThumbsDown className="w-4 h-4" /> No
                </button>
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {error}
            </div>
          )}

          {/* Submit Button */}
          <Button
            fullWidth
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Submitting...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" /> Submit Review
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

// Component to display review summary for a caregiver
interface ReviewSummaryProps {
  caregiverId: string;
}

export const ReviewSummary: React.FC<ReviewSummaryProps> = ({ caregiverId }) => {
  const [rating, setRating] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRating = async () => {
      try {
        const data = await ratingService.getCaregiverRatingSummary(caregiverId);
        setRating(data);
      } catch (e) {
        console.error('Error fetching rating:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchRating();
  }, [caregiverId]);

  if (loading) {
    return <div className="animate-pulse h-20 bg-slate-100 rounded-xl" />;
  }

  if (!rating || rating.totalReviews === 0) {
    return (
      <div className="text-center py-4 text-slate-400 text-sm">
        No reviews yet
      </div>
    );
  }

  const distribution = ratingService.calculateRatingDistribution(rating);

  return (
    <div className="bg-white rounded-xl p-4 border border-slate-100">
      {/* Overall Rating */}
      <div className="flex items-center gap-4 mb-4">
        <div className="text-4xl font-bold text-slate-900">
          {rating.averageRating.toFixed(1)}
        </div>
        <div>
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((star) => (
              <Star
                key={star}
                className={`w-4 h-4 ${
                  star <= Math.round(rating.averageRating)
                    ? 'fill-yellow-400 text-yellow-400'
                    : 'text-slate-200'
                }`}
              />
            ))}
          </div>
          <p className="text-sm text-slate-500">{rating.totalReviews} reviews</p>
        </div>
      </div>

      {/* Rating Distribution */}
      <div className="space-y-1">
        {distribution.map(({ stars, percentage }) => (
          <div key={stars} className="flex items-center gap-2 text-sm">
            <span className="w-3 text-slate-500">{stars}</span>
            <Star className="w-3 h-3 text-slate-300" />
            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-yellow-400 rounded-full"
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="w-8 text-right text-slate-500 text-xs">{percentage}%</span>
          </div>
        ))}
      </div>

      {/* Category Scores */}
      <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-2">
        {Object.entries(rating.categories).map(([key, value]) => (
          <div key={key} className="text-center">
            <p className="text-xs text-slate-500 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</p>
            <p className="font-bold text-slate-700">{(value as number).toFixed(1)}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

// Review list component
interface ReviewListProps {
  caregiverId: string;
  limit?: number;
}

export const ReviewList: React.FC<ReviewListProps> = ({ caregiverId, limit = 5 }) => {
  const [reviews, setReviews] = useState<ReviewData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchReviews = async () => {
      try {
        const data = await ratingService.getCaregiverReviews(caregiverId, limit);
        setReviews(data);
      } catch (e) {
        console.error('Error fetching reviews:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchReviews();
  }, [caregiverId, limit]);

  if (loading) {
    return <div className="space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />
      ))}
    </div>;
  }

  if (reviews.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400">
        No reviews yet
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {reviews.map((review) => (
        <div key={review.id} className="bg-white p-4 rounded-xl border border-slate-100">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="font-medium text-slate-900">{review.clientName}</p>
              <p className="text-xs text-slate-500">
                {new Date(review.createdAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <Star
                  key={star}
                  className={`w-4 h-4 ${
                    star <= review.rating
                      ? 'fill-yellow-400 text-yellow-400'
                      : 'text-slate-200'
                  }`}
                />
              ))}
            </div>
          </div>
          <p className="text-slate-600 text-sm mb-3">{review.comment}</p>
          {review.wouldRecommend && (
            <div className="flex items-center gap-1 text-xs text-green-600">
              <ThumbsUp className="w-3 h-3" />
              <span>Would recommend</span>
            </div>
          )}
          {review.response && (
            <div className="mt-3 p-3 bg-slate-50 rounded-lg">
              <p className="text-xs font-medium text-slate-700 mb-1">Caregiver Response:</p>
              <p className="text-sm text-slate-600">{review.response.text}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
