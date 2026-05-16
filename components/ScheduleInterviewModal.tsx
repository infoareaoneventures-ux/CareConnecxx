import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Calendar, Clock, MessageSquare } from 'lucide-react';
import { Button } from './ui/Button';
import { Caregiver } from '../types';
import { videoService } from '../services/videoService';
import { authService } from '../services/api';

interface ScheduleInterviewModalProps {
    caregiver: Caregiver;
    onClose: () => void;
    onSuccess: (message: string) => void;
    onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const ScheduleInterviewModal: React.FC<ScheduleInterviewModalProps> = ({
    caregiver,
    onClose,
    onSuccess,
    onShowToast,
}) => {
    const [selectedDate, setSelectedDate] = useState('');
    const [selectedTime, setSelectedTime] = useState('');
    const [interviewType, setInterviewType] = useState<'video' | 'phone' | 'in-person'>('video');
    const [notes, setNotes] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSchedule = async () => {
        if (!selectedDate || !selectedTime) {
            onShowToast('Please select both date and time', 'error');
            return;
        }

        setIsSubmitting(true);
        try {
            console.log('🎬 [ScheduleInterviewModal] Starting interview scheduling...');

            const currentUser = authService.getCurrentUser();
            console.log('👤 [ScheduleInterviewModal] Current user:', {
                exists: !!currentUser,
                uid: currentUser?.uid,
                displayName: currentUser?.displayName,
                email: currentUser?.email
            });

            if (!currentUser) {
                console.error('❌ [ScheduleInterviewModal] User not authenticated');
                throw new Error('Not authenticated');
            }

            // Combine date and time safely
            const [year, month, day] = selectedDate.split('-').map(Number);
            const [hour, minute] = selectedTime.split(':').map(Number);
            const scheduledDateTime = new Date(year, month - 1, day, hour, minute);

            console.log('📅 [ScheduleInterviewModal] Scheduled time:', {
                selectedDate,
                selectedTime,
                scheduledDateTime: scheduledDateTime.toISOString(),
                isFuture: scheduledDateTime > new Date()
            });

            // Check if time is in the future
            if (scheduledDateTime <= new Date()) {
                console.warn('⚠️ [ScheduleInterviewModal] Selected time is not in the future');
                onShowToast('Please select a future date and time', 'error');
                setIsSubmitting(false);
                return;
            }

            const caregiverId = caregiver.uid || caregiver.id;

            console.log('👨‍⚕️ [ScheduleInterviewModal] Caregiver info:', {
                caregiverId,
                caregiverName: caregiver.name,
                originalId: caregiver.id,
                originalUid: caregiver.uid
            });

            await videoService.scheduleInterview(
                currentUser.uid,
                currentUser.displayName || 'Client',
                caregiverId,
                caregiver.name,
                scheduledDateTime,
                notes
            );

            // Interview scheduled successfully
            onSuccess('Video interview scheduled successfully!');
            onShowToast('Interview scheduled! Both parties will be notified.', 'success');
            onClose();
        } catch (error: any) {
            console.error('❌ [ScheduleInterviewModal] Error scheduling interview:');
            console.error('Error type:', error?.constructor?.name);
            console.error('Error message:', error?.message);
            console.error('Error code:', error?.code);
            console.error('Full error object:', error);

            // Provide more specific error messages
            let errorMessage = 'Failed to schedule interview. Please try again.';

            if (error?.message?.includes('not authenticated')) {
                errorMessage = 'You must be logged in to schedule an interview.';
            } else if (error?.message?.includes('Database not connected')) {
                errorMessage = 'Database connection error. Please refresh the page and try again.';
            } else if (error?.code === 'permission-denied') {
                errorMessage = 'Permission denied. Please check your account permissions.';
            } else if (error?.message) {
                errorMessage = `Error: ${error.message}`;
            }

            onShowToast(errorMessage, 'error');
        } finally {
            setIsSubmitting(false);
        }
    };

    // Generate time slots (9 AM to 6 PM)
    const timeSlots = [];
    for (let hour = 9; hour <= 18; hour++) {
        timeSlots.push(`${hour.toString().padStart(2, '0')}:00`);
        if (hour < 18) {
            timeSlots.push(`${hour.toString().padStart(2, '0')}:30`);
        }
    }

    // Get minimum date (today)
    const today = new Date().toISOString().split('T')[0];

    return createPortal(
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
            <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-slide-up">
                {/* Header */}
                <div className="sticky top-0 bg-gradient-to-r from-primary-600 to-blue-600 text-white p-6 rounded-t-3xl">
                    <div className="flex justify-between items-start">
                        <div>
                            <h2 className="text-2xl font-bold mb-1">Schedule Interview</h2>
                            <p className="text-primary-50 text-sm">with {caregiver.name}</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-white/80 hover:text-white transition-colors"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="p-6 space-y-6">
                    {/* Caregiver Info */}
                    <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl">
                        <img
                            src={caregiver.imageUrl || caregiver.photo}
                            alt={caregiver.name}
                            className="w-16 h-16 rounded-full object-cover border-2 border-white shadow-md"
                        />
                        <div>
                            <h3 className="font-bold text-slate-900">{caregiver.name}</h3>
                            <p className="text-sm text-slate-500">${caregiver.hourlyRate}/hr</p>
                            {caregiver.rating && (
                                <p className="text-sm text-accent-500">★ {caregiver.rating}</p>
                            )}
                        </div>
                    </div>

                    {/* Interview Type Selection */}
                    <div>
                        <label className="flex items-center text-sm font-bold text-slate-700 mb-3">
                            Interview Type
                        </label>
                        <div className="grid grid-cols-3 gap-3">
                            {[
                                { id: 'video', label: 'Video Call', icon: '📹' },
                                { id: 'phone', label: 'Phone', icon: '📞' },
                                { id: 'in-person', label: 'In Person', icon: '🏠' }
                            ].map((type) => (
                                <button
                                    key={type.id}
                                    onClick={() => setInterviewType(type.id as 'video' | 'phone' | 'in-person')}
                                    className={`p-3 rounded-xl border transition-all ${
                                        interviewType === type.id
                                            ? 'border-primary-500 bg-primary-50 text-primary-700'
                                            : 'border-slate-200 hover:border-slate-300'
                                    }`}
                                >
                                    <span className="text-2xl mb-1 block">{type.icon}</span>
                                    <span className="text-sm font-medium">{type.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Date Selection */}
                    <div>
                        <label className="flex items-center text-sm font-bold text-slate-700 mb-2">
                            <Calendar className="w-4 h-4 mr-2 text-primary-600" />
                            Select Date
                        </label>
                        <input
                            type="date"
                            value={selectedDate}
                            onChange={(e) => setSelectedDate(e.target.value)}
                            min={today}
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                        />
                    </div>

                    {/* Time Selection */}
                    <div>
                        <label className="flex items-center text-sm font-bold text-slate-700 mb-2">
                            <Clock className="w-4 h-4 mr-2 text-primary-600" />
                            Select Time
                        </label>
                        <select
                            value={selectedTime}
                            onChange={(e) => setSelectedTime(e.target.value)}
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all appearance-none bg-white"
                        >
                            <option value="">Choose a time...</option>
                            {timeSlots.map((time) => (
                                <option key={time} value={time}>
                                    {new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', {
                                        hour: 'numeric',
                                        minute: '2-digit',
                                        hour12: true,
                                    })}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Notes */}
                    <div>
                        <label className="flex items-center text-sm font-bold text-slate-700 mb-2">
                            <MessageSquare className="w-4 h-4 mr-2 text-primary-600" />
                            Notes (Optional)
                        </label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Add any topics you'd like to discuss..."
                            rows={3}
                            className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all resize-none"
                        />
                    </div>

                    {/* Info Box */}
                    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                        <p className="text-sm text-blue-900">
                            <strong>Interview Tips:</strong> Interviews typically last 15-30 minutes.
                        </p>
                    </div>
                </div>

                {/* Footer */}
                <div className="sticky bottom-0 bg-slate-50 p-6 rounded-b-3xl border-t border-slate-100 flex gap-3">
                    <Button
                        variant="outline"
                        fullWidth
                        onClick={onClose}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        fullWidth
                        onClick={handleSchedule}
                        disabled={isSubmitting || !selectedDate || !selectedTime}
                        className="bg-gradient-to-r from-primary-600 to-blue-600 hover:from-primary-700 hover:to-blue-700"
                    >
                        {isSubmitting ? 'Scheduling...' : 'Schedule Interview'}
                    </Button>
                </div>
            </div>
        </div>
    , document.body);
};
