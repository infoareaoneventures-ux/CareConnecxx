import React, { useState, useEffect, useMemo } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { 
  Users, 
  Star, 
  Calendar, 
  MessageCircle, 
  Video,
  CheckCircle,
  AlertCircle,
  Loader2,
  TrendingUp,
  UserCheck,
  Shield,
  Sparkles,
  Clock
} from 'lucide-react';
import { dbService } from '../../services/api';
import { availabilityService } from '../../services/availabilityService';
import { Appointment, Caregiver } from '../../types';

interface CareTeamMember {
  id: string;
  caregiverId: string;
  name: string;
  imageUrl: string;
  rating: number;
  reviewCount: number;
  role: 'primary' | 'backup';
  specialties: string[];
  shiftCount: number;
  lastShiftDate?: string;
  nextShiftDate?: string;
  continuityScore: number;
  phoneNumber?: string;
  bio: string;
}

interface CareTeamData {
  clientId: string;
  seniorId: string;
  seniorName: string;
  primaryCaregiver: CareTeamMember;
  backupCaregivers: CareTeamMember[];
  assignmentDate: string;
  teamContinuityScore: number;
  totalShifts: number;
  shiftsWithTeam: number;
  familySatisfaction: number;
}

interface CareTeamProps {
  clientId: string;
  appointments: Appointment[];
  seniorName?: string;
  onBookCaregiver?: (caregiver: Caregiver) => void;
  onQuickRebook?: (caregiverId: string, suggestedDate: string, suggestedTime: string) => void;
}

interface ProactiveSuggestion {
  caregiverId: string;
  caregiverName: string;
  nextAvailableDate: string;
  nextAvailableTime: string;
  reason: string;
}

