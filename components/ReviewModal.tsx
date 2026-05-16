
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Star, X } from 'lucide-react';
import { Button } from './ui/Button';
import { sanitizeMessage } from '../utils/sanitize';

interface ReviewModalProps {
  caregiverName: string;
  onClose: () => void;
  onSubmit: (rating: number, comment: string) => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({ caregiverName, onClose, onSubmit }) => {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [hoverRating, setHoverRating] = useState(0);

  const handleSubmit = () => {
    if (rating > 0) {
      // Sanitize comment before submission
      const sanitizedComment = sanitizeMessage(comment);
      onSubmit(rating, sanitizedComment);
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 animate-slide-in">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
          <X size={24} />
        </button>

        <h2 className="text-2xl font-bold text-slate-900 text-center mb-2">Rate Your Experience</h2>
        <p className="text-slate-500 text-center text-sm mb-6">
          How was your care service with <span className="font-bold text-slate-800">{caregiverName}</span>?
        </p>

        <div className="flex justify-center gap-2 mb-6">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onMouseEnter={() => setHoverRating(star)}
              onMouseLeave={() => setHoverRating(0)}
              onClick={() => setRating(star)}
              className="transition-transform hover:scale-110 focus:outline-none"
            >
              <Star 
                size={36} 
                className={`${(hoverRating || rating) >= star ? 'fill-accent-400 text-accent-400' : 'text-slate-300'}`} 
              />
            </button>
          ))}
        </div>

        <textarea
          className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl mb-6 text-sm focus:outline-none focus:ring-2 focus:ring-primary-100 resize-none h-32"
          placeholder="Share your feedback (optional)..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />

        <Button fullWidth onClick={handleSubmit} disabled={rating === 0}>
          Submit Review
        </Button>
      </div>
    </div>
  , document.body);
};
