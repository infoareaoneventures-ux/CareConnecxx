import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Star, CheckCircle, User, Clock, Calendar, MessageSquare, ThumbsUp, ThumbsDown, AlertCircle, Loader2 } from 'lucide-react';
import { ClientNavigation } from './client/ClientNavigation';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { useCareConnex } from '../context/CareConnexContext';

interface ReviewData {
  rating: number;
  feedback: string;
  confirmVisit: boolean;
}

export default function ReviewSystem() {
  const navigate = useNavigate();
  const { visitId } = useParams();
  const { addToast } = useCareConnex();
  const [review, setReview] = useState<ReviewData>({
    rating: 0,
    feedback: '',
    confirmVisit: true
  });
  const [hoverRating, setHoverRating] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [visit, setVisit] = useState<{
    id: string;
    caregiverName: string;
    caregiverId: string;
    date: string;
    startTime: string;
    endTime: string;
    duration: string;
    tasksCompleted: string[];
  } | null>(null);

  useEffect(() => {
    if (!visitId) { setLoading(false); return; }
    if (!db) { setLoading(false); return; }
    db.collection('appointments').doc(visitId).get()
      .then(doc => {
        if (!doc.exists) { setLoading(false); return; }
        const d = doc.data()!;
        const scheduledDate = d.scheduledDate?.toDate?.() || (d.isoDate ? new Date(d.isoDate) : null);
        setVisit({
          id: doc.id,
          caregiverName: d.caregiverName || 'Your Caregiver',
          caregiverId: d.caregiverId || d.caregiverUid || '',
          date: d.date || (scheduledDate ? scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''),
          startTime: d.startTime || d.time || '',
          endTime: d.endTime || '',
          duration: d.duration || '',
          tasksCompleted: d.tasksCompleted || d.tasks || []
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [visitId]);

  const handleRatingClick = (rating: number) => {
    setReview(prev => ({ ...prev, rating }));
  };

  const handleSubmit = async () => {
    if (review.rating === 0) {
      addToast('Please select a star rating before submitting.', 'error');
      return;
    }
    // In-flight guard: a double-click otherwise writes two `reviews` docs and
    // double-increments the caregiver's totalReviews/ratingSum, permanently
    // inflating their public rating.
    if (submitting) return;
    setSubmitting(true);

    try {
      const fdb = db;
      if (!fdb || !auth) {
        addToast('Failed to submit review. Please try again.', 'error');
        return;
      }
      const user = auth.currentUser;
      if (!user) {
        navigate('/login');
        return;
      }

      const caregiverId = visit?.caregiverId || '';

      // Save review to Firestore
      await fdb.collection('reviews').add({
        clientId: user.uid,
        visitId: visitId,
        caregiverId,
        rating: review.rating,
        feedback: review.feedback,
        confirmVisit: review.confirmVisit,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Update caregiver's average rating
      if (caregiverId) {
        await fdb.collection('caregivers').doc(caregiverId).update({
          totalReviews: firebase.firestore.FieldValue.increment(1),
          ratingSum: firebase.firestore.FieldValue.increment(review.rating)
        });

        // U3: the caregiver "new review" notification is owned by the
        // onReviewWritten server trigger (review created → caregiver). The
        // browser peer-write here always failed the notification rule; removed.
      }

      setSubmitted(true);
    } catch (error) {
      console.error('Error submitting review:', error);
      addToast('Failed to submit review. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
      </div>
    );
  }

  if (!visit) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          <AlertCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">Visit Not Found</h2>
          <p className="text-slate-600 mb-6">This visit record could not be found.</p>
          <button
            onClick={() => navigate('/client/dashboard')}
            className="px-6 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-10 h-10 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Review Submitted!</h2>
          <p className="text-slate-600 mb-6">Thank you for your feedback. Your review helps other families make informed decisions.</p>
          <div className="space-y-3">
            <button
              onClick={() => navigate('/client/calendar')}
              className="w-full py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
            >
              View Schedule
            </button>
            <button
              onClick={() => navigate('/client/dashboard')}
              className="w-full py-3 border border-slate-200 text-slate-700 font-medium rounded-xl hover:bg-slate-50 transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      <ClientNavigation />
      <div className="max-w-2xl mx-auto px-4 mt-12">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Rate Your Visit</h1>
          <p className="text-slate-600">Share your experience with {visit.caregiverName}</p>
        </div>

        {/* Visit Summary Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center">
              <User className="w-7 h-7 text-primary-600" />
            </div>
            <div>
              <h2 className="font-bold text-slate-900 text-lg">{visit.caregiverName}</h2>
              <p className="text-slate-500">Caregiver</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="p-3 bg-slate-50 rounded-xl text-center">
              <Calendar className="w-5 h-5 text-slate-400 mx-auto mb-1" />
              <p className="text-sm text-slate-500">Date</p>
              <p className="font-medium text-slate-900">{visit.date}</p>
            </div>
            <div className="p-3 bg-slate-50 rounded-xl text-center">
              <Clock className="w-5 h-5 text-slate-400 mx-auto mb-1" />
              <p className="text-sm text-slate-500">Duration</p>
              <p className="font-medium text-slate-900">{visit.duration}</p>
            </div>
            <div className="p-3 bg-slate-50 rounded-xl text-center">
              <CheckCircle className="w-5 h-5 text-slate-400 mx-auto mb-1" />
              <p className="text-sm text-slate-500">Tasks</p>
              <p className="font-medium text-slate-900">{visit.tasksCompleted.length}</p>
            </div>
          </div>

          <div className="p-4 bg-accent-50 border border-accent-200 rounded-xl">
            <p className="text-sm font-medium text-accent-900 mb-2">Tasks Completed:</p>
            <div className="flex flex-wrap gap-2">
              {visit.tasksCompleted.map((task, idx) => (
                <span key={idx} className="text-xs bg-white text-accent-700 px-2 py-1 rounded-full">
                  {task}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Confirm Visit */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Confirm Visit Details</h3>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={review.confirmVisit}
              onChange={(e) => setReview(prev => ({ ...prev, confirmVisit: e.target.checked }))}
              className="w-5 h-5 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="text-slate-700">I confirm this visit occurred as scheduled</span>
          </label>
        </div>

        {/* Rating Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">How was your experience?</h3>
          <div className="flex justify-center gap-2 mb-4">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onClick={() => handleRatingClick(star)}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(0)}
                className="p-2 transition-transform hover:scale-110"
              >
                <Star
                  className={`w-10 h-10 ${
                    star <= (hoverRating || review.rating)
                      ? 'text-accent-400 fill-current'
                      : 'text-slate-200'
                  }`}
                />
              </button>
            ))}
          </div>
          <p className="text-center text-sm text-slate-500">
            {review.rating === 0 && 'Click to rate'}
            {review.rating === 1 && 'Poor - Needs improvement'}
            {review.rating === 2 && 'Fair - Below average'}
            {review.rating === 3 && 'Good - Average'}
            {review.rating === 4 && 'Very Good - Above average'}
            {review.rating === 5 && 'Excellent - Outstanding!'}
          </p>
        </div>

        {/* Feedback Section */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <h3 className="text-lg font-bold text-slate-900 mb-4">Additional Feedback (Optional)</h3>
          <p className="text-sm text-slate-500 mb-3">Help other families by sharing your experience</p>
          <textarea
            value={review.feedback}
            onChange={(e) => setReview(prev => ({ ...prev, feedback: e.target.value }))}
            placeholder="Example: Sarah was very kind and professional. She arrived on time and took great care of my mother..."
            className="w-full h-32 px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
          />
          <div className="flex gap-3 mt-4">
            <button className="flex items-center gap-2 px-4 py-2 bg-green-50 text-green-700 rounded-lg text-sm font-medium hover:bg-green-100 transition-colors">
              <ThumbsUp className="w-4 h-4" />
              Recommend
            </button>
            <button className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors">
              <ThumbsDown className="w-4 h-4" />
              Not Recommend
            </button>
          </div>
        </div>

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={review.rating === 0 || submitting}
          className="w-full py-4 bg-gradient-to-r from-primary-600 to-blue-600 text-white font-bold rounded-xl hover:from-primary-700 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Submitting…' : 'Submit Review'}
        </button>

        <button
          onClick={() => navigate('/client/calendar')}
          className="w-full py-4 mt-3 text-slate-500 font-medium hover:text-slate-700 transition-colors"
        >
          Skip for Now
        </button>
      </div>
    </div>
  );
}
