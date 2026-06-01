import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, Clock, X, User } from 'lucide-react';
import { auth, db } from '../lib/firebase';

interface PendingInterview {
  id: string;
  caregiverName: string;
  date: string;
  time: string;
  status: 'pending' | 'accepted' | 'declined';
}

export default function InterviewConfirmation() {
  const navigate = useNavigate();
  const [showBanner, setShowBanner] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    checkPendingInterviews();
  }, []);

  const checkPendingInterviews = async () => {
    try {
      if (!auth || !db) return;
      const fdb = db;
      const user = auth.currentUser;
      if (!user) return;

      // Query Firestore for pending interviews
      const snapshot = await fdb.collection('interviews')
        .where('clientId', '==', user.uid)
        .where('status', '==', 'pending')
        .get();

      if (!snapshot.empty) {
        setPendingCount(snapshot.size);
        setShowBanner(true);
      }
    } catch (error) {
      console.error('Error checking interviews:', error);
    }
  };

  const handleDismiss = () => {
    setShowBanner(false);
  };

  const handleViewStatus = () => {
    navigate('/client/interviews');
  };

  if (!showBanner) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 md:left-auto md:right-4 md:w-96 bg-white rounded-2xl shadow-lg border border-primary-200 p-4 z-50 animate-slide-up">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
          <CheckCircle className="w-5 h-5 text-primary-600" />
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <h4 className="font-bold text-slate-900">Interview Request Sent!</h4>
            <button
              onClick={handleDismiss}
              className="p-1 hover:bg-slate-100 rounded-full transition-colors"
            >
              <X className="w-4 h-4 text-slate-400" />
            </button>
          </div>
          <p className="text-sm text-slate-600 mb-3">
            Waiting for caregiver response. You'll be notified when they accept or decline.
          </p>
          {pendingCount > 0 && (
            <div className="flex items-center gap-2 text-sm text-accent-600 mb-3">
              <Clock className="w-4 h-4" />
              <span>{pendingCount} pending interview{pendingCount > 1 ? 's' : ''}</span>
            </div>
          )}
          <button
            onClick={handleViewStatus}
            className="w-full py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
          >
            View Status
          </button>
        </div>
      </div>
    </div>
  );
}

// Toast notification component for interview sent
export function InterviewSentToast({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-white rounded-2xl shadow-lg border border-primary-200 p-6 z-50 min-w-[320px]">
      <div className="text-center">
        <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="w-8 h-8 text-primary-600" />
        </div>
        <h3 className="text-lg font-bold text-slate-900 mb-2">Interview Request Sent!</h3>
        <p className="text-sm text-slate-600 mb-4">
          Waiting for caregiver response. They have 24 hours to respond.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2 border border-slate-200 rounded-lg text-slate-700 font-medium hover:bg-slate-50 transition-colors"
          >
            Continue Browsing
          </button>
          <button
            onClick={() => {
              onClose();
              navigate('/client/interviews');
            }}
            className="flex-1 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
          >
            View Status
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline confirmation for after scheduling
export function InlineInterviewConfirmation({ 
  caregiverName,
  onClose 
}: { 
  caregiverName: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  return (
    <div className="bg-primary-50 border border-primary-200 rounded-2xl p-6 mb-6">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
          <CheckCircle className="w-6 h-6 text-primary-600" />
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-primary-900 text-lg mb-1">Interview Request Sent!</h3>
          <p className="text-primary-700 mb-4">
            Your interview request with {caregiverName} has been sent. You'll be notified when they respond.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => navigate('/client/interviews')}
              className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
            >
              View Status
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 border border-primary-300 text-primary-700 text-sm font-medium rounded-lg hover:bg-primary-100 transition-colors"
            >
              Continue Browsing
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
