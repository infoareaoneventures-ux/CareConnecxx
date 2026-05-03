import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle, XCircle, User, Star, DollarSign, Calendar, MessageSquare, Loader2 } from 'lucide-react';
import { Button } from './ui/Button';
import { ClientNavigation } from './client/ClientNavigation';
import { auth, db } from '../lib/firebase';

interface CaregiverInfo {
  id: string;
  name: string;
  photo?: string;
  rating?: number;
  hourlyRate?: number;
}

export default function HireDecision() {
  const navigate = useNavigate();
  const { caregiverId } = useParams<{ caregiverId: string }>();
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showSuccessMessage, setShowSuccessMessage] = useState(false);
  const [decision, setDecision] = useState<'hire' | 'decline' | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [caregiver, setCaregiver] = useState<CaregiverInfo | null>(null);

  useEffect(() => {
    if (!caregiverId) { setLoading(false); return; }
    db.collection('caregivers').doc(caregiverId).get()
      .then((doc) => {
        if (doc.exists) {
          const d = doc.data()!;
          setCaregiver({
            id: caregiverId,
            name: d.name || d.displayName || 'Caregiver',
            photo: d.photoURL || d.imageUrl || '',
            rating: d.rating ?? (d.ratingSum && d.totalReviews ? d.ratingSum / d.totalReviews : undefined),
            hourlyRate: d.hourlyRate
          });
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [caregiverId]);

  const handleHire = () => {
    setDecision('hire');
    setShowConfirmModal(true);
  };

  const handleDecline = () => {
    setDecision('decline');
    setShowConfirmModal(true);
  };

  const confirmDecision = async () => {
    if (!caregiverId || !decision) return;
    const user = auth.currentUser;
    if (!user) { navigate('/login'); return; }

    setSubmitting(true);
    setShowConfirmModal(false);

    try {
      // Persist decision to Firestore
      await db.collection('hire_decisions').add({
        clientId: user.uid,
        clientName: user.displayName || user.email || 'Client',
        caregiverId,
        caregiverName: caregiver?.name || '',
        decision,
        createdAt: new Date().toISOString()
      });

      // Notify caregiver
      const title = decision === 'hire' ? 'You Were Hired!' : 'Hire Decision Update';
      const message = decision === 'hire'
        ? `${user.displayName || 'A client'} has decided to hire you. Check your messages to arrange the start date and details.`
        : `${user.displayName || 'A client'} has decided not to move forward at this time.`;

      await db.collection('users').doc(caregiverId).collection('notifications').add({
        userId: caregiverId,
        type: 'hire_decision',
        title,
        message,
        data: { clientId: user.uid, decision },
        read: false,
        isRead: false,
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString()
      });

      if (decision === 'hire') {
        setShowSuccessMessage(true);
      } else {
        navigate('/client/find-caregivers');
      }
    } catch (error) {
      console.error('Error saving hire decision:', error);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    );
  }

  const name = caregiver?.name || 'this caregiver';

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      <ClientNavigation />
      <div className="max-w-2xl mx-auto px-4 mt-12">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Hire Decision</h1>
          <p className="text-slate-600">Based on your interview with {name}</p>
        </div>

        {/* Caregiver Card */}
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-6 mb-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-full bg-primary-100 flex items-center justify-center overflow-hidden">
              {caregiver?.photo
                ? <img src={caregiver.photo} alt={name} className="w-full h-full object-cover" />
                : <User className="w-8 h-8 text-primary-600" />
              }
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">{name}</h2>
              {caregiver?.rating !== undefined && (
                <div className="flex items-center gap-2 mt-1">
                  <Star className="w-4 h-4 text-accent-400 fill-current" />
                  <span className="font-medium text-slate-700">{caregiver.rating.toFixed(1)}</span>
                </div>
              )}
            </div>
          </div>

          {caregiver?.hourlyRate && (
            <div className="p-3 bg-slate-50 rounded-xl w-fit">
              <p className="text-sm text-slate-500">Hourly Rate</p>
              <p className="text-xl font-bold text-primary-600">${caregiver.hourlyRate}/hr</p>
            </div>
          )}
        </div>

        {/* Decision Buttons */}
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={handleDecline}
            className="p-6 bg-white border-2 border-red-200 rounded-2xl hover:bg-red-50 transition-colors text-center"
          >
            <XCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-red-700 mb-1">Decline</h3>
            <p className="text-sm text-red-600">Continue browsing other caregivers</p>
          </button>

          <button
            onClick={handleHire}
            className="p-6 bg-white border-2 border-primary-200 rounded-2xl hover:bg-primary-50 transition-colors text-center"
          >
            <CheckCircle className="w-12 h-12 text-primary-600 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-primary-700 mb-1">Hire</h3>
            <p className="text-sm text-primary-600">Proceed to agreement and scheduling</p>
          </button>
        </div>

        {/* Additional Options */}
        <div className="mt-8 flex gap-4 justify-center">
          <button
            onClick={() => navigate(`/client/caregiver/${caregiverId}`)}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-800"
          >
            <User className="w-4 h-4" />
            View Full Profile
          </button>
          <button
            onClick={() => navigate('/client/inbox')}
            className="flex items-center gap-2 text-slate-600 hover:text-slate-800"
          >
            <MessageSquare className="w-4 h-4" />
            Message Caregiver
          </button>
        </div>
      </div>

      {/* Success Message */}
      {showSuccessMessage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle className="w-10 h-10 text-green-600" />
            </div>
            <h3 className="text-2xl font-bold text-slate-900 mb-4">You've Hired {name}!</h3>
            <p className="text-slate-600 mb-6">
              {name} has been notified. Message them to arrange your start date and schedule.
            </p>
            <div className="space-y-3">
              <button
                onClick={() => navigate('/client/inbox')}
                className="w-full py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
              >
                Message {name.split(' ')[0]} Now
              </button>
              <button
                onClick={() => navigate('/client/schedule')}
                className="w-full py-3 border border-slate-200 text-slate-700 font-medium rounded-xl hover:bg-slate-50 transition-colors"
              >
                Go to Schedule
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full">
            {decision === 'hire' ? (
              <>
                <div className="w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="w-8 h-8 text-primary-600" />
                </div>
                <h3 className="text-xl font-bold text-center text-slate-900 mb-2">Hire {name}?</h3>
                <p className="text-slate-600 text-center mb-6">
                  {name} will be notified immediately. You can then message them to arrange the schedule.
                </p>
              </>
            ) : (
              <>
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <XCircle className="w-8 h-8 text-red-600" />
                </div>
                <h3 className="text-xl font-bold text-center text-slate-900 mb-2">Decline {name}?</h3>
                <p className="text-slate-600 text-center mb-6">
                  {name} will be notified. You can continue browsing other caregivers.
                </p>
              </>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-3 border border-slate-200 rounded-xl font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDecision}
                disabled={submitting}
                className={`flex-1 py-3 rounded-xl font-medium text-white ${
                  decision === 'hire'
                    ? 'bg-primary-600 hover:bg-primary-700'
                    : 'bg-red-600 hover:bg-red-700'
                } disabled:opacity-60`}
              >
                {submitting ? 'Saving...' : decision === 'hire' ? 'Yes, Hire' : 'Yes, Decline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
