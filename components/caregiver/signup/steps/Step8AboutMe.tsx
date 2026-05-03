import React, { useState } from 'react';
import { X, Lightbulb, FileText, Loader2 } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { WRITING_IDEAS, EXAMPLE_BIO } from '../constants';

interface Step8Props {
  bio: string;
  onChange: (field: string, value: any) => void;
  onSubmit: () => void;
  onBack: () => void;
  onShowToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  isLoading: boolean;
}

export const Step8AboutMe: React.FC<Step8Props> = ({
  bio,
  onChange,
  onSubmit,
  onBack,
  onShowToast,
  isLoading,
}) => {
  const [showWritingIdeas, setShowWritingIdeas] = useState(false);
  const [showExample, setShowExample] = useState(false);

  const charCount = bio.length;
  const minChars = 150;
  const maxChars = 2500;

  const handleContinue = () => {
    if (charCount < minChars) {
      onShowToast(`Please write at least ${minChars} characters (${minChars - charCount} more needed)`, 'error');
      return;
    }
    onSubmit();
  };

  return (
    <div className="fade-in">
      <h1 className="text-3xl font-bold text-slate-800 mb-2">
        Tell families more about yourself.
      </h1>
      <p className="text-slate-500 mb-1">
        What's your background? What qualifications, personality traits, and talents make you a great caregiver?
        Be sure to highlight your experience with seniors.
      </p>
      <p className="text-sm text-slate-400 mb-6">
        For your safety, avoid including your contact information. {minChars} characters are required.
      </p>

      {/* Textarea */}
      <div className="mb-2">
        <textarea
          value={bio}
          onChange={(e) => {
            if (e.target.value.length <= maxChars) {
              onChange('bio', e.target.value);
            }
          }}
          placeholder={`Describe your relevant experience for families. At least ${minChars} characters are required.`}
          rows={8}
          className="w-full px-4 py-4 rounded-xl border-2 border-slate-300 text-base text-slate-900 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-100 resize-y transition-all"
        />
      </div>

      {/* Character counter */}
      <div className="flex items-center justify-between mb-4">
        <span className={`text-sm ${charCount < minChars ? 'text-primary-500' : 'text-slate-400'}`}>
          {maxChars - charCount} characters left
        </span>
        <span className={`text-sm font-medium ${
          charCount < minChars ? 'text-primary-500' : charCount >= maxChars ? 'text-red-500' : 'text-primary-600'
        }`}>
          {charCount}/{minChars} min
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-center gap-4 mb-6">
        <button
          onClick={() => setShowWritingIdeas(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 border-slate-300 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-slate-50 transition-all"
        >
          <Lightbulb className="w-4 h-4" />
          See Writing Ideas
        </button>
        <button
          onClick={() => setShowExample(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 border-slate-300 text-sm font-medium text-slate-600 hover:border-slate-400 hover:bg-slate-50 transition-all"
        >
          <FileText className="w-4 h-4" />
          See Example
        </button>
      </div>

      <div className="flex gap-3">
        <Button variant="secondary" size="lg" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleContinue}
          disabled={isLoading || charCount < minChars}
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Finishing up...
            </span>
          ) : (
            'Continue'
          )}
        </Button>
      </div>

      {/* Writing Ideas Modal */}
      {showWritingIdeas && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800">Writing Ideas</h3>
              <button
                onClick={() => setShowWritingIdeas(false)}
                className="p-1.5 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              Try answering some of these questions in your bio:
            </p>
            <ul className="space-y-3">
              {WRITING_IDEAS.map((idea, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm text-slate-600">
                  <span className="text-primary-500 mt-0.5">&#8226;</span>
                  {idea}
                </li>
              ))}
            </ul>
            <Button
              variant="primary"
              fullWidth
              className="mt-6"
              onClick={() => setShowWritingIdeas(false)}
            >
              Got it
            </Button>
          </div>
        </div>
      )}

      {/* Example Bio Modal */}
      {showExample && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-800">Example Bio</h3>
              <button
                onClick={() => setShowExample(false)}
                className="p-1.5 rounded-lg hover:bg-slate-100"
              >
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
              {EXAMPLE_BIO}
            </div>
            <Button
              variant="primary"
              fullWidth
              className="mt-6"
              onClick={() => setShowExample(false)}
            >
              Got it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
