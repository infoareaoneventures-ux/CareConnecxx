import React, { useState, useEffect } from 'react';
import { 
  Users, Calendar, Clock, MapPin, Star, Phone, Video, 
  CheckCircle, ChevronRight, Loader2, MessageSquare,
  Briefcase, Heart
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { 
  ApprovedMatch, 
  InterviewRequest
} from '../../types';
import { dbService } from '../../services/api';
import { AddToastFunction } from '../../types';

interface ClientMatchingViewProps {
  clientId: string;
  seniorId: string;
  matchAssignmentId?: string;
  onShowToast: AddToastFunction;
}

export const ClientMatchingView: React.FC<ClientMatchingViewProps> = ({
  clientId,
  seniorId,
  matchAssignmentId,
  onShowToast
}) => {
  const [matches, setMatches] = useState<ApprovedMatch[]>([]);
  const [interviews, setInterviews] = useState<InterviewRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMatch, setSelectedMatch] = useState<ApprovedMatch | null>(null);
  const [showInterviewModal, setShowInterviewModal] = useState(false);
  const [showHireModal, setShowHireModal] = useState(false);
  const [interviewType, setInterviewType] = useState<'video' | 'phone' | 'in_person'>('video');
  const [proposedTimes, setProposedTimes] = useState<string[]>([]);
  const [interviewNotes, setInterviewNotes] = useState('');
  
  const [hireForm, setHireForm] = useState({
    startDate: '',
    days: [] as string[],
    startTime: '09:00',
    endTime: '13:00',
    serviceType: 'ongoing' as 'ongoing' | 'one_time' | 'respite',
    notes: ''
  });

  useEffect(() => {
    loadData();
  }, [clientId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [matchesData, interviewsData] = await Promise.all([
        dbService.getClientApprovedMatches(clientId),
        dbService.getInterviewRequests({ clientId })
      ]);
      setMatches(matchesData as any);
      setInterviews(interviewsData);
    } catch (error) {
      console.error('Failed to load matching data:', error);
      onShowToast('Failed to load your matches', 'error');
    } finally {
      setLoading(false);
    }
  };

  const getInterviewStatus = (caregiverId: string) => {
    const interview = interviews.find(i => i.caregiverId === caregiverId);
    if (!interview) return 'not_requested';
    return interview.status;
  };

  const getInterviewFeedback = (caregiverId: string) => {
    const interview = interviews.find(i => i.caregiverId === caregiverId);
    return interview?.clientFeedback;
  };

  const handleRequestInterview = async () => {
    if (!selectedMatch || !matchAssignmentId) return;
    
    try {
      await dbService.createInterviewRequest({
        clientId,
        seniorId,
        caregiverId: selectedMatch.caregiverId,
        matchAssignmentId,
        type: interviewType,
        proposedTimes,
        clientNotes: interviewNotes
      });
      
      onShowToast('Interview request sent!', 'success');
      setShowInterviewModal(false);
      setProposedTimes([]);
      setInterviewNotes('');
      loadData();
    } catch (error) {
      onShowToast('Failed to request interview', 'error');
    }
  };

  const handleSubmitFeedback = async (interviewId: string, fit: 'strong' | 'maybe' | 'no_match') => {
    try {
      await dbService.submitInterviewFeedback(interviewId, {
        fit,
        notes: ''
      });
      onShowToast('Feedback submitted!', 'success');
      loadData();
    } catch (error) {
      onShowToast('Failed to submit feedback', 'error');
    }
  };

  const handleHire = async () => {
    if (!selectedMatch || !matchAssignmentId) return;
    
    try {
      await dbService.submitHireRequest({
        clientId,
        seniorId,
        matchAssignmentId,
        caregiverId: selectedMatch.caregiverId,
        interviewedCaregiverIds: interviews
          .filter(i => i.status === 'completed')
          .map(i => i.caregiverId),
        proposedStartDate: hireForm.startDate,
        proposedSchedule: {
          days: hireForm.days,
          startTime: hireForm.startTime,
          endTime: hireForm.endTime
        },
        serviceType: hireForm.serviceType,
        clientNotes: hireForm.notes
      });
      
      onShowToast('Hire request sent to your coordinator!', 'success');
      setShowHireModal(false);
    } catch (error) {
      onShowToast('Failed to submit hire request', 'error');
    }
  };

  const completedInterviews = interviews.filter(i => i.status === 'completed').length;
  const canHire = completedInterviews >= 2;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="text-center py-12 bg-slate-50 rounded-2xl">
        <Users className="w-12 h-12 text-slate-300 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-slate-900 mb-2">Finding Your Caregivers</h3>
        <p className="text-slate-500 max-w-md mx-auto">
          Your care coordinator is reviewing your needs and will send you 5 matched caregivers within 48 hours.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Progress Tracker */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200">
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Your Care Journey</h3>
        <div className="flex items-center justify-between">
          {[
            { label: 'Intake', complete: true },
            { label: 'Matches Ready', complete: matches.length > 0 },
            { label: 'Interviews', complete: completedInterviews > 0, count: completedInterviews },
            { label: 'Hire', complete: false }
          ].map((step, index) => (
            <div key={index} className="flex items-center">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                step.complete ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-400'
              }`}>
                {step.complete ? (
                  <CheckCircle className="w-5 h-5" />
                ) : (
                  <span className="text-sm font-medium">{index + 1}</span>
                )}
              </div>
              <div className="ml-3">
                <p className={`text-sm font-medium ${step.complete ? 'text-slate-900' : 'text-slate-500'}`}>
                  {step.label}
                </p>
                {step.count !== undefined && step.count > 0 && (
                  <p className="text-xs text-slate-500">{step.count} completed</p>
                )}
              </div>
              {index < 3 && (
                <ChevronRight className="w-5 h-5 text-slate-300 mx-4" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Matches Grid */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900">
            Your 5 Matched Caregivers
          </h3>
          <p className="text-sm text-slate-500">
            Selected by your care coordinator
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {matches.map((match, index) => {
            const interviewStatus = getInterviewStatus(match.caregiverId);
            const feedback = getInterviewFeedback(match.caregiverId);
            const isTopMatch = index === 0;

            return (
              <div 
                key={match.caregiverId}
                className={`bg-white rounded-2xl border-2 p-5 transition-all hover:shadow-lg ${
                  isTopMatch ? 'border-blue-200' : 'border-slate-200'
                }`}
              >
                {isTopMatch && (
                  <div className="flex items-center gap-2 mb-3">
                    <Star className="w-4 h-4 text-accent-500 fill-accent-500" />
                    <span className="text-sm font-medium text-accent-700">Top Match</span>
                  </div>
                )}

                <div className="flex items-center gap-3 mb-4">
                  <div className="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center">
                    <Users className="w-7 h-7 text-blue-600" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-slate-900">{match.caregiverName}</h4>
                    <p className="text-sm text-slate-500">Caregiver #{index + 1}</p>
                  </div>
                </div>

                {match.coordinatorNotes && (
                  <div className="bg-blue-50 rounded-lg p-3 mb-4">
                    <p className="text-sm text-blue-800">
                      <span className="font-medium">Coordinator note:</span> {match.coordinatorNotes}
                    </p>
                  </div>
                )}

                <div className="mb-4">
                  {interviewStatus === 'not_requested' && (
                    <Badge variant="secondary">Interview not requested</Badge>
                  )}
                  {interviewStatus === 'pending' && (
                    <Badge variant="warning">Interview pending</Badge>
                  )}
                  {interviewStatus === 'scheduled' && (
                    <Badge variant="info">Interview scheduled</Badge>
                  )}
                  {interviewStatus === 'completed' && (
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-green-700">Interview completed</span>
                    </div>
                  )}
                  {feedback && (
                    <div className={`mt-2 text-sm ${
                      feedback.fit === 'strong' ? 'text-green-600' :
                      feedback.fit === 'maybe' ? 'text-accent-600' :
                      'text-red-600'
                    }`}>
                      Your feedback: {feedback.fit.replace('_', ' ')}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {interviewStatus === 'not_requested' && (
                    <Button 
                      fullWidth
                      variant="outline"
                      onClick={() => {
                        setSelectedMatch(match);
                        setShowInterviewModal(true);
                      }}
                    >
                      <Calendar className="w-4 h-4 mr-2" />
                      Request Interview
                    </Button>
                  )}
                  
                  {interviewStatus === 'completed' && canHire && (
                    <Button 
                      fullWidth
                      onClick={() => {
                        setSelectedMatch(match);
                        setShowHireModal(true);
                      }}
                    >
                      <Heart className="w-4 h-4 mr-2" />
                      Hire {match.caregiverName}
                    </Button>
                  )}

                  <Button 
                    fullWidth
                    variant="secondary"
                    onClick={() => {}}
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    View Profile
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Interview Modal */}
      {showInterviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h3 className="text-xl font-bold text-slate-900 mb-4">
                Request Interview with {selectedMatch?.caregiverName}
              </h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Interview Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { type: 'video', icon: Video, label: 'Video' },
                      { type: 'phone', icon: Phone, label: 'Phone' },
                      { type: 'in_person', icon: MapPin, label: 'In Person' }
                    ].map(({ type, icon: Icon, label }) => (
                      <button
                        key={type}
                        onClick={() => setInterviewType(type as any)}
                        className={`p-3 rounded-lg border-2 text-center transition-colors ${
                          interviewType === type 
                            ? 'border-blue-500 bg-blue-50 text-blue-700' 
                            : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <Icon className="w-5 h-5 mx-auto mb-1" />
                        <span className="text-sm font-medium">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Preferred Times
                  </label>
                  <input
                    type="datetime-local"
                    onChange={(e) => {
                      if (e.target.value) {
                        setProposedTimes([...proposedTimes, e.target.value]);
                      }
                    }}
                    className="w-full p-3 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex flex-wrap gap-2 mt-2">
                    {proposedTimes.map((time, i) => (
                      <span key={i} className="text-sm bg-blue-100 text-blue-700 px-2 py-1 rounded">
                        {new Date(time).toLocaleString()}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    What would you like to discuss?
                  </label>
                  <textarea
                    value={interviewNotes}
                    onChange={(e) => setInterviewNotes(e.target.value)}
                    placeholder="e.g., Experience with dementia care, availability..."
                    className="w-full p-3 border border-slate-200 rounded-lg h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="flex gap-3 pt-4">
                  <Button 
                    variant="secondary" 
                    fullWidth
                    onClick={() => setShowInterviewModal(false)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    fullWidth
                    onClick={handleRequestInterview}
                    disabled={proposedTimes.length === 0}
                  >
                    Request Interview
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hire Modal */}
      {showHireModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h3 className="text-xl font-bold text-slate-900 mb-2">
                Hire {selectedMatch?.caregiverName}
              </h3>
              <p className="text-slate-500 mb-6">
                You're about to hire {selectedMatch?.caregiverName} as your caregiver. 
                Your coordinator will review and confirm.
              </p>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={hireForm.startDate}
                    onChange={(e) => setHireForm({ ...hireForm, startDate: e.target.value })}
                    className="w-full p-3 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Days Needed
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                      <button
                        key={day}
                        onClick={() => {
                          const days = hireForm.days.includes(day)
                            ? hireForm.days.filter(d => d !== day)
                            : [...hireForm.days, day];
                          setHireForm({ ...hireForm, days });
                        }}
                        className={`p-2 rounded-lg text-sm font-medium transition-colors ${
                          hireForm.days.includes(day)
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Start Time
                    </label>
                    <input
                      type="time"
                      value={hireForm.startTime}
                      onChange={(e) => setHireForm({ ...hireForm, startTime: e.target.value })}
                      className="w-full p-3 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      End Time
                    </label>
                    <input
                      type="time"
                      value={hireForm.endTime}
                      onChange={(e) => setHireForm({ ...hireForm, endTime: e.target.value })}
                      className="w-full p-3 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Service Type
                  </label>
                  <select
                    value={hireForm.serviceType}
                    onChange={(e) => setHireForm({ ...hireForm, serviceType: e.target.value as any })}
                    className="w-full p-3 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="ongoing">Ongoing Care</option>
                    <option value="one_time">One-time Visit</option>
                    <option value="respite">Respite Care</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Special Instructions
                  </label>
                  <textarea
                    value={hireForm.notes}
                    onChange={(e) => setHireForm({ ...hireForm, notes: e.target.value })}
                    placeholder="Any specific needs or requests..."
                    className="w-full p-3 border border-slate-200 rounded-lg h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="bg-slate-50 rounded-lg p-4 text-sm text-slate-600">
                  <p className="flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                    By hiring, you agree to CareConnex terms. Your coordinator will review and confirm within 24 hours.
                  </p>
                </div>

                <div className="flex gap-3 pt-4">
                  <Button 
                    variant="secondary" 
                    fullWidth
                    onClick={() => setShowHireModal(false)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    fullWidth
                    onClick={handleHire}
                    disabled={!hireForm.startDate || hireForm.days.length === 0}
                  >
                    Hire {selectedMatch?.caregiverName}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
