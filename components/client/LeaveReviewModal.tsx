import React, { useState } from 'react';
import { Star, X, CheckCircle, Loader2 } from 'lucide-react';
import { db, auth } from '../../lib/firebase';
import firebase from '../../lib/firebase';

interface LeaveReviewModalProps {
  caregiverId: string;
  caregiverName: string;
  onClose: () => void;
  onSubmitted: () => void;
}

const CATEGORIES = [
  { key: 'punctuality',     label: 'Punctuality' },
  { key: 'professionalism', label: 'Professionalism' },
  { key: 'communication',   label: 'Communication' },
  { key: 'careQuality',     label: 'Quality of Care' },
] as const;

export const LeaveReviewModal: React.FC<LeaveReviewModalProps> = ({
  caregiverId, caregiverName, onClose, onSubmitted,
}) => {
  const [rating, setRating]         = useState(0);
  const [hover, setHover]           = useState(0);
  const [categories, setCategories] = useState({ punctuality: 0, professionalism: 0, communication: 0, careQuality: 0 });
  const [comment, setComment]       = useState('');
  const [recommend, setRecommend]   = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState('');

  const user = auth?.currentUser;

  const setCat = (key: keyof typeof categories, val: number) =>
    setCategories(prev => ({ ...prev, [key]: val }));

  const handleSubmit = async () => {
    if (rating === 0)               { setError('Please select a star rating'); return; }
    if (comment.trim().length < 10) { setError('Please write at least 10 characters'); return; }
    if (recommend === null)         { setError('Please answer the recommendation question'); return; }

    setError('');
    setSubmitting(true);
    try {
      // Guard: prevent duplicate reviews
      const existing = await db!.collection('reviews')
        .where('clientId', '==', user?.uid || '')
        .where('caregiverId', '==', caregiverId)
        .limit(1).get();
      if (!existing.empty) {
        setError('You have already reviewed this caregiver.');
        setSubmitting(false);
        return;
      }

      await db!.collection('reviews').add({
        clientId:       user?.uid || '',
        clientName:     user?.displayName || 'Client',
        clientPhotoURL: user?.photoURL || null,
        caregiverId,
        caregiverName,
        rating,
        comment:        comment.trim(),
        categories,
        wouldRecommend: recommend,
        wouldRehire:    recommend,
        isPublic:       true,
        createdAt:      new Date().toISOString(),
        timestamp:      firebase.firestore.FieldValue.serverTimestamp(),
      });

      // Update caregiver aggregated rating (best-effort — rules may restrict client writes)
      try {
        const cgSnap = await db!.collection('caregivers').doc(caregiverId).get();
        if (cgSnap.exists) {
          const d = cgSnap.data() as any;
          const count = (d.reviewCount || 0) + 1;
          const avg   = ((d.rating || 0) * (count - 1) + rating) / count;
          await db!.collection('caregivers').doc(caregiverId).update({
            rating:         avg,
            reviewCount:    count,
            fiveStarCount:  (d.fiveStarCount  || 0) + (rating === 5 ? 1 : 0),
            fourStarCount:  (d.fourStarCount  || 0) + (rating === 4 ? 1 : 0),
            threeStarCount: (d.threeStarCount || 0) + (rating === 3 ? 1 : 0),
            twoStarCount:   (d.twoStarCount   || 0) + (rating === 2 ? 1 : 0),
            oneStarCount:   (d.oneStarCount   || 0) + (rating === 1 ? 1 : 0),
          });
        }
      } catch { /* rating aggregation handled server-side */ }

      setSubmitted(true);
      setTimeout(() => { onSubmitted(); onClose(); }, 1800);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        {submitted ? (
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <CheckCircle className="w-12 h-12 text-green-500 mb-3" />
            <p className="text-lg font-bold text-slate-900">Thank you!</p>
            <p className="text-sm text-slate-500 mt-1">Your review has been submitted.</p>
          </div>
        ) : (
          <>
            <div className="px-6 pt-6 pb-4 border-b border-slate-100 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Leave a Review</h3>
                <p className="text-sm text-slate-400 mt-0.5">How was your experience with {caregiverName.split(' ')[0]}?</p>
              </div>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 -mr-1 -mt-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5 overflow-y-auto max-h-[65vh]">
              {/* Overall rating */}
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-2">Overall rating</p>
                <div className="flex gap-1">
                  {[1,2,3,4,5].map(s => (
                    <button key={s} type="button"
                      onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(0)}
                      onClick={() => setRating(s)} className="transition-transform hover:scale-110">
                      <Star className={`w-8 h-8 ${(hover || rating) >= s ? 'fill-yellow-400 text-yellow-400' : 'text-slate-300'}`} />
                    </button>
                  ))}
                </div>
              </div>

              {/* Category ratings */}
              <div className="space-y-3">
                <p className="text-sm font-semibold text-slate-700">Rate by category</p>
                {CATEGORIES.map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-sm text-slate-600 w-36">{label}</span>
                    <div className="flex gap-0.5">
                      {[1,2,3,4,5].map(s => (
                        <button key={s} type="button" onClick={() => setCat(key, s)}>
                          <Star className={`w-5 h-5 ${categories[key] >= s ? 'fill-yellow-400 text-yellow-400' : 'text-slate-300'}`} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Comment */}
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-1.5">Your review</p>
                <textarea value={comment} onChange={e => { if (e.target.value.length <= 250) setComment(e.target.value); }}
                  placeholder="Share your experience..."
                  rows={3}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 resize-none" />
                <div className="flex justify-between mt-1">
                  {comment.trim().length < 10 && <p className="text-xs text-slate-400">{Math.max(0, 10 - comment.trim().length)} more characters needed</p>}
                  <p className={`text-xs ml-auto ${comment.length >= 225 ? 'text-orange-500' : 'text-slate-400'}`}>{comment.length}/250</p>
                </div>
              </div>

              {/* Recommend */}
              <div>
                <p className="text-sm font-semibold text-slate-700 mb-2">Would you recommend this caregiver?</p>
                <div className="flex gap-3">
                  {([true, false] as const).map(val => (
                    <button key={String(val)} type="button" onClick={() => setRecommend(val)}
                      className={`flex-1 py-2 rounded-xl border text-sm font-medium transition-colors ${
                        recommend === val ? 'bg-primary-600 text-white border-primary-600' : 'border-slate-200 text-slate-600 hover:border-primary-300'
                      }`}>
                      {val ? 'Yes' : 'No'}
                    </button>
                  ))}
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>

            <div className="px-6 pb-6 pt-3 border-t border-slate-100 flex gap-3">
              <button onClick={onClose} className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={handleSubmit} disabled={submitting}
                className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-semibold hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2">
                {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</> : 'Submit Review'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
