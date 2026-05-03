import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, Clock, User, MessageSquare, Video, Phone, MapPin, CheckCircle, XCircle, Clock3, AlertCircle, ChevronRight } from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { ClientNavigation } from './client/ClientNavigation';

interface Interview {
  id: string;
  caregiverId: string;
  caregiverName: string;
  caregiverPhoto?: string;
  date: string;
  time: string;
  type: 'video' | 'phone' | 'in-person';
  status: 'pending' | 'accepted' | 'declined' | 'completed' | 'no-response' | 'cancelled';
  notes?: string;
}

export default function Interviews() {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState<'pending' | 'upcoming' | 'completed'>('pending');

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      navigate('/login');
      return;
    }

    // Real-time subscription against video_interviews (written by videoService.scheduleInterview)
    const unsubscribe = db.collection('video_interviews')
      .where('clientId', '==', user.uid)
      .orderBy('scheduledTime', 'desc')
      .onSnapshot(
        (snapshot) => {
          const data: Interview[] = snapshot.docs.map((doc) => {
            const d = doc.data();
            const dt = d.scheduledTime ? new Date(d.scheduledTime) : new Date();
            const date = dt.toISOString().split('T')[0];
            const time = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            return {
              id: doc.id,
              caregiverId: d.caregiverId || '',
              caregiverName: d.caregiverName || '',
              date,
              time,
              type: (d.interviewType as Interview['type']) || 'video',
              status: d.status === 'requested' ? 'pending' : (d.status as Interview['status']),
              notes: d.notes || undefined
            };
          });
          setInterviews(data);
          setLoading(false);
        },
        (error) => {
          console.error('Error fetching interviews:', error);
          setLoading(false);
        }
      );

    return () => unsubscribe();
  }, [navigate]);

  const handleMessage = (caregiverId: string) => {
    navigate(`/client/inbox?caregiver=${caregiverId}`);
  };

  const handleReschedule = (interviewId: string) => {
    // Open reschedule modal or navigate to reschedule page
    console.log('Reschedule interview:', interviewId);
  };

  const handleCancel = async (interviewId: string) => {
    if (!confirm('Are you sure you want to cancel this interview?')) return;

    try {
      // Update in Firestore
      await db.collection('video_interviews').doc(interviewId).update({
        status: 'cancelled',
        cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Update local state
      setInterviews(prev => prev.map(i => 
        i.id === interviewId ? { ...i, status: 'cancelled' } : i
      ));
    } catch (error) {
      console.error('Error cancelling interview:', error);
    }
  };

  const handleMarkCompleted = (interviewId: string) => {
    navigate(`/client/interview-feedback/${interviewId}`);
  };

  const getStatusColor = (status: Interview['status']) => {
    switch (status) {
      case 'accepted': return 'bg-green-100 text-green-700 border-green-200';
      case 'pending': return 'bg-accent-100 text-accent-700 border-accent-200';
      case 'declined': return 'bg-red-100 text-red-700 border-red-200';
      case 'completed': return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'no-response': return 'bg-slate-100 text-slate-700 border-slate-200';
      case 'cancelled': return 'bg-gray-100 text-gray-700 border-gray-200';
      default: return 'bg-slate-100 text-slate-700';
    }
  };

  const getStatusIcon = (status: Interview['status']) => {
    switch (status) {
      case 'accepted': return <CheckCircle className="w-4 h-4 text-green-600" />;
      case 'pending': return <Clock3 className="w-4 h-4 text-accent-600" />;
      case 'declined': return <XCircle className="w-4 h-4 text-red-600" />;
      case 'completed': return <CheckCircle className="w-4 h-4 text-blue-600" />;
      case 'no-response': return <AlertCircle className="w-4 h-4 text-slate-600" />;
      default: return <Clock3 className="w-4 h-4 text-slate-600" />;
    }
  };

  const getTypeIcon = (type: Interview['type']) => {
    switch (type) {
      case 'video': return <Video className="w-4 h-4" />;
      case 'phone': return <Phone className="w-4 h-4" />;
      case 'in-person': return <MapPin className="w-4 h-4" />;
    }
  };

  const filteredInterviews = interviews.filter(interview => {
    if (selectedTab === 'pending') {
      return interview.status === 'pending' || interview.status === 'accepted';
    } else if (selectedTab === 'upcoming') {
      return interview.status === 'accepted' && new Date(interview.date) >= new Date();
    } else if (selectedTab === 'completed') {
      return interview.status === 'completed' || interview.status === 'declined' || interview.status === 'no-response' || interview.status === 'cancelled';
    }
    return true;
  });

  const pendingCount = interviews.filter(i => i.status === 'pending').length;
  const upcomingCount = interviews.filter(i => i.status === 'accepted' && new Date(i.date) >= new Date()).length;
  const completedCount = interviews.filter(i => ['completed', 'declined', 'no-response', 'cancelled'].includes(i.status)).length;

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-slate-900">Interviews</h1>
          <p className="text-slate-500">Manage your caregiver interviews</p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          <button
            onClick={() => setSelectedTab('pending')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium whitespace-nowrap transition-colors ${
              selectedTab === 'pending'
                ? 'bg-primary-600 text-white'
                : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            <Clock3 className="w-4 h-4" />
            Pending ({pendingCount})
          </button>
          <button
            onClick={() => setSelectedTab('upcoming')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium whitespace-nowrap transition-colors ${
              selectedTab === 'upcoming'
                ? 'bg-primary-600 text-white'
                : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            <Calendar className="w-4 h-4" />
            Upcoming ({upcomingCount})
          </button>
          <button
            onClick={() => setSelectedTab('completed')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium whitespace-nowrap transition-colors ${
              selectedTab === 'completed'
                ? 'bg-primary-600 text-white'
                : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            <CheckCircle className="w-4 h-4" />
            Completed ({completedCount})
          </button>
        </div>

        {/* Interview List */}
        {filteredInterviews.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Calendar className="w-8 h-8 text-slate-400" />
            </div>
            <h3 className="text-lg font-medium text-slate-900 mb-2">No interviews</h3>
            <p className="text-slate-500 mb-4">
              {selectedTab === 'pending' && 'You have no pending interview requests.'}
              {selectedTab === 'upcoming' && 'You have no upcoming interviews.'}
              {selectedTab === 'completed' && 'You have no completed interviews yet.'}
            </p>
            {selectedTab === 'pending' && (
              <button
                onClick={() => navigate('/client/find-caregivers')}
                className="px-6 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors"
              >
                Find Caregivers
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filteredInterviews.map(interview => (
              <div
                key={interview.id}
                className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow"
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center">
                      <User className="w-7 h-7 text-primary-600" />
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-900 text-lg">{interview.caregiverName}</h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`flex items-center gap-1 text-sm font-medium px-3 py-1 rounded-full border ${getStatusColor(interview.status)}`}>
                          {getStatusIcon(interview.status)}
                          <span className="capitalize">{interview.status.replace('-', ' ')}</span>
                        </span>
                        <span className="flex items-center gap-1 text-sm text-slate-500">
                          {getTypeIcon(interview.type)}
                          <span className="capitalize">{interview.type}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => navigate(`/client/caregiver/${interview.caregiverId}`)}
                    className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                  >
                    <ChevronRight className="w-5 h-5 text-slate-400" />
                  </button>
                </div>

                {/* Details */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
                    <Calendar className="w-5 h-5 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Date</p>
                      <p className="font-medium text-slate-900">
                        {new Date(interview.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
                    <Clock className="w-5 h-5 text-slate-400" />
                    <div>
                      <p className="text-sm text-slate-500">Time</p>
                      <p className="font-medium text-slate-900">{interview.time}</p>
                    </div>
                  </div>
                </div>

                {interview.notes && (
                  <div className="mb-4 p-3 bg-accent-50 border border-accent-100 rounded-xl">
                    <p className="text-sm text-accent-800">
                      <strong>Notes:</strong> {interview.notes}
                    </p>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-3">
                  {interview.status === 'accepted' && (
                    <>
                      <button
                        onClick={() => handleMessage(interview.caregiverId)}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 border border-slate-200 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <MessageSquare className="w-4 h-4" />
                        Message
                      </button>
                      {new Date(interview.date) < new Date() && (
                        <button
                          onClick={() => handleMarkCompleted(interview.id)}
                          className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-primary-600 text-white rounded-xl font-medium hover:bg-primary-700 transition-colors"
                        >
                          <CheckCircle className="w-4 h-4" />
                          Mark Completed
                        </button>
                      )}
                    </>
                  )}
                  {interview.status === 'pending' && (
                    <>
                      <button
                        onClick={() => handleReschedule(interview.id)}
                        className="flex-1 py-2.5 border border-slate-200 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Reschedule
                      </button>
                      <button
                        onClick={() => handleCancel(interview.id)}
                        className="flex-1 py-2.5 border border-red-200 text-red-600 rounded-xl font-medium hover:bg-red-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {interview.status === 'completed' && (
                    <button
                      onClick={() => navigate(`/client/caregiver/${interview.caregiverId}`)}
                      className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl font-medium hover:bg-primary-700 transition-colors"
                    >
                      Hire Caregiver
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
