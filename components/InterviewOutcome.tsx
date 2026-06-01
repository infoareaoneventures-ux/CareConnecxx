import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle, XCircle, AlertCircle, Clock, User, Calendar, MessageSquare, ChevronLeft, Loader2 } from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { ClientNavigation } from './client/ClientNavigation';
import { useCareConnex } from '../context/CareConnexContext';
import { dbService } from '../services/api';

export default function InterviewOutcome() {
  const navigate = useNavigate();
  const { interviewId } = useParams();
  const { addToast } = useCareConnex();
  const [selectedOutcome, setSelectedOutcome] = useState<'completed' | 'cancelled' | 'missed' | null>(null);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [interview, setInterview] = useState<{
    id: string;
    caregiverName: string;
    caregiverId: string;
    date: string;
    time: string;
    type: string;
    _collection: string;
  } | null>(null);

  useEffect(() => {
    if (!interviewId) { setLoading(false); return; }

    const findInterview = async () => {
      const fdb = db;
      if (!fdb) { setLoading(false); return; }
      const candidates = ['video_interviews', 'interview_requests', 'interviews'];
      for (const collection of candidates) {
        try {
          const doc = await fdb.collection(collection).doc(interviewId).get();
          if (doc.exists) {
            const d = doc.data()!;
            const scheduledDate = d.scheduledDate?.toDate?.()
              || (d.scheduledTime ? new Date(d.scheduledTime) : null);
            setInterview({
              id: doc.id,
              caregiverName: d.caregiverName || 'Unknown Caregiver',
              caregiverId: d.caregiverId || d.caregiverUid || '',
              date: d.date || (scheduledDate ? scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''),
              time: d.time || (scheduledDate ? scheduledDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''),
              type: d.type || 'video',
              _collection: collection
            });
            setLoading(false);
            return;
          }
        } catch {
          // Try next collection
        }
      }
      setLoading(false);
    };

    findInterview();
  }, [interviewId]);

  const handleSubmit = async () => {
    if (!selectedOutcome) {
      addToast('Please select an outcome before submitting.', 'error');
      return;
    }
    if (!interview) return;

    try {
      const fdb = db;
      if (!auth || !fdb) {
        addToast('Failed to submit outcome. Please try again.', 'error');
        return;
      }
      const user = auth.currentUser;
      if (!user) {
        navigate('/login');
        return;
      }

      await fdb.collection(interview._collection).doc(interviewId).update({
        status: selectedOutcome,
        outcomeNotes: notes,
        outcomeSubmittedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      if (interview.caregiverId) {
        const outcomeLabel = selectedOutcome === 'completed' ? 'marked completed'
          : selectedOutcome === 'cancelled' ? 'marked cancelled'
          : 'marked as missed';
        try {
          await dbService.createNotification({
            userId: interview.caregiverId,
            type: 'interview_outcome',
            title: `Interview ${outcomeLabel}`,
            message: notes
              ? `Your interview has been ${outcomeLabel}. Notes: ${notes}`
              : `Your interview has been ${outcomeLabel} by the client.`,
            data: { interviewId, outcome: selectedOutcome }
          });
        } catch { /* non-critical */ }
      }

      setSubmitted(true);
    } catch (error) {
      console.error('Error submitting outcome:', error);
      addToast('Failed to submit outcome. Please try again.', 'error');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
      </div>
    );
  }

  if (!interview) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          <AlertCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">Interview Not Found</h2>
          <p className="text-slate-600 mb-6">This interview record could not be found.</p>
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
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Outcome Recorded!</h2>
          <p className="text-slate-600 mb-6">
            {selectedOutcome === 'completed' 
              ? "Great! You can now hire this caregiver or continue browsing."
              : selectedOutcome === 'cancelled'
              ? "The interview has been marked as cancelled."
              : "The interview has been marked as missed."}
          </p>
          <div className="space-y-3">
            {selectedOutcome === 'completed' && (
              <button
                onClick={() => navigate(`/client/hire/${interview.caregiverId}`)}
                className="w-full py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
              >
                Hire Caregiver
              </button>
            )}
            <button
              onClick={() => navigate('/client/find-caregivers')}
              className="w-full py-3 border border-slate-200 text-slate-700 font-medium rounded-xl hover:bg-slate-50 transition-colors"
            >
              Continue Browsing
            </button>
            <button
              onClick={() => navigate('/client/dashboard')}
              className="w-full py-3 text-slate-500 font-medium hover:text-slate-700 transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      <div className="max-w-2xl mx-auto py-8 px-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Interview Outcome</h1>
            <p className="text-slate-600">Record what happened with your interview</p>
          </div>
        </div>

        {/* Interview Summary */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center">
              <User className="w-7 h-7 text-primary-600" />
            </div>
            <div>
              <h2 className="font-bold text-slate-900 text-lg">{interview.caregiverName}</h2>
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Calendar className="w-4 h-4" />
                <span>{interview.date}{interview.time ? ` at ${interview.time}` : ''}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Outcome Options */}
        <div className="space-y-4 mb-6">
          <h3 className="text-lg font-bold text-slate-900">What happened?</h3>

          {/* Completed */}
          <button
            onClick={() => setSelectedOutcome('completed')}
            className={`w-full p-6 rounded-2xl border-2 text-left transition-all ${
              selectedOutcome === 'completed'
                ? 'border-primary-500 bg-primary-50'
                : 'border-slate-200 bg-white hover:border-primary-200'
            }`}
          >
            <div className="flex items-start gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                selectedOutcome === 'completed' ? 'bg-primary-500' : 'bg-green-100'
              }`}>
                <CheckCircle className={`w-6 h-6 ${
                  selectedOutcome === 'completed' ? 'text-white' : 'text-green-600'
                }`} />
              </div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-900 text-lg mb-1">Completed</h4>
                <p className="text-slate-600">The interview happened as scheduled. You're ready to hire or continue browsing.</p>
              </div>
            </div>
          </button>

          {/* Cancelled */}
          <button
            onClick={() => setSelectedOutcome('cancelled')}
            className={`w-full p-6 rounded-2xl border-2 text-left transition-all ${
              selectedOutcome === 'cancelled'
                ? 'border-accent-500 bg-accent-50'
                : 'border-slate-200 bg-white hover:border-accent-200'
            }`}
          >
            <div className="flex items-start gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                selectedOutcome === 'cancelled' ? 'bg-accent-500' : 'bg-accent-100'
              }`}>
                <XCircle className={`w-6 h-6 ${
                  selectedOutcome === 'cancelled' ? 'text-white' : 'text-accent-600'
                }`} />
              </div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-900 text-lg mb-1">Cancelled</h4>
                <p className="text-slate-600">The interview was cancelled by you or the caregiver before it happened.</p>
              </div>
            </div>
          </button>

          {/* Missed */}
          <button
            onClick={() => setSelectedOutcome('missed')}
            className={`w-full p-6 rounded-2xl border-2 text-left transition-all ${
              selectedOutcome === 'missed'
                ? 'border-red-500 bg-red-50'
                : 'border-slate-200 bg-white hover:border-red-200'
            }`}
          >
            <div className="flex items-start gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                selectedOutcome === 'missed' ? 'bg-red-500' : 'bg-red-100'
              }`}>
                <AlertCircle className={`w-6 h-6 ${
                  selectedOutcome === 'missed' ? 'text-white' : 'text-red-600'
                }`} />
              </div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-900 text-lg mb-1">Missed / No Show</h4>
                <p className="text-slate-600">The interview did not happen. Either you or the caregiver didn't attend.</p>
              </div>
            </div>
          </button>
        </div>

        {/* Notes */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <h3 className="text-lg font-bold text-slate-900 mb-3">Notes (Optional)</h3>
          <p className="text-sm text-slate-500 mb-3">Add any details about what happened</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Example: Interview went well. Caregiver was professional and experienced..."
            className="w-full h-32 px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-4">
          <button
            onClick={() => navigate('/client/interviews')}
            className="flex-1 py-4 border border-slate-200 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Back to Interviews
          </button>
          <button
            onClick={handleSubmit}
            disabled={!selectedOutcome}
            className="flex-1 py-4 bg-gradient-to-r from-primary-600 to-blue-600 text-white font-bold rounded-xl hover:from-primary-700 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Submit Outcome
          </button>
        </div>
      </div>
    </div>
  );
}
