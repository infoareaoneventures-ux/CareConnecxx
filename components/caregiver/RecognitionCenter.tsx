import React, { useState, useEffect } from 'react';
import { 
  Trophy, 
  Medal, 
  Star, 
  Award, 
  Heart, 
  Users, 
  Clock, 
  Sparkles,
  ChevronRight,
  Gift,
  ThumbsUp,
  MessageCircle,
  Share2,
  Crown,
  Target,
  Zap,
  Calendar
} from 'lucide-react';
import { Button } from '../ui/Button';
import { dbService } from '../../services/api';
import { AddToastFunction } from '../../types';

interface RecognitionCenterProps {
  caregiverId: string;
  onShowToast: AddToastFunction;
}

interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  earnedAt?: string;
  progress?: number;
  maxProgress?: number;
}

interface Milestone {
  id: string;
  title: string;
  description: string;
  target: number;
  current: number;
  reward: string;
  completed: boolean;
}

interface CaregiverOfMonth {
  caregiverId: string;
  name: string;
  photo: string;
  month: string;
  year: number;
  stats: {
    hoursWorked: number;
    familiesHelped: number;
    rating: number;
    reviews: number;
  };
  highlights: string[];
}

interface PeerRecognition {
  id: string;
  fromCaregiverId: string;
  fromName: string;
  toCaregiverId: string;
  message: string;
  category: 'helpful' | 'inspiring' | 'teamplayer' | 'aboveandbeyond';
  createdAt: string;
}

/**
 * Recognition Center Component
 * Caregiver of the Month, badges, milestones, and peer recognition
 */
