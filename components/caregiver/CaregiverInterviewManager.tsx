import React, { useState, useEffect } from 'react';
import { 
  Calendar, Clock, MapPin, User, Phone, Video, MessageSquare, 
  CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronUp,
  Loader2, Star, Briefcase, Heart
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { InterviewRequest, CareNeed } from '../../types';
import { dbService } from '../../services/api';
import { AddToastFunction } from '../../types';
import { db } from '../../lib/firebase';
import { useCareConnex } from '../../context/CareConnexContext';

interface CaregiverInterviewManagerProps {
  caregiverId: string;
  onShowToast: AddToastFunction;
}

export const CaregiverInterviewManager: React.FC<CaregiverInterviewManagerProps> = ({
  caregiverId,
  onShowToast
}) => {
  const { currentUser } = useCareConnex();
  const [interviews, setInterviews] = useState<InterviewRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedInterview, setSelectedInterview] = useState<InterviewRequest | null>(null);
  const [showResponseModal, setShowResponseModal] = useState(false);
  const [responseType, setResponseType] = useState<'accept' | 'decline' | null>(null);
  const [caregiverNotes, setCaregiverNotes] = useState('');
  const [selectedTime, setSelectedTime] = useState('');
  const [alternativeTimes, setAlternativeTimes] = useState<string[]>([]);

  useEffect(() => {
    if (!caregiverId) return;
    setLoading(true);

    // Subscribe to interview_requests (AI matching / formal flow)
    const unsub1 = db!.collection('interview_requests')
      .where('caregiverId', '==', caregiverId)
      .orderBy('createdAt', 'desc')
      .onSnapshot((snap: any) => {
        const formal: InterviewRequest[] = snap.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
        setInterviews(prev => {
          const videoOnly = prev.filter((i: any) => i._source === 'video_interviews');
          return mergeInterviews(formal, videoOnly);
        });
        setLoading(false);
      }, () => setLoading(false));

    // Also subscribe to video_interviews (client-scheduled via ScheduleInterviewModal)
    const unsub2 = db!.collection('video_interviews')
      .where('caregiverId', '==', caregiverId)
      .orderBy('scheduledTime', 'desc')
      .onSnapshot((snap: any) => {
        const videoInterviews: InterviewRequest[] = snap.docs.map((doc: any) => {
          const d = doc.data();
          const dt = d.scheduledTime ? new Date(d.scheduledTime) : new Date();
          return {
            id: doc.id,
            clientId: d.clientId || '',
            clientName: d.clientName || 'Client',
            caregiverId: d.caregiverId || '',
            caregiverName: d.caregiverName || '',
            type: 'video' as const,
            proposedTimes: [d.scheduledTime || dt.toISOString()],
            status: d.status === 'requested' ? 'pending' : (d.status || 'pending'),
            createdAt: d.createdAt || dt.toISOString(),
            notes: d.notes,
            _source: 'video_interviews'
          } as any;
        });
        setInterviews(prev => {
          const formalOnly = prev.filter((i: any) => i._source !== 'video_interviews');
          return mergeInterviews(formalOnly, videoInterviews);
        });
        setLoading(false);
      }, () => {});

    return () => { unsub1(); unsub2(); };
  }, [caregiverId]);

  function mergeInterviews(a: InterviewRequest[], b: InterviewRequest[]): InterviewRequest[] {
    const seen = new Set<string>();
    return [...a, ...b].filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; })
      .sort((x, y) => new Date(y.createdAt || 0).getTime() - new Date(x.createdAt || 0).getTime());
  }

  const loadInterviews = async () => { /* replaced by subscriptions */ };

  const handleRespond = async () => {
    if (!selectedInterview || !responseType) return;

    if (!(currentUser as any)?.verified) {
      onShowToast('Your account must be fully approved before you can respond to interview requests.', 'error');
      return;
    }

    try {
      const updates: any = {
        status: responseType === 'accept' ? 'scheduled' : 'declined',
        caregiverNotes: caregiverNotes,
        caregiverRespondedAt: new Date().toISOString()
      };

      if (responseType === 'accept') {
        updates.scheduledTime = selectedTime || selectedInterview.proposedTimes[0];
      }

      const isVideoInterview = (selectedInterview as any)._source === 'video_interviews';
      if (isVideoInterview) {
        await db!.collection('video_interviews').doc(selectedInterview.id).update(updates);
      } else {
        await dbService.updateInterviewRequest(selectedInterview.id, updates);
      }

      // Notify the client of the caregiver's response
      if (selectedInterview.clientId) {
        try {
          await dbService.createNotification({
            userId: selectedInterview.clientId,
            type: responseType === 'accept' ? 'interview_accepted' : 'interview_declined',
            title: responseType === 'accept' ? 'Interview Accepted!' : 'Interview Declined',
            message: responseType === 'accept'
              ? `Your interview request has been accepted. Check your messages to confirm the time.`
              : `The caregiver is unavailable for this interview. You can schedule with another caregiver.`,
            data: { interviewId: selectedInterview.id }
          });
        } catch (_) { /* non-critical */ }
      }

      onShowToast(
        responseType === 'accept'
          ? 'Interview accepted! Client has been notified.'
          : 'Interview declined.',
        'success'
      );

      setShowResponseModal(false);
      setSelectedInterview(null);
      setResponseType(null);
      setCaregiverNotes('');
      setSelectedTime('');
      loadInterviews();
    } catch (error) {
      onShowToast('Failed to respond to interview', 'error');
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="warning">Awaiting Your Response</Badge>;
      case 'scheduled':
        return <Badge variant="success">Accepted</Badge>;
      case 'completed':
        return <Badge variant="info">Completed</Badge>;
      case 'declined':
        return <Badge variant="secondary">Declined</Badge>;
      case 'cancelled':
        return <Badge variant="danger">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const pendingInterviews = interviews.filter(i => i.status === 'pending');
  const upcomingInterviews = interviews.filter(i => i.status === 'scheduled');
  const pastInterviews = interviews.filter(i => ['completed', 'declined', 'cancelled'].includes(i.status));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-2xl p-6 text-white">
        <h2 className="text-2xl font-bold mb-2">Interview Requests</h2>
        <p className="text-blue-100">
          Families want to meet you! Review their care needs and schedule interviews.
        </p>
        {pendingInterviews.length > 0 && (
          <div className="mt-4 flex items-center gap-2 bg-white/20 rounded-lg px-4 py-2 inline-flex">
            <AlertCircle className="w-5 h-5" />
            <span className="font-medium">{pendingInterviews.length} pending response{pendingInterviews.length !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Pending Interviews */}
      {pendingInterviews.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-primary-500" />
            Pending Your Response
          </h3>
          <div className="space-y-4">
            {pendingInterviews.map((interview) => (
              <InterviewCard
                key={interview.id}
                interview={interview}
                statusBadge={getStatusBadge(interview.status)}
                onRespond={() => {
                  setSelectedInterview(interview);
                  setShowResponseModal(true);
                }}
                showRespondButton={true}
              />
            ))}
          </div>
        </div>
      )}

      {/* Upcoming Interviews */}
      {upcomingInterviews.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-green-500" />
            Scheduled Interviews
          </h3>
          <div className="space-y-4">
            {upcomingInterviews.map((interview) => (
              <InterviewCard
                key={interview.id}
                interview={interview}
                statusBadge={getStatusBadge(interview.status)}
                showJoinButton={interview.type === 'video'}
              />
            ))}
          </div>
        </div>
      )}

      {/* Past Interviews */}
      {pastInterviews.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-slate-400" />
            Past Interviews
          </h3>
          <div className="space-y-4 opacity-75">
            {pastInterviews.map((interview) => (
              <InterviewCard
                key={interview.id}
                interview={interview}
                statusBadge={getStatusBadge(interview.status)}
              />
            ))}
          </div>
        </div>
      )}

      {interviews.length === 0 && (
        <div className="text-center py-12 bg-slate-50 rounded-2xl">
          <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-slate-900 mb-2">No Interview Requests Yet</h3>
          <p className="text-slate-500 max-w-md mx-auto">
            When families are interested in hiring you, they'll request an interview. 
            Make sure your profile is complete to increase your chances!
          </p>
        </div>
      )}

      {/* Response Modal */}
      {showResponseModal && selectedInterview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h3 className="text-xl font-bold text-slate-900 mb-4">
                Respond to Interview Request
              </h3>

              {/* Client Info */}
              <div className="bg-slate-50 rounded-xl p-4 mb-6">
                <h4 className="font-semibold text-slate-900 mb-2">Interview Details</h4>
                <div className="space-y-2 text-sm">
                  <p className="flex items-center gap-2">
                    <User className="w-4 h-4 text-slate-400" />
                    <span>Client ID: {selectedInterview.clientId.slice(0, 8)}...</span>
                  </p>
                  <p className="flex items-center gap-2">
                    {selectedInterview.type === 'video' ? (
                      <><Video className="w-4 h-4 text-slate-400" /> Video Call</>
                    ) : selectedInterview.type === 'phone' ? (
                      <><Phone className="w-4 h-4 text-slate-400" /> Phone Call</>
                    ) : (
                      <><MapPin className="w-4 h-4 text-slate-400" /> In Person</>
                    )}
                  </p>
                  <p className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-slate-400" />
                    {selectedInterview.duration} minutes
                  </p>
                </div>
              </div>

              {/* Proposed Times */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-slate-700 mb-3">
                  Client's Proposed Times
                </label>
                <div className="space-y-2">
                  {selectedInterview.proposedTimes.map((time, index) => (
                    <label
                      key={index}
                      className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        selectedTime === time
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="proposedTime"
                        value={time}
                        checked={selectedTime === time}
                        onChange={(e) => setSelectedTime(e.target.value)}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span className="font-medium">
                        {new Date(time).toLocaleString()}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Response Type */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-slate-700 mb-3">
                  Your Response
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setResponseType('accept')}
                    className={`p-4 rounded-xl border-2 text-center transition-colors ${
                      responseType === 'accept'
                        ? 'border-green-500 bg-green-50 text-green-700'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <CheckCircle className="w-6 h-6 mx-auto mb-2" />
                    <span className="font-medium">Accept</span>
                  </button>
                  <button
                    onClick={() => setResponseType('decline')}
                    className={`p-4 rounded-xl border-2 text-center transition-colors ${
                      responseType === 'decline'
                        ? 'border-red-500 bg-red-50 text-red-700'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <XCircle className="w-6 h-6 mx-auto mb-2" />
                    <span className="font-medium">Decline</span>
                  </button>
                </div>
              </div>

              {/* Notes */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Notes for Client (Optional)
                </label>
                <textarea
                  value={caregiverNotes}
                  onChange={(e) => setCaregiverNotes(e.target.value)}
                  placeholder={responseType === 'accept' 
                    ? "Looking forward to meeting you and learning more about your care needs..."
                    : "Thank you for considering me, but..."
                  }
                  className="w-full p-3 border border-slate-200 rounded-lg h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() => {
                    setShowResponseModal(false);
                    setSelectedInterview(null);
                    setResponseType(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  fullWidth
                  onClick={handleRespond}
                  disabled={!responseType || (responseType === 'accept' && !selectedTime)}
                  className={responseType === 'decline' ? 'bg-red-600 hover:bg-red-700' : ''}
                >
                  {responseType === 'accept' ? 'Confirm Acceptance' : 'Confirm Decline'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Interview Card Component
interface InterviewCardProps {
  interview: InterviewRequest;
  statusBadge: React.ReactNode;
  onRespond?: () => void;
  showRespondButton?: boolean;
  showJoinButton?: boolean;
}

const InterviewCard: React.FC<InterviewCardProps> = ({
  interview,
  statusBadge,
  onRespond,
  showRespondButton,
  showJoinButton
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
            <User className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h4 className="font-semibold text-slate-900">
              Interview Request
            </h4>
            <p className="text-sm text-slate-500">
              From client {interview.clientId.slice(0, 8)}...
            </p>
            <div className="flex items-center gap-2 mt-1">
              {statusBadge}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showRespondButton && (
            <Button onClick={onRespond}>
              Respond
            </Button>
          )}
          {showJoinButton && (
            <Button>
              <Video className="w-4 h-4 mr-2" />
              Join
            </Button>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            {expanded ? (
              <ChevronUp className="w-5 h-5 text-slate-400" />
            ) : (
              <ChevronDown className="w-5 h-5 text-slate-400" />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-slate-500 mb-1">Interview Type</p>
              <p className="font-medium text-slate-900 flex items-center gap-2">
                {interview.type === 'video' ? (
                  <><Video className="w-4 h-4" /> Video Call</>
                ) : interview.type === 'phone' ? (
                  <><Phone className="w-4 h-4" /> Phone Call</>
                ) : (
                  <><MapPin className="w-4 h-4" /> In Person</>
                )}
              </p>
            </div>
            <div>
              <p className="text-slate-500 mb-1">Duration</p>
              <p className="font-medium text-slate-900">{interview.duration} minutes</p>
            </div>
            {interview.scheduledTime && (
              <div>
                <p className="text-slate-500 mb-1">Scheduled For</p>
                <p className="font-medium text-slate-900">
                  {new Date(interview.scheduledTime).toLocaleString()}
                </p>
              </div>
            )}
            {interview.proposedTimes.length > 0 && !interview.scheduledTime && (
              <div>
                <p className="text-slate-500 mb-1">Proposed Times</p>
                <div className="space-y-1">
                  {interview.proposedTimes.map((time, i) => (
                    <p key={i} className="font-medium text-slate-900">
                      {new Date(time).toLocaleString()}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
          
          {interview.clientNotes && (
            <div className="mt-4 bg-slate-50 rounded-lg p-3">
              <p className="text-slate-500 text-sm mb-1">Client's Message:</p>
              <p className="text-slate-700 italic">"{interview.clientNotes}"</p>
            </div>
          )}
          
          {interview.caregiverNotes && (
            <div className="mt-4 bg-blue-50 rounded-lg p-3">
              <p className="text-slate-500 text-sm mb-1">Your Response:</p>
              <p className="text-slate-700">{interview.caregiverNotes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
