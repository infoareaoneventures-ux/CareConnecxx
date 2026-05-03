import React, { useEffect, useState } from 'react';
import { Video, Calendar, Clock, CheckCircle, XCircle, Play, User } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { VideoInterview } from '../../types';
import { videoService } from '../../services/videoService';
import { authService } from '../../services/api';

interface InterviewHistoryProps {
    userType: 'client' | 'caregiver';
    onJoinInterview: (interview: VideoInterview) => void;
    onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const InterviewHistory: React.FC<InterviewHistoryProps> = ({
    userType,
    onJoinInterview,
    onShowToast,
}) => {
    const [interviews, setInterviews] = useState<VideoInterview[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'all' | 'upcoming' | 'completed'>('all');

    useEffect(() => {
        loadInterviews();
    }, []);

    const loadInterviews = async () => {
        try {
            const currentUser = authService.getCurrentUser();
            if (!currentUser) return;

            const userInterviews = await videoService.getUserInterviews(
                currentUser.uid,
                userType
            );
            setInterviews(userInterviews);
        } catch (error) {
            console.error('Error loading interviews:', error);
            onShowToast('Failed to load interviews', 'error');
        } finally {
            setLoading(false);
        }
    };

    const getFilteredInterviews = () => {
        const now = new Date();

        switch (filter) {
            case 'upcoming':
                return interviews.filter(
                    (i) => (i.status === 'scheduled' || i.status === 'requested' || i.status === 'accepted') &&
                        new Date(i.scheduledTime) > now
                );
            case 'completed':
                return interviews.filter((i) => i.status === 'completed');
            default:
                return interviews;
        }
    };

    const getStatusBadge = (status: VideoInterview['status']) => {
        const statusConfig = {
            'requested': { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200', label: 'Requested' },
            'accepted': { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-200', label: 'Accepted' },
            'scheduled': { bg: 'bg-primary-100', text: 'text-primary-700', border: 'border-primary-200', label: 'Scheduled' },
            'in-progress': { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200', label: 'In Progress' },
            'completed': { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200', label: 'Completed' },
            'cancelled': { bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-200', label: 'Cancelled' },
            'missed': { bg: 'bg-accent-100', text: 'text-accent-700', border: 'border-accent-200', label: 'Missed' },
        };

        const config = statusConfig[status] || statusConfig['requested'];

        return (
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase border ${config.bg} ${config.text} ${config.border}`}>
                {config.label}
            </span>
        );
    };

    const formatDateTime = (isoString: string) => {
        const date = new Date(isoString);
        return {
            date: date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
            }),
            time: date.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
            }),
        };
    };

    const canJoinInterview = (interview: VideoInterview) => {
        if (interview.status !== 'scheduled' && interview.status !== 'accepted') return false;

        const scheduledTime = new Date(interview.scheduledTime);
        const now = new Date();
        const timeDiff = scheduledTime.getTime() - now.getTime();
        const minutesDiff = timeDiff / (1000 * 60);

        // Can join 5 minutes before scheduled time
        return minutesDiff <= 5 && minutesDiff >= -30;
    };

    const filteredInterviews = getFilteredInterviews();

    if (loading) {
        return (
            <div className="animate-pulse space-y-4">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="bg-slate-100 h-32 rounded-2xl" />
                ))}
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header with Icon and Filters */}
            <div className="bg-gradient-to-r from-primary-600 to-blue-600 -mx-6 -mt-6 px-6 pt-6 pb-8 rounded-t-3xl">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-3">
                        <div className="bg-white/20 p-3 rounded-xl">
                            <Video className="w-7 h-7 text-white" />
                        </div>
                        <div>
                            <h3 className="text-2xl font-bold text-white">Video Interviews</h3>
                            <p className="text-primary-100 text-sm">Connect with caregivers face-to-face</p>
                        </div>
                    </div>
                </div>

                {/* Filter Tabs */}
                <div className="flex gap-2">
                    <button
                        onClick={() => setFilter('all')}
                        className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${filter === 'all'
                                ? 'bg-white text-primary-700 shadow-lg'
                                : 'bg-white/20 text-white hover:bg-white/30'
                            }`}
                    >
                        All
                    </button>
                    <button
                        onClick={() => setFilter('upcoming')}
                        className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${filter === 'upcoming'
                                ? 'bg-white text-primary-700 shadow-lg'
                                : 'bg-white/20 text-white hover:bg-white/30'
                            }`}
                    >
                        Upcoming
                    </button>
                    <button
                        onClick={() => setFilter('completed')}
                        className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${filter === 'completed'
                                ? 'bg-white text-primary-700 shadow-lg'
                                : 'bg-white/20 text-white hover:bg-white/30'
                            }`}
                    >
                        Completed
                    </button>
                </div>
            </div>

            {/* Interview List */}
            {filteredInterviews.length === 0 ? (
                <div className="bg-gradient-to-br from-slate-50 to-white border border-slate-200 rounded-2xl p-12 text-center">
                    <div className="w-20 h-20 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Video className="w-10 h-10 text-primary-600" />
                    </div>
                    <h4 className="text-xl font-bold text-slate-900 mb-2">No interviews found</h4>
                    <p className="text-slate-500">
                        {filter === 'upcoming'
                            ? 'You have no upcoming video interviews scheduled.'
                            : filter === 'completed'
                                ? 'You have no completed interviews yet.'
                                : 'Schedule your first video interview to get started.'}
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {filteredInterviews.map((interview) => {
                        const { date, time } = formatDateTime(interview.scheduledTime);
                        const otherPartyName =
                            userType === 'client' ? interview.caregiverName : interview.clientName;

                        return (
                            <div
                                key={interview.id}
                                className="bg-white border border-slate-200 rounded-2xl p-6 hover:shadow-lg hover:border-primary-200 transition-all"
                            >
                                <div className="flex items-start gap-5">
                                    {/* Caregiver Avatar */}
                                    <div className="flex-shrink-0">
                                        <div className="w-16 h-16 bg-gradient-to-br from-primary-400 to-blue-500 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-md border-4 border-white ring-2 ring-primary-100">
                                            {otherPartyName.charAt(0)}
                                        </div>
                                    </div>

                                    {/* Interview Info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between mb-3">
                                            <div>
                                                <h4 className="font-bold text-slate-900 text-xl mb-2">{otherPartyName}</h4>
                                                <div className="flex items-center gap-4 text-sm text-slate-600">
                                                    <span className="flex items-center gap-1.5 bg-slate-50 px-3 py-1.5 rounded-lg">
                                                        <Calendar className="w-4 h-4 text-primary-600" />
                                                        {date}
                                                    </span>
                                                    <span className="flex items-center gap-1.5 bg-slate-50 px-3 py-1.5 rounded-lg">
                                                        <Clock className="w-4 h-4 text-primary-600" />
                                                        {time}
                                                    </span>
                                                </div>
                                            </div>
                                            {getStatusBadge(interview.status)}
                                        </div>

                                        {interview.notes && (
                                            <p className="text-sm text-slate-600 mb-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                                                {interview.notes}
                                            </p>
                                        )}

                                        {/* Action Buttons */}
                                        <div className="flex gap-3">
                                            {userType === 'caregiver' && interview.status === 'requested' && (
                                                <button
                                                    onClick={async () => {
                                                        try {
                                                            await videoService.acceptInterview(interview.id);
                                                            onShowToast('Interview accepted!', 'success');
                                                            loadInterviews();
                                                        } catch (e) {
                                                            onShowToast('Failed to accept interview', 'error');
                                                        }
                                                    }}
                                                    className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl transition-colors shadow-md"
                                                >
                                                    <CheckCircle className="w-4 h-4" />
                                                    Accept Request
                                                </button>
                                            )}

                                            {canJoinInterview(interview) && (
                                                <button
                                                    onClick={() => onJoinInterview(interview)}
                                                    className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-primary-600 to-blue-600 hover:from-primary-700 hover:to-blue-700 text-white font-bold rounded-xl transition-all shadow-lg"
                                                >
                                                    <Play className="w-5 h-5" />
                                                    Join Interview
                                                </button>
                                            )}

                                            {interview.status === 'completed' && interview.duration && (
                                                <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 rounded-xl">
                                                    <Clock className="w-4 h-4" />
                                                    <span className="font-semibold">{interview.duration} min</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
