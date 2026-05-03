import React, { useState } from 'react';
import { X, Star, ThumbsUp, ThumbsDown, CheckCircle } from 'lucide-react';
import { Button } from './ui/Button';

interface InterviewFeedbackModalProps {
    caregiverName: string;
    interviewDate: string;
    onClose: () => void;
    onSubmit: (feedback: InterviewFeedback) => void;
}

export interface InterviewFeedback {
    rating: number;
    wouldHire: boolean;
    strengths: string;
    concerns: string;
    notes: string;
}

export const InterviewFeedbackModal: React.FC<InterviewFeedbackModalProps> = ({
    caregiverName,
    interviewDate,
    onClose,
    onSubmit,
}) => {
    const [rating, setRating] = useState(0);
    const [wouldHire, setWouldHire] = useState<boolean | null>(null);
    const [strengths, setStrengths] = useState('');
    const [concerns, setConcerns] = useState('');
    const [notes, setNotes] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async () => {
        if (rating === 0 || wouldHire === null) {
            return;
        }

        setIsSubmitting(true);
        try {
            await onSubmit({
                rating,
                wouldHire,
                strengths,
                concerns,
                notes,
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="sticky top-0 bg-gradient-to-r from-primary-600 to-blue-600 text-white p-6 rounded-t-3xl">
                    <div className="flex justify-between items-start">
                        <div>
                            <h2 className="text-2xl font-bold mb-1">Interview Feedback</h2>
                            <p className="text-primary-50 text-sm">How did the interview with {caregiverName} go?</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-white/80 hover:text-white transition-colors"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6">
                    {/* Star Rating */}
                    <div>
                        <label className="block text-sm font-bold text-slate-700 mb-3">
                            Overall Rating
                        </label>
                        <div className="flex gap-2">
                            {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                    key={star}
                                    onClick={() => setRating(star)}
                                    className={`p-2 rounded-full transition-colors ${
                                        star <= rating
                                            ? 'text-accent-400'
                                            : 'text-slate-300 hover:text-accent-200'
                                    }`}
                                >
                                    <Star className="w-8 h-8 fill-current" />
                                </button>
                            ))}
                        </div>
                        <p className="text-sm text-slate-500 mt-2">
                            {rating === 1 && 'Poor - Not a good fit'}
                            {rating === 2 && 'Fair - Below expectations'}
                            {rating === 3 && 'Good - Met expectations'}
                            {rating === 4 && 'Very Good - Exceeded expectations'}
                            {rating === 5 && 'Excellent - Outstanding candidate'}
                        </p>
                    </div>

                    {/* Would Hire */}
                    <div>
                        <label className="block text-sm font-bold text-slate-700 mb-3">
                            Would you hire this caregiver?
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <button
                                onClick={() => setWouldHire(true)}
                                className={`p-4 rounded-xl border transition-all flex items-center justify-center gap-2 ${
                                    wouldHire === true
                                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                                        : 'border-slate-200 hover:border-slate-300'
                                }`}
                            >
                                <ThumbsUp className="w-5 h-5" />
                                <span className="font-medium">Yes</span>
                            </button>
                            <button
                                onClick={() => setWouldHire(false)}
                                className={`p-4 rounded-xl border transition-all flex items-center justify-center gap-2 ${
                                    wouldHire === false
                                        ? 'border-red-500 bg-red-50 text-red-700'
                                        : 'border-slate-200 hover:border-slate-300'
                                }`}
                            >
                                <ThumbsDown className="w-5 h-5" />
                                <span className="font-medium">No</span>
                            </button>
                        </div>
                    </div>

                    {/* Strengths */}
                    <div>
                        <label className="block text-sm font-bold text-slate-700 mb-2">
                            Strengths & Positives
                        </label>
                        <textarea
                            value={strengths}
                            onChange={(e) => setStrengths(e.target.value)}
                            placeholder="What impressed you about this caregiver?"
                            rows={3}
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                        />
                    </div>

                    {/* Concerns */}
                    <div>
                        <label className="block text-sm font-bold text-slate-700 mb-2">
                            Concerns or Questions
                        </label>
                        <textarea
                            value={concerns}
                            onChange={(e) => setConcerns(e.target.value)}
                            placeholder="Any concerns or questions that remain?"
                            rows={3}
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                        />
                    </div>

                    {/* Additional Notes */}
                    <div>
                        <label className="block text-sm font-bold text-slate-700 mb-2">
                            Additional Notes
                        </label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Any other observations or notes..."
                            rows={2}
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="sticky bottom-0 bg-white border-t border-slate-200 p-6 rounded-b-3xl">
                    <div className="flex gap-3">
                        <Button
                            variant="outline"
                            onClick={onClose}
                            className="flex-1"
                        >
                            Skip for Now
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSubmit}
                            disabled={rating === 0 || wouldHire === null || isSubmitting}
                            className="flex-1 bg-gradient-to-r from-primary-600 to-blue-600 hover:from-primary-700 hover:to-blue-700 text-white disabled:opacity-50"
                        >
                            {isSubmitting ? 'Submitting...' : 'Submit Feedback'}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};