export const RecognitionCenter: React.FC<RecognitionCenterProps> = ({
  caregiverId,
  onShowToast
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'badges' | 'leaderboard'>('overview');
  const [badges, setBadges] = useState<Badge[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [caregiverOfMonth, setCaregiverOfMonth] = useState<CaregiverOfMonth | null>(null);
  const [peerRecognitions, setPeerRecognitions] = useState<PeerRecognition[]>([]);
  const [myStats, setMyStats] = useState({
    totalBadges: 0,
    goldBadges: 0,
    monthlyRanking: 0,
    points: 0,
    hoursThisMonth: 0,
    familiesHelped: 0
  });
  const [loading, setLoading] = useState(true);
  const [showGiveRecognition, setShowGiveRecognition] = useState(false);

  useEffect(() => {
    loadRecognitionData();
  }, [caregiverId]);

  const loadRecognitionData = async () => {
    try {
      setLoading(true);
      
      // Load badges
      const badgesData = await dbService.getCaregiverBadges?.(caregiverId) || getDefaultBadges();
      setBadges(badgesData);

      // Load milestones
      const milestonesData = await dbService.getCaregiverMilestones?.(caregiverId) || getDefaultMilestones();
      setMilestones(milestonesData);

      // Load caregiver of the month
      const cotmData = await dbService.getCaregiverOfMonth?.() || null;
      setCaregiverOfMonth(cotmData);

      // Load peer recognitions
      const recognitionsData = await dbService.getPeerRecognitions?.(caregiverId) || [];
      setPeerRecognitions(recognitionsData);

      // Calculate stats
      const earnedBadges = badgesData.filter(b => b.earnedAt);
      setMyStats({
        totalBadges: earnedBadges.length,
        goldBadges: earnedBadges.filter(b => b.tier === 'gold' || b.tier === 'platinum').length,
        monthlyRanking: 0, // Loaded from leaderboard separately
        points: earnedBadges.reduce((sum, b) => sum + (b.tier === 'platinum' ? 100 : b.tier === 'gold' ? 50 : b.tier === 'silver' ? 25 : 10), 0),
        hoursThisMonth: milestonesData.find(m => m.id === "hours_month")?.current ?? 0,
        familiesHelped: milestonesData.find(m => m.id === "families")?.current ?? 0
      });
    } catch (error) {
      console.error('Failed to load recognition data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getDefaultBadges = (): Badge[] => [
    { id: '1', name: 'First Shift', description: 'Complete your first care shift', icon: 'star', tier: 'bronze', progress: 0, maxProgress: 1 },
    { id: '2', name: 'Rising Star', description: 'Receive 5 five-star reviews', icon: 'star', tier: 'silver', progress: 0, maxProgress: 5 },
    { id: '3', name: 'Reliable', description: 'Complete 20 shifts on time', icon: 'clock', tier: 'silver', progress: 0, maxProgress: 20 },
    { id: '4', name: 'Hero Caregiver', description: 'Work 100+ hours in a month', icon: 'heart', tier: 'gold', progress: 0, maxProgress: 100 },
    { id: '5', name: 'Family Favorite', description: 'Be rehired by 5 different families', icon: 'users', tier: 'gold', progress: 0, maxProgress: 5 },
    { id: '6', name: 'Master Caregiver', description: 'Complete 500 care shifts', icon: 'trophy', tier: 'platinum', progress: 0, maxProgress: 500 },
  ];

  const getDefaultMilestones = (): Milestone[] => [
    { id: '1', title: 'First Week Complete', description: 'Complete your first week of care shifts', target: 1, current: 0, reward: '$50 Bonus', completed: false },
    { id: '2', title: 'Rising Star', description: 'Maintain a 4.8+ rating for 30 days', target: 30, current: 0, reward: 'Featured Profile', completed: false },
    { id: '3', title: 'Super Caregiver', description: 'Work 40+ hours for 4 consecutive weeks', target: 4, current: 0, reward: '$200 Bonus', completed: false },
    { id: '4', title: 'Client Champion', description: 'Get rehired by 10 different families', target: 10, current: 0, reward: 'Premium Badge', completed: false },
  ];

  const getTierColor = (tier: string) => {
    switch (tier) {
      case 'platinum': return 'from-slate-400 to-slate-300 border-slate-400';
      case 'gold': return 'from-yellow-400 to-primary-500 border-yellow-400';
      case 'silver': return 'from-slate-300 to-slate-400 border-slate-300';
      default: return 'from-primary-600 to-primary-700 border-primary-600';
    }
  };

  const getTierBg = (tier: string) => {
    switch (tier) {
      case 'platinum': return 'bg-slate-100 text-slate-700';
      case 'gold': return 'bg-yellow-100 text-yellow-700';
      case 'silver': return 'bg-slate-100 text-slate-600';
      default: return 'bg-primary-100 text-primary-700';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-teal-600 rounded-3xl p-6 text-white">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center">
              <Trophy className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-2xl font-bold">Recognition Center</h2>
              <p className="text-blue-100">Celebrate your achievements</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold">{myStats.points}</p>
            <p className="text-sm text-blue-100">Points Earned</p>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-4 gap-4 mt-6">
          <div className="bg-white/10 rounded-xl p-3 text-center">
            <Medal className="w-6 h-6 mx-auto mb-1" />
            <p className="text-xl font-bold">{myStats.totalBadges}</p>
            <p className="text-xs text-blue-100">Badges</p>
          </div>
          <div className="bg-white/10 rounded-xl p-3 text-center">
            <Star className="w-6 h-6 mx-auto mb-1" />
            <p className="text-xl font-bold">{myStats.goldBadges}</p>
            <p className="text-xs text-blue-100">Gold+</p>
          </div>
          <div className="bg-white/10 rounded-xl p-3 text-center">
            <Target className="w-6 h-6 mx-auto mb-1" />
            <p className="text-xl font-bold">#{myStats.monthlyRanking}</p>
            <p className="text-xs text-blue-100">Ranking</p>
          </div>
          <div className="bg-white/10 rounded-xl p-3 text-center">
            <Clock className="w-6 h-6 mx-auto mb-1" />
            <p className="text-xl font-bold">{myStats.hoursThisMonth}</p>
            <p className="text-xs text-blue-100">Hours</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 bg-slate-100 p-1 rounded-xl">
        {(['overview', 'badges', 'leaderboard'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Caregiver of the Month */}
          {caregiverOfMonth && (
            <div className="bg-gradient-to-br from-yellow-50 to-primary-50 border-2 border-yellow-200 rounded-3xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <Crown className="w-8 h-8 text-yellow-500" />
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Caregiver of the Month</h3>
                  <p className="text-sm text-slate-500">{caregiverOfMonth.month} {caregiverOfMonth.year}</p>
                </div>
              </div>

              <div className="flex items-center gap-4 bg-white rounded-2xl p-4">
                <img
                  src={caregiverOfMonth.photo}
                  alt={caregiverOfMonth.name}
                  className="w-20 h-20 rounded-2xl object-cover"
                />
                <div className="flex-1">
                  <h4 className="text-lg font-bold text-slate-900">{caregiverOfMonth.name}</h4>
                  <div className="flex flex-wrap gap-3 mt-2">
                    <span className="px-3 py-1 bg-yellow-100 text-yellow-700 rounded-full text-sm font-medium">
                      {caregiverOfMonth.stats.hoursWorked} hours
                    </span>
                    <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">
                      {caregiverOfMonth.stats.familiesHelped} families
                    </span>
                    <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                      {caregiverOfMonth.stats.rating} ★
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {caregiverOfMonth.highlights.map((highlight, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm text-slate-700">
                    <Sparkles className="w-4 h-4 text-yellow-500" />
                    {highlight}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Badges */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900">Recent Badges</h3>
              <button 
                onClick={() => setActiveTab('badges')}
                className="text-primary-600 text-sm font-medium flex items-center gap-1"
              >
                View All <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-4">
              {badges.filter(b => b.earnedAt).slice(0, 3).map(badge => (
                <div 
                  key={badge.id} 
                  className={`p-4 rounded-2xl border-2 ${getTierBg(badge.tier)} text-center`}
                >
                  <div className={`w-12 h-12 mx-auto mb-2 rounded-xl bg-gradient-to-br ${getTierColor(badge.tier)} flex items-center justify-center`}>
                    {badge.icon === 'star' && <Star className="w-6 h-6 text-white" />}
                    {badge.icon === 'clock' && <Clock className="w-6 h-6 text-white" />}
                    {badge.icon === 'heart' && <Heart className="w-6 h-6 text-white" />}
                    {badge.icon === 'users' && <Users className="w-6 h-6 text-white" />}
                    {badge.icon === 'trophy' && <Trophy className="w-6 h-6 text-white" />}
                  </div>
                  <p className="font-semibold text-sm">{badge.name}</p>
                  <p className="text-xs capitalize opacity-70">{badge.tier}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Active Milestones */}
          <div>
            <h3 className="text-lg font-bold text-slate-900 mb-4">Active Milestones</h3>
            <div className="space-y-3">
              {milestones.filter(m => !m.completed).slice(0, 2).map(milestone => (
                <div key={milestone.id} className="bg-slate-50 rounded-2xl p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h4 className="font-semibold text-slate-900">{milestone.title}</h4>
                      <p className="text-sm text-slate-500">{milestone.description}</p>
                    </div>
                    <span className="px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-xs font-medium">
                      {milestone.reward}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-primary-500 to-blue-500 rounded-full"
                        style={{ width: `${(milestone.current / milestone.target) * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-slate-600">
                      {milestone.current}/{milestone.target}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Peer Recognition */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900">Peer Recognition</h3>
              <Button size="sm" onClick={() => setShowGiveRecognition(true)}>
                <Gift className="w-4 h-4 mr-1" /> Recognize Peer
              </Button>
            </div>
            
            {peerRecognitions.length > 0 ? (
              <div className="space-y-3">
                {peerRecognitions.map(recognition => (
                  <div key={recognition.id} className="bg-gradient-to-r from-blue-50 to-teal-50 rounded-2xl p-4 border border-blue-100">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-teal-500 rounded-full flex items-center justify-center flex-shrink-0">
                        <Heart className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <p className="text-sm text-slate-600">
                          <span className="font-semibold text-slate-900">{recognition.fromName}</span> recognized you for being{' '}
                          <span className="font-medium text-blue-600">{recognition.category}</span>
                        </p>
                        <p className="text-sm text-slate-700 mt-1 italic">"{recognition.message}"</p>
                        <p className="text-xs text-slate-400 mt-2">
                          {new Date(recognition.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-slate-50 rounded-2xl p-8 text-center">
                <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500">No recognitions yet. Recognize a peer to get started!</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Badges Tab */}
      {activeTab === 'badges' && (
        <div className="space-y-6">
          {/* Earned Badges */}
          <div>
            <h3 className="text-lg font-bold text-slate-900 mb-4">Earned ({badges.filter(b => b.earnedAt).length})</h3>
            <div className="grid grid-cols-2 gap-4">
              {badges.filter(b => b.earnedAt).map(badge => (
                <div key={badge.id} className={`p-4 rounded-2xl border-2 ${getTierBg(badge.tier)}`}>
                  <div className={`w-14 h-14 mb-3 rounded-xl bg-gradient-to-br ${getTierColor(badge.tier)} flex items-center justify-center`}>
                    {badge.icon === 'star' && <Star className="w-7 h-7 text-white" />}
                    {badge.icon === 'clock' && <Clock className="w-7 h-7 text-white" />}
                    {badge.icon === 'heart' && <Heart className="w-7 h-7 text-white" />}
                    {badge.icon === 'users' && <Users className="w-7 h-7 text-white" />}
                    {badge.icon === 'trophy' && <Trophy className="w-7 h-7 text-white" />}
                  </div>
                  <h4 className="font-bold text-slate-900">{badge.name}</h4>
                  <p className="text-sm opacity-70 mb-2">{badge.description}</p>
                  <p className="text-xs opacity-50">
                    Earned {new Date(badge.earnedAt!).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* In Progress */}
          <div>
            <h3 className="text-lg font-bold text-slate-900 mb-4">In Progress</h3>
            <div className="space-y-3">
              {badges.filter(b => !b.earnedAt && b.progress !== undefined).map(badge => (
                <div key={badge.id} className="bg-slate-50 rounded-2xl p-4">
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${getTierColor(badge.tier)} flex items-center justify-center opacity-50`}>
                      {badge.icon === 'star' && <Star className="w-6 h-6 text-white" />}
                      {badge.icon === 'heart' && <Heart className="w-6 h-6 text-white" />}
                      {badge.icon === 'trophy' && <Trophy className="w-6 h-6 text-white" />}
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold text-slate-900">{badge.name}</h4>
                      <p className="text-sm text-slate-500">{badge.description}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-gradient-to-r from-slate-400 to-slate-500 rounded-full"
                            style={{ width: `${((badge.progress || 0) / (badge.maxProgress || 100)) * 100}%` }}
                          />
                        </div>
                        <span className="text-sm font-medium text-slate-600">
                          {badge.progress}/{badge.maxProgress}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Leaderboard Tab */}
      {activeTab === 'leaderboard' && (
        <div className="space-y-6">
          <div className="bg-gradient-to-r from-yellow-50 to-primary-50 rounded-2xl p-6 text-center">
            <Trophy className="w-12 h-12 text-yellow-500 mx-auto mb-3" />
            <h3 className="text-xl font-bold text-slate-900">This Month's Leaders</h3>
            <p className="text-slate-500">Top caregivers by hours worked</p>
          </div>

          <div className="space-y-3">
            {[
              { rank: 1, name: 'Maria Santos', hours: 142, rating: 4.9, avatar: 'https://i.pravatar.cc/150?u=maria' },
              { rank: 2, name: 'John Chen', hours: 128, rating: 4.8, avatar: 'https://i.pravatar.cc/150?u=john' },
              { rank: 3, name: 'Sarah Johnson', hours: 115, rating: 4.9, avatar: 'https://i.pravatar.cc/150?u=sarah' },
              { rank: 4, name: 'You', hours: myStats.hoursThisMonth, rating: 4.7, avatar: 'https://i.pravatar.cc/150?u=you', isYou: true },
              { rank: 5, name: 'David Kim', hours: 89, rating: 4.6, avatar: 'https://i.pravatar.cc/150?u=david' },
            ].map(caregiver => (
              <div 
                key={caregiver.rank}
                className={`flex items-center gap-4 p-4 rounded-2xl ${
                  caregiver.isYou 
                    ? 'bg-gradient-to-r from-primary-50 to-blue-50 border-2 border-primary-200' 
                    : 'bg-slate-50'
                }`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                  caregiver.rank === 1 ? 'bg-yellow-400 text-yellow-900' :
                  caregiver.rank === 2 ? 'bg-slate-300 text-slate-800' :
                  caregiver.rank === 3 ? 'bg-primary-600 text-white' :
                  'bg-slate-200 text-slate-600'
                }`}>
                  {caregiver.rank}
                </div>
                <img src={caregiver.avatar} alt={caregiver.name} className="w-12 h-12 rounded-xl object-cover" />
                <div className="flex-1">
                  <h4 className="font-semibold text-slate-900">{caregiver.name}</h4>
                  <p className="text-sm text-slate-500">{caregiver.hours} hours • {caregiver.rating} ★</p>
                </div>
                {caregiver.rank <= 3 && (
                  <Medal className={`w-6 h-6 ${
                    caregiver.rank === 1 ? 'text-yellow-500' :
                    caregiver.rank === 2 ? 'text-slate-400' :
                    'text-primary-600'
                  }`} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Give Recognition Modal */}
      {showGiveRecognition && (
        <GiveRecognitionModal
          onClose={() => setShowGiveRecognition(false)}
          onSubmit={async (data) => {
            try {
              await dbService.givePeerRecognition?.(data);
              onShowToast('Recognition sent successfully!', 'success');
              setShowGiveRecognition(false);
            } catch (error) {
              onShowToast('Failed to send recognition', 'error');
            }
          }}
        />
      )}
    </div>
  );
};

// Give Recognition Modal
const GiveRecognitionModal: React.FC<{
  onClose: () => void;
  onSubmit: (data: any) => Promise<void>;
}> = ({ onClose, onSubmit }) => {
  const [selectedCategory, setSelectedCategory] = useState('');
  const [message, setMessage] = useState('');
  const [caregiverId, setCaregiverId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const categories = [
    { id: 'helpful', label: 'Helpful', icon: Heart, color: 'text-teal-500 bg-teal-50' },
    { id: 'inspiring', label: 'Inspiring', icon: Sparkles, color: 'text-blue-500 bg-blue-50' },
    { id: 'teamplayer', label: 'Team Player', icon: Users, color: 'text-blue-500 bg-blue-50' },
    { id: 'aboveandbeyond', label: 'Above & Beyond', icon: Trophy, color: 'text-primary-500 bg-primary-50' },
  ];

  const handleSubmit = async () => {
    if (!caregiverId || !selectedCategory || !message.trim()) return;
    setSubmitting(true);
    await onSubmit({ caregiverId, category: selectedCategory, message });
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl max-w-md w-full p-6 animate-slide-in">
        <h3 className="text-xl font-bold text-slate-900 mb-4">Recognize a Peer</h3>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Select Caregiver</label>
            <select 
              value={caregiverId}
              onChange={(e) => setCaregiverId(e.target.value)}
              className="w-full p-3 border border-slate-200 rounded-xl"
            >
              <option value="">Choose a caregiver...</option>
              <option value="cg1">Maria Santos</option>
              <option value="cg2">John Chen</option>
              <option value="cg3">Sarah Johnson</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Recognition Type</label>
            <div className="grid grid-cols-2 gap-2">
              {categories.map(cat => {
                const Icon = cat.icon;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${
                      selectedCategory === cat.id 
                        ? `${cat.color} border-current` 
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <Icon className={`w-5 h-5 ${selectedCategory === cat.id ? '' : 'text-slate-400'}`} />
                    <span className={`text-sm font-medium ${selectedCategory === cat.id ? '' : 'text-slate-600'}`}>
                      {cat.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What makes them special?"
              className="w-full p-3 border border-slate-200 rounded-xl resize-none"
              rows={3}
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <Button variant="secondary" fullWidth onClick={onClose}>Cancel</Button>
          <Button 
            fullWidth 
            onClick={handleSubmit}
            disabled={!caregiverId || !selectedCategory || !message.trim() || submitting}
          >
            {submitting ? 'Sending...' : 'Send Recognition'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default RecognitionCenter;