export const CareTeam: React.FC<CareTeamProps> = ({ 
  clientId, 
  appointments, 
  seniorName = 'Your Loved One',
  onBookCaregiver,
  onQuickRebook
}) => {
  const [caregiverDetails, setCaregiverDetails] = useState<Record<string, Caregiver>>({});
  const [loading, setLoading] = useState(true);
  const [selectedMember, setSelectedMember] = useState<CareTeamMember | null>(null);
  const [proactiveSuggestions, setProactiveSuggestions] = useState<ProactiveSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  // Derive care team from actual appointments
  const careTeam = useMemo(() => {
    if (appointments.length === 0) return null;

    // Count shifts per caregiver
    const caregiverStats: Record<string, {
      count: number;
      lastDate: string;
      nextDate: string | null;
    }> = {};

    const today = new Date().toISOString().split('T')[0];

    appointments.forEach(appt => {
      if (appt.status === 'completed' || appt.status === 'confirmed') {
        const id = appt.caregiverId.toString();
        if (!caregiverStats[id]) {
          caregiverStats[id] = { count: 0, lastDate: '', nextDate: null };
        }
        caregiverStats[id].count++;
        
        // Track last shift
        if (appt.date < today && appt.date > caregiverStats[id].lastDate) {
          caregiverStats[id].lastDate = appt.date;
        }
        
        // Track next upcoming shift
        if (appt.date >= today && (!caregiverStats[id].nextDate || appt.date < caregiverStats[id].nextDate)) {
          caregiverStats[id].nextDate = appt.date;
        }
      }
    });

    // Sort by shift count to determine primary vs backup
    const sortedCaregivers = Object.entries(caregiverStats)
      .sort((a, b) => b[1].count - a[1].count);

    if (sortedCaregivers.length === 0) return null;

    // Build team data
    const totalShifts = appointments.filter(a => 
      a.status === 'completed' || a.status === 'confirmed'
    ).length;

    const buildMember = ([id, stats]: [string, typeof caregiverStats[string]], index: number): CareTeamMember => {
      const caregiver = caregiverDetails[id];
      return {
        id,
        caregiverId: id,
        name: caregiver?.name || 'Unknown Caregiver',
        imageUrl: caregiver?.imageUrl || caregiver?.photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(caregiver?.name || 'CG')}&background=random`,
        rating: caregiver?.rating || 4.8,
        reviewCount: caregiver?.reviewCount || 12,
        role: index === 0 ? 'primary' : 'backup',
        specialties: caregiver?.skills || ['Personal Care', 'Companionship'],
        shiftCount: stats.count,
        lastShiftDate: stats.lastDate || undefined,
        nextShiftDate: stats.nextDate || undefined,
        continuityScore: Math.round((stats.count / totalShifts) * 100),
        bio: caregiver?.bio || `${caregiver?.name || 'This caregiver'} has experience in senior care and is dedicated to providing compassionate support.`,
      };
    };

    const primaryCaregiver = buildMember(sortedCaregivers[0], 0);
    const backupCaregivers = sortedCaregivers.slice(1).map((c, i) => buildMember(c, i + 1));

    // Calculate team continuity (shifts with primary + regular backups vs total)
    const teamShiftCount = sortedCaregivers.slice(0, 3).reduce((sum, [, stats]) => sum + stats.count, 0);

    return {
      clientId,
      seniorId: clientId,
      seniorName: seniorName,
      primaryCaregiver,
      backupCaregivers,
      assignmentDate: appointments[0]?.date || new Date().toISOString(),
      teamContinuityScore: Math.round((teamShiftCount / totalShifts) * 100) || 0,
      totalShifts,
      shiftsWithTeam: teamShiftCount,
      familySatisfaction: 4.8, // Could come from reviews
    };
  }, [appointments, caregiverDetails, clientId, seniorName]);

  // Fetch caregiver details
  useEffect(() => {
    const loadCaregiverDetails = async () => {
      setLoading(true);
      try {
        // Get unique caregiver IDs from appointments
        const caregiverIds = [...new Set(
          appointments
            .filter(a => a.status === 'completed' || a.status === 'confirmed')
            .map(a => a.caregiverId.toString())
        )];

        if (caregiverIds.length === 0) {
          setLoading(false);
          return;
        }

        // Fetch caregiver details
        const details: Record<string, Caregiver> = {};
        await Promise.all(
          caregiverIds.map(async (id) => {
            try {
              const caregiver = await dbService.getUser(id);
              if (caregiver) {
                details[id] = caregiver as unknown as Caregiver;
              }
            } catch (error) {
              console.error(`Failed to load caregiver ${id}:`, error);
            }
          })
        );

        setCaregiverDetails(details);
      } catch (error) {
        console.error('Failed to load care team:', error);
      } finally {
        setLoading(false);
      }
    };

    loadCaregiverDetails();
  }, [appointments]);

  const handleScheduleIntro = () => {
    // Navigate to schedule or open modal
    console.log('Schedule team intro');
  };

  const handleMessageCaregiver = (caregiverId: string) => {
    // Navigate to messaging
    console.log('Message caregiver:', caregiverId);
  };

  // Generate proactive suggestions based on caregiver availability
  useEffect(() => {
    const generateSuggestions = async () => {
      if (!careTeam || Object.keys(caregiverDetails).length === 0) return;
      
      setLoadingSuggestions(true);
      const suggestions: ProactiveSuggestion[] = [];
      
      // Check next 7 days for availability
      const today = new Date();
      const nextWeek = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() + i + 1);
        return d;
      });
      
      // Common time slots to check
      const timeSlots = ['09:00', '11:00', '14:00', '16:00'];
      
      // Check primary caregiver first, then backups
      const allCaregivers = [careTeam.primaryCaregiver, ...careTeam.backupCaregivers];
      
      for (const member of allCaregivers) {
        const caregiver = caregiverDetails[member.caregiverId];
        if (!caregiver) continue;
        
        // Find first available slot
        for (const date of nextWeek) {
          for (const time of timeSlots) {
            const isAvailable = await availabilityService.isAvailable(
              caregiver,
              date,
              time,
              3 // 3 hour default
            );
            
            if (isAvailable) {
              const dateStr = date.toISOString().split('T')[0];
              const formattedDate = date.toLocaleDateString('en-US', { 
                weekday: 'short', 
                month: 'short', 
                day: 'numeric' 
              });
              
              suggestions.push({
                caregiverId: member.caregiverId,
                caregiverName: member.name,
                nextAvailableDate: dateStr,
                nextAvailableTime: time,
                reason: member.role === 'primary' 
                  ? `${member.name} is your primary caregiver and is free ${formattedDate} at ${time}`
                  : `${member.name} from your backup team is available ${formattedDate} at ${time}`
              });
              
              // Only suggest first available slot per caregiver
              break;
            }
          }
          if (suggestions.find(s => s.caregiverId === member.caregiverId)) break;
        }
        
        // Limit to top 3 suggestions
        if (suggestions.length >= 3) break;
      }
      
      setProactiveSuggestions(suggestions);
      setLoadingSuggestions(false);
    };
    
    if (careTeam && Object.keys(caregiverDetails).length > 0) {
      generateSuggestions();
    }
  }, [careTeam, caregiverDetails]);

  const handleQuickRebook = (suggestion: ProactiveSuggestion) => {
    if (onQuickRebook) {
      onQuickRebook(suggestion.caregiverId, suggestion.nextAvailableDate, suggestion.nextAvailableTime);
    } else if (onBookCaregiver && caregiverDetails[suggestion.caregiverId]) {
      onBookCaregiver(caregiverDetails[suggestion.caregiverId]);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
      </div>
    );
  }

  if (!careTeam) {
    return (
      <div className="text-center py-12 bg-slate-50 rounded-2xl">
        <Users className="w-12 h-12 text-slate-400 mx-auto mb-4" />
        <p className="text-slate-600 font-medium">No care team yet</p>
        <p className="text-sm text-slate-500 mt-1">Your care team will appear here after your first booking.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Proactive Suggestions */}
      {proactiveSuggestions.length > 0 && (
        <Card className="p-6 bg-gradient-to-br from-accent-50 to-accent-50 border-accent-200">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-5 h-5 text-accent-600" />
            <h3 className="font-bold text-slate-900">Available Soon</h3>
          </div>
          
          <div className="space-y-3">
            {proactiveSuggestions.map((suggestion, index) => (
              <div 
                key={suggestion.caregiverId}
                className="flex items-center justify-between bg-white rounded-xl p-4 shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-accent-100 rounded-full flex items-center justify-center">
                    <Clock className="w-5 h-5 text-accent-600" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">
                      {suggestion.caregiverName} is free{' '}
                      {new Date(suggestion.nextAvailableDate).toLocaleDateString('en-US', { 
                        weekday: 'short', 
                        month: 'short', 
                        day: 'numeric' 
                      })}
                    </p>
                    <p className="text-sm text-slate-500">
                      at {suggestion.nextAvailableTime} • {index === 0 ? 'Your primary caregiver' : 'From your backup team'}
                    </p>
                  </div>
                </div>
                <Button 
                  size="sm" 
                  onClick={() => handleQuickRebook(suggestion)}
                  className="bg-accent-600 hover:bg-accent-700 text-white"
                >
                  Book Now
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Your Care Team</h2>
          <p className="text-slate-500">Dedicated caregivers for {careTeam.seniorName}</p>
        </div>
        <div className="text-right">
          <div className="flex items-center gap-2">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{careTeam.teamContinuityScore}%</p>
              <p className="text-xs text-slate-500">Continuity Score</p>
            </div>
          </div>
        </div>
      </div>

      {/* Primary Caregiver */}
      <Card className="p-6 border-2 border-primary-200 bg-gradient-to-br from-primary-50 to-white">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center">
              <UserCheck className="w-6 h-6 text-primary-600" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">Primary Caregiver</h3>
              <p className="text-sm text-slate-500">Your main caregiver</p>
            </div>
          </div>
          <span className="px-3 py-1 bg-primary-600 text-white text-xs font-semibold rounded-full">
            Primary
          </span>
        </div>

        <div className="flex items-start gap-4">
          <img
            src={careTeam.primaryCaregiver.imageUrl}
            alt={careTeam.primaryCaregiver.name}
            className="w-20 h-20 rounded-2xl object-cover"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-xl font-bold text-slate-900">{careTeam.primaryCaregiver.name}</h4>
              <div className="flex items-center text-accent-500">
                <Star className="w-4 h-4 fill-current" />
                <span className="text-sm font-semibold ml-1">{careTeam.primaryCaregiver.rating}</span>
              </div>
            </div>
            
            <p className="text-slate-600 text-sm mb-3">{careTeam.primaryCaregiver.bio}</p>
            
            <div className="flex flex-wrap gap-2 mb-3">
              {careTeam.primaryCaregiver.specialties.map((specialty) => (
                <span
                  key={specialty}
                  className="px-2 py-1 bg-primary-100 text-primary-700 text-xs rounded-full"
                >
                  {specialty}
                </span>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-slate-400">Shifts</p>
                <p className="font-semibold text-slate-900">{careTeam.primaryCaregiver.shiftCount}</p>
              </div>
              <div>
                <p className="text-slate-400">Continuity</p>
                <p className="font-semibold text-green-600">{careTeam.primaryCaregiver.continuityScore}%</p>
              </div>
              <div>
                <p className="text-slate-400">Next Shift</p>
                <p className="font-semibold text-slate-900">
                  {careTeam.primaryCaregiver.nextShiftDate 
                    ? new Date(careTeam.primaryCaregiver.nextShiftDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : 'Not scheduled'}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3 flex-wrap">
          <Button variant="secondary" size="sm">
            <MessageCircle className="w-4 h-4 mr-2" />
            Message
          </Button>
          <Button variant="secondary" size="sm">
            <Video className="w-4 h-4 mr-2" />
            Video Call
          </Button>
          <Button variant="secondary" size="sm">
            <Calendar className="w-4 h-4 mr-2" />
            View Schedule
          </Button>
          {onBookCaregiver && caregiverDetails[careTeam.primaryCaregiver.caregiverId] && (
            <Button 
              size="sm"
              onClick={() => onBookCaregiver(caregiverDetails[careTeam.primaryCaregiver.caregiverId])}
              className="bg-primary-600 hover:bg-primary-700 text-white"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Book {careTeam.primaryCaregiver.name}
            </Button>
          )}
        </div>
      </Card>

      {/* Backup Caregivers */}
      {careTeam.backupCaregivers.length > 0 && (
        <div>
          <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center">
            <Shield className="w-5 h-5 mr-2 text-blue-600" />
            Backup Team
          </h3>
          <div className="grid md:grid-cols-2 gap-4">
            {careTeam.backupCaregivers.map((caregiver) => (
              <Card 
                key={caregiver.id}
                className="p-4 cursor-pointer hover:shadow-lg transition-shadow"
                onClick={() => setSelectedMember(caregiver)}
              >
                <div className="flex items-start gap-3">
                  <img
                    src={caregiver.imageUrl}
                    alt={caregiver.name}
                    className="w-16 h-16 rounded-xl object-cover"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h4 className="font-bold text-slate-900 truncate">{caregiver.name}</h4>
                      <div className="flex items-center text-accent-500 text-sm">
                        <Star className="w-3 h-3 fill-current" />
                        <span className="ml-1">{caregiver.rating}</span>
                      </div>
                    </div>
                    
                    <p className="text-sm text-slate-500 mt-1 line-clamp-2">{caregiver.bio}</p>
                    
                    <div className="flex flex-wrap gap-1 mt-2">
                      {caregiver.specialties.slice(0, 2).map((specialty) => (
                        <span
                          key={specialty}
                          className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full"
                        >
                          {specialty}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center justify-between mt-3 text-sm">
                      <span className="text-slate-500">{caregiver.shiftCount} shifts</span>
                      <span className="text-green-600 font-medium">{caregiver.continuityScore}% continuity</span>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Team Stats */}
      <Card className="p-6">
        <h3 className="text-lg font-bold text-slate-900 mb-4">Team Performance</h3>
        <div className="grid md:grid-cols-4 gap-6">
          <div className="text-center">
            <p className="text-3xl font-bold text-primary-600">{careTeam.totalShifts}</p>
            <p className="text-sm text-slate-500">Total Shifts</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-green-600">{careTeam.shiftsWithTeam}</p>
            <p className="text-sm text-slate-500">With Your Team</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-blue-600">{careTeam.teamContinuityScore}%</p>
            <p className="text-sm text-slate-500">Continuity Score</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-accent-500">{careTeam.familySatisfaction}</p>
            <p className="text-sm text-slate-500">Your Rating</p>
          </div>
        </div>
        
        <div className="mt-6 bg-slate-50 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-slate-900">Why Continuity Matters</p>
              <p className="text-sm text-slate-600 mt-1">
                Having the same caregivers leads to better care quality, stronger relationships, 
                and more comfort for {careTeam.seniorName}. Your {careTeam.teamContinuityScore}% score is excellent!
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* Team Intro Session */}
      <Card className="p-6 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
            <Video className="w-6 h-6 text-blue-600" />
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-slate-900 mb-1">Schedule Team Introduction</h3>
            <p className="text-slate-600 text-sm mb-4">
              Meet all your caregivers together in a 30-minute video call. Walk through {careTeam.seniorName}'s 
              care plan, preferences, and get to know the team.
            </p>
            <Button onClick={handleScheduleIntro}>
              Schedule Intro Session
            </Button>
          </div>
        </div>
      </Card>

      {/* Caregiver Detail Modal */}
      {selectedMember && (
        <CaregiverDetailModal
          caregiver={selectedMember}
          onClose={() => setSelectedMember(null)}
          onMessage={handleMessageCaregiver}
        />
      )}
    </div>
  );
};

// Caregiver Detail Modal Component
interface CaregiverDetailModalProps {
  caregiver: CareTeamMember;
  onClose: () => void;
  onMessage: (caregiverId: string) => void;
}

const CaregiverDetailModal: React.FC<CaregiverDetailModalProps> = ({ 
  caregiver, 
  onClose,
  onMessage 
}) => (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <Card className="max-w-lg w-full max-h-[90vh] overflow-y-auto">
      <div className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-4">
            <img
              src={caregiver.imageUrl}
              alt={caregiver.name}
              className="w-20 h-20 rounded-2xl object-cover"
            />
            <div>
              <h3 className="text-xl font-bold text-slate-900">{caregiver.name}</h3>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex items-center text-accent-500">
                  <Star className="w-4 h-4 fill-current" />
                  <span className="font-semibold ml-1">{caregiver.rating}</span>
                </div>
                <span className="text-slate-400">({caregiver.reviewCount} reviews)</span>
              </div>
              <span className={`inline-block px-2 py-0.5 text-xs rounded-full mt-2 ${
                caregiver.role === 'primary' 
                  ? 'bg-primary-100 text-primary-700' 
                  : 'bg-blue-100 text-blue-700'
              }`}>
                {caregiver.role === 'primary' ? 'Primary Caregiver' : 'Backup Caregiver'}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        <p className="text-slate-600 mb-4">{caregiver.bio}</p>

        <div className="mb-4">
          <h4 className="font-semibold text-slate-900 mb-2">Specialties</h4>
          <div className="flex flex-wrap gap-2">
            {caregiver.specialties.map((specialty) => (
              <span
                key={specialty}
                className="px-3 py-1 bg-slate-100 text-slate-700 text-sm rounded-full"
              >
                {specialty}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-sm text-slate-500">Total Shifts</p>
            <p className="text-2xl font-bold text-slate-900">{caregiver.shiftCount}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-sm text-slate-500">Continuity Score</p>
            <p className="text-2xl font-bold text-green-600">{caregiver.continuityScore}%</p>
          </div>
        </div>

        <div className="flex gap-3">
          <Button 
            fullWidth
            onClick={() => onMessage(caregiver.caregiverId)}
          >
            <MessageCircle className="w-4 h-4 mr-2" />
            Send Message
          </Button>
          <Button 
            variant="secondary"
            fullWidth
          >
            <Calendar className="w-4 h-4 mr-2" />
            View Schedule
          </Button>
        </div>
      </div>
    </Card>
  </div>
);

export default CareTeam;
