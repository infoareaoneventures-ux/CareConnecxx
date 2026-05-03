import React, { useState, useEffect } from 'react';
import { useCareConnex } from '../../context/CareConnexContext';
import { 
  Users, Search, Filter, CheckCircle, XCircle, Clock, 
  Phone, Mail, MapPin, Calendar, Star, Briefcase,
  ChevronRight, Loader2, UserCheck, MessageSquare
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { 
  MatchAssignment, 
  ApprovedMatch, 
  AIMatchSuggestion, 
  CareNeed,
  ClientIntakeData 
} from '../../types';
import { dbService } from '../../services/api';
import { getFunctions, httpsCallable } from 'firebase/functions';

interface MatchingDashboardProps {
  coordinatorId: string;
}

export const MatchingDashboard: React.FC<MatchingDashboardProps> = ({
  coordinatorId }) => {
  const { addToast } = useCareConnex();
  const [assignments, setAssignments] = useState<MatchAssignment[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<MatchAssignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningMatching, setRunningMatching] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadAssignments();
  }, []);

  const loadAssignments = async () => {
    setLoading(true);
    try {
      const data = await dbService.getMatchAssignments();
      setAssignments(data);
    } catch (error) {
      console.error('Failed to load assignments:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredAssignments = assignments.filter(assignment => {
    const matchesStatus = filterStatus === 'all' || assignment.status === filterStatus;
    const matchesSearch = searchQuery === '' || 
      assignment.clientId.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'bg-red-100 text-red-700 border-red-200';
      case 'high': return 'bg-accent-100 text-accent-700 border-accent-200';
      case 'medium': return 'bg-blue-100 text-blue-700 border-blue-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending_review': return 'bg-accent-100 text-accent-700';
      case 'in_review': return 'bg-blue-100 text-blue-700';
      case 'matches_ready': return 'bg-blue-100 text-blue-700';
      case 'sent_to_client': return 'bg-green-100 text-green-700';
      case 'interviewing': return 'bg-indigo-100 text-indigo-700';
      case 'hire_requested': return 'bg-teal-100 text-teal-700';
      case 'completed': return 'bg-slate-100 text-slate-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Matching Dashboard</h1>
            <p className="text-slate-500 text-sm mt-1">Review care needs and match clients with caregivers</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-slate-100 rounded-lg p-1">
              <button
                onClick={() => setFilterStatus('all')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  filterStatus === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setFilterStatus('pending_review')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  filterStatus === 'pending_review' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pending
              </button>
              <button
                onClick={() => setFilterStatus('interviewing')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  filterStatus === 'interviewing' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Interviewing
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search clients..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Three Panel Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Panel 1: Queue */}
        <div className="w-80 bg-white border-r border-slate-200 overflow-y-auto">
          <div className="p-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">Matching Queue</h2>
            <p className="text-sm text-slate-500">{filteredAssignments.length} clients</p>
          </div>
          
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredAssignments.map((assignment) => (
                <button
                  key={assignment.id}
                  onClick={() => setSelectedAssignment(assignment)}
                  className={`w-full p-4 text-left hover:bg-slate-50 transition-colors ${
                    selectedAssignment?.id === assignment.id ? 'bg-blue-50 border-l-4 border-blue-600' : ''
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${getPriorityColor(assignment.priority)}`}>
                      {assignment.priority}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(assignment.status)}`}>
                      {assignment.status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="font-medium text-slate-900">{assignment.clientId.slice(0, 8)}...</p>
                  <p className="text-sm text-slate-500 mt-1">
                    {assignment.careNeeds.length} care needs
                  </p>
                  <p className="text-xs text-slate-400 mt-2">
                    {new Date(assignment.createdAt).toLocaleDateString()}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Panel 2: Client Profile */}
        <div className="w-96 bg-white border-r border-slate-200 overflow-y-auto">
          {selectedAssignment ? (
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-slate-900">Client Profile</h2>
                <button
                  onClick={() => {}}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  View Intake
                </button>
              </div>

              {/* Care Needs */}
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-3">
                  Care Needs
                </h3>
                <div className="space-y-2">
                  {selectedAssignment.careNeeds.map((need, index) => (
                    <div key={index} className="bg-slate-50 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-slate-900 capitalize">
                          {need.category.replace('_', ' ')}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          need.priority === 'required' ? 'bg-red-100 text-red-700' :
                          need.priority === 'preferred' ? 'bg-blue-100 text-blue-700' :
                          'bg-slate-100 text-slate-700'
                        }`}>
                          {need.priority}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600">{need.description}</p>
                      <p className="text-xs text-slate-400 mt-1 capitalize">
                        {need.frequency}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Status Actions */}
              <div className="space-y-3">
                {selectedAssignment.status === 'pending_review' && (
                  <Button 
                    fullWidth
                    onClick={() => {}}
                  >
                    Start Review
                  </Button>
                )}
                {selectedAssignment.status === 'in_review' && (
                  <Button 
                    fullWidth
                    onClick={async () => {
                      if (!selectedAssignment) return;
                      setRunningMatching(true);
                      try {
                        const functions = getFunctions();
                        const runAiMatching = httpsCallable(functions, 'runAiMatching');
                        const result = await runAiMatching({ 
                          matchAssignmentId: selectedAssignment.id 
                        });
                        
                        // Reload to get updated matches
                        await loadAssignments();
                        
                        // Update selected assignment
                        const updated = await dbService.getMatchAssignments({ 
                          status: selectedAssignment.status 
                        });
                        const found = updated.find(a => a.id === selectedAssignment.id);
                        if (found) {
                          setSelectedAssignment(found);
                        }
                        
                        addToast(`AI Matching Complete — ${(result.data as any).matchesFound} matches found.`, 'success');
                      } catch (error) {
                        console.error('Failed to run matching:', error);
                        addToast('Failed to run matching algorithm. Please try again.', 'error');
                      } finally {
                        setRunningMatching(false);
                      }
                    }}
                    disabled={runningMatching}
                  >
                    {runningMatching ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Running...</>
                    ) : (
                      'Run AI Matching Algorithm'
                    )}
                  </Button>
                )}
                {selectedAssignment.status === 'matches_ready' && (
                  <Button 
                    fullWidth
                    onClick={() => {}}
                  >
                    Send Matches to Client
                  </Button>
                )}
              </div>

              {/* Notes */}
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-3">
                  Coordinator Notes
                </h3>
                <textarea
                  value={selectedAssignment.notes}
                  onChange={() => {}}
                  placeholder="Add notes about this client..."
                  className="w-full p-3 border border-slate-200 rounded-lg text-sm resize-none h-24 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400">
              Select a client to view profile
            </div>
          )}
        </div>

        {/* Panel 3: Match Review */}
        <div className="flex-1 bg-slate-50 overflow-y-auto">
          {selectedAssignment ? (
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-slate-900">Match Review</h2>
                {selectedAssignment.aiSuggestedMatches.length > 0 && (
                  <span className="text-sm text-slate-500">
                    {selectedAssignment.aiSuggestedMatches.length} AI suggestions
                  </span>
                )}
              </div>

              {/* AI Suggestions */}
              {selectedAssignment.aiSuggestedMatches.length > 0 && (
                <div className="mb-8">
                  <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-4">
                    AI-Suggested Matches
                  </h3>
                  <div className="space-y-4">
                    {selectedAssignment.aiSuggestedMatches.map((match) => (
                      <MatchSuggestionCard 
                        key={match.caregiverId} 
                        match={match}
                        isApproved={selectedAssignment.approvedMatches.some(m => m.caregiverId === match.caregiverId)}
                        onApprove={() => {}}
                        onReject={() => {}}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Approved Matches */}
              {selectedAssignment.approvedMatches.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider mb-4">
                    Pre-Confirmed Matches ({selectedAssignment.approvedMatches.length}/5)
                  </h3>
                  <div className="space-y-3">
                    {selectedAssignment.approvedMatches.map((match, index) => (
                      <ApprovedMatchCard 
                        key={match.caregiverId} 
                        match={match} 
                        rank={index + 1}
                      />
                    ))}
                  </div>
                  
                  {selectedAssignment.approvedMatches.length === 5 && (
                    <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                      <div className="flex items-center gap-3">
                        <CheckCircle className="w-5 h-5 text-green-600" />
                        <div>
                          <p className="font-medium text-green-900">Ready to Send</p>
                          <p className="text-sm text-green-700">
                            All 5 caregivers pre-confirmed. Send to client?
                          </p>
                        </div>
                      </div>
                      <Button 
                        className="mt-3 w-full"
                        onClick={() => {}}
                      >
                        Send Matches to Client
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {selectedAssignment.aiSuggestedMatches.length === 0 && 
               selectedAssignment.approvedMatches.length === 0 && (
                <div className="text-center py-12">
                  <Briefcase className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-500 mb-4">No matches yet</p>
                  <Button onClick={() => {}}>
                    Run Matching Algorithm
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400">
              Select a client to review matches
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Sub-components

interface MatchSuggestionCardProps {
  match: AIMatchSuggestion;
  isApproved: boolean;
  onApprove: () => void;
  onReject: () => void;
}

const MatchSuggestionCard: React.FC<MatchSuggestionCardProps> = ({ 
  match, 
  isApproved, 
  onApprove, 
  onReject 
}) => {
  const [showDetails, setShowDetails] = useState(false);

  if (isApproved) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
            <UserCheck className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h4 className="font-semibold text-slate-900">{match.caregiverName}</h4>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-2xl font-bold text-blue-600">{match.matchScore}</span>
              <span className="text-sm text-slate-500">match score</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onApprove}
            className="p-2 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors"
            title="Pre-confirm"
          >
            <CheckCircle className="w-5 h-5" />
          </button>
          <button
            onClick={onReject}
            className="p-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
            title="Skip"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>
      </div>

      <button
        onClick={() => setShowDetails(!showDetails)}
        className="text-sm text-blue-600 hover:text-blue-700 mt-3 flex items-center gap-1"
      >
        {showDetails ? 'Hide' : 'Show'} details
        <ChevronRight className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-90' : ''}`} />
      </button>

      {showDetails && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">Why this match:</p>
              <ul className="space-y-1">
                {match.reasoning.map((reason, i) => (
                  <li key={i} className="text-sm text-slate-600 flex items-start gap-2">
                    <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
            
            {match.redFlags && match.redFlags.length > 0 && (
              <div className="bg-accent-50 rounded-lg p-3">
                <p className="text-sm font-medium text-accent-800 mb-1">Considerations:</p>
                <ul className="space-y-1">
                  {match.redFlags.map((flag, i) => (
                    <li key={i} className="text-sm text-accent-700 flex items-start gap-2">
                      <Clock className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      {flag}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-slate-50 rounded-lg p-2">
                <p className="text-lg font-semibold text-slate-900">
                  {match.predictiveFactors.successProbability}%
                </p>
                <p className="text-xs text-slate-500">Success</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-2">
                <p className="text-lg font-semibold text-slate-900">
                  {match.predictiveFactors.acceptanceLikelihood}%
                </p>
                <p className="text-xs text-slate-500">Acceptance</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-2">
                <p className="text-lg font-semibold text-slate-900">
                  {match.predictiveFactors.retentionProbability}%
                </p>
                <p className="text-xs text-slate-500">Retention</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface ApprovedMatchCardProps {
  match: ApprovedMatch;
  rank: number;
}

const ApprovedMatchCard: React.FC<ApprovedMatchCardProps> = ({ match, rank }) => {
  return (
    <div className="bg-white rounded-xl border-2 border-green-200 p-4">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center font-bold text-green-700">
          {rank}
        </div>
        <div className="flex-1">
          <h4 className="font-semibold text-slate-900">{match.caregiverName}</h4>
          <p className="text-sm text-green-600 flex items-center gap-1">
            <CheckCircle className="w-4 h-4" />
            Pre-confirmed
          </p>
        </div>
        <Badge variant="success">Ready</Badge>
      </div>
      {match.coordinatorNotes && (
        <p className="mt-3 text-sm text-slate-600 bg-slate-50 rounded-lg p-2">
          <span className="font-medium">Note:</span> {match.coordinatorNotes}
        </p>
      )}
    </div>
  );
};
