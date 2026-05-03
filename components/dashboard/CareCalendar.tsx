import React, { useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, XCircle, Check, MessageCircle, Info, User } from 'lucide-react';
import { Appointment, AddToastFunction } from '../../types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

interface CareCalendarProps {
    appointments: Appointment[];
    onCancelAppointment: (appt: Appointment) => void;
    onReviewAppointment: (appt: Appointment) => void;
    onShowToast: AddToastFunction;
    onViewAppointment?: (appt: Appointment) => void;
    onMessageCaregiver?: (caregiverId: string, caregiverName: string) => void;
}

export const CareCalendar: React.FC<CareCalendarProps> = ({
    appointments,
    onCancelAppointment,
    onReviewAppointment,
    onShowToast,
    onViewAppointment,
    onMessageCaregiver
}) => {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [selectedDay, setSelectedDay] = useState<string>(new Date().toISOString().split('T')[0]);

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    const getDaysInMonth = (date: Date) => {
        const year = date.getFullYear();
        const month = date.getMonth();
        const days = new Date(year, month + 1, 0).getDate();
        const firstDay = new Date(year, month, 1).getDay();
        return { days, firstDay };
    };

    const { days, firstDay } = getDaysInMonth(currentDate);
    const daysArray = Array.from({ length: days }, (_, i) => i + 1);
    const blanksArray = Array.from({ length: firstDay }, (_, i) => i);

    const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
    const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));

    const selectedDateAppointments = appointments.filter(a => a.isoDate === selectedDay && a.status !== 'cancelled');

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'confirmed': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
            case 'in-progress': return 'bg-blue-100 text-blue-700 border-blue-200';
            case 'completed': return 'bg-slate-100 text-slate-600 border-slate-200';
            default: return 'bg-slate-100 text-slate-600 border-slate-200';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'confirmed': return '✓';
            case 'in-progress': return '●';
            case 'completed': return '✓';
            default: return '';
        }
    };

    return (
        <div className="grid md:grid-cols-3 gap-10 mb-16">
            {/* Calendar Widget */}
            <div className="md:col-span-2 bg-white p-8 rounded-3xl shadow-lg border border-slate-100">
                {/* Header with Gradient */}
                <div className="bg-gradient-to-r from-primary-600 to-blue-600 -m-8 mb-6 p-6 rounded-t-3xl">
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-3">
                            <div className="bg-white/20 p-2 rounded-xl">
                                <Calendar className="w-6 h-6 text-white" />
                            </div>
                            <div>
                                <h3 className="font-bold text-white text-xl">Schedule</h3>
                                <p className="text-primary-100 text-sm">{monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}</p>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={prevMonth}
                                className="p-2 hover:bg-white/20 rounded-xl transition-colors"
                                aria-label="Previous Month"
                            >
                                <ChevronLeft className="w-6 h-6 text-white" />
                            </button>
                            <button
                                onClick={nextMonth}
                                className="p-2 hover:bg-white/20 rounded-xl transition-colors"
                                aria-label="Next Month"
                            >
                                <ChevronRight className="w-6 h-6 text-white" />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Day Labels */}
                <div className="grid grid-cols-7 gap-3 mb-3">
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                        <div key={d} className="text-center text-sm font-bold text-slate-500 uppercase tracking-wide">{d}</div>
                    ))}
                </div>

                {/* Calendar Grid */}
                <div className="grid grid-cols-7 gap-3">
                    {blanksArray.map(b => <div key={`b-${b}`} className="h-14"></div>)}
                    {daysArray.map(d => {
                        const dateStr = new Date(currentDate.getFullYear(), currentDate.getMonth(), d).toISOString().split('T')[0];
                        const hasAppt = appointments.some(a => a.isoDate === dateStr && a.status !== 'cancelled');
                        const isSelected = selectedDay === dateStr;
                        const isToday = dateStr === new Date().toISOString().split('T')[0];

                        return (
                            <button
                                key={d}
                                onClick={() => setSelectedDay(dateStr)}
                                className={`
                                    h-14 rounded-2xl flex flex-col items-center justify-center text-lg font-bold relative 
                                    transition-all duration-200 transform hover:scale-105
                                    ${isSelected
                                        ? 'bg-gradient-to-br from-primary-500 to-primary-600 text-white shadow-lg shadow-primary-200'
                                        : isToday
                                            ? 'bg-blue-50 text-blue-700 border-2 border-blue-300'
                                            : 'hover:bg-slate-50 text-slate-700 border border-transparent hover:border-slate-200'
                                    }
                                `}
                            >
                                {d}
                                {hasAppt && (
                                    <span className={`absolute bottom-1.5 w-2 h-2 rounded-full ${isSelected ? 'bg-white' : 'bg-accent-500'} shadow-sm`}></span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Daily Agenda */}
            <div className="bg-gradient-to-br from-slate-50 to-white p-6 rounded-3xl border border-slate-200 shadow-lg h-fit">
                <div className="mb-6">
                    <p className="text-sm font-semibold text-primary-600 uppercase tracking-wide mb-1">Daily Agenda</p>
                    <h4 className="font-bold text-slate-900 text-2xl">
                        {new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                    </h4>
                </div>

                {selectedDateAppointments.length > 0 ? (
                    <div className="space-y-4">
                        {selectedDateAppointments.map(appt => (
                            <div key={appt.id} className="bg-white p-5 rounded-2xl shadow-md border border-slate-100 hover:shadow-lg transition-shadow">
                                {/* Appointment Header */}
                                <div className="flex items-start gap-4 mb-4">
                                    {/* Caregiver Photo/Initial */}
                                    <div className="flex-shrink-0">
                                        <div className="w-16 h-16 bg-gradient-to-br from-primary-400 to-blue-500 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-md">
                                            {appt.caregiverName.charAt(0)}
                                        </div>
                                    </div>

                                    {/* Appointment Info */}
                                    <div className="flex-1 min-w-0">
                                        <h5 className="font-bold text-slate-900 text-lg mb-1">{appt.caregiverName}</h5>
                                        <p className="text-2xl font-bold text-primary-700 mb-2">{appt.time}</p>
                                        <div className="flex items-center gap-2">
                                            <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold uppercase border ${getStatusColor(appt.status)}`}>
                                                <span>{getStatusIcon(appt.status)}</span>
                                                {appt.status}
                                            </span>
                                            {appt.isMicroVisit && (
                                                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-700 border border-blue-200">
                                                    ⚡ {appt.taskName || 'Micro-Visit'}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Action Buttons */}
                                <div className="flex gap-2 mt-4">
                                    <button
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold rounded-xl transition-colors border border-slate-200"
                                        onClick={() => onViewAppointment ? onViewAppointment(appt) : onShowToast('Appointment details', 'info')}
                                    >
                                        <Info className="w-4 h-4" />
                                        Details
                                    </button>
                                    <button
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl transition-colors shadow-md"
                                        onClick={() => onMessageCaregiver ? onMessageCaregiver(appt.caregiverId, appt.caregiverName) : onShowToast('Messaging', 'info')}
                                    >
                                        <MessageCircle className="w-4 h-4" />
                                        Contact
                                    </button>
                                </div>

                                {/* Cancel Button (only for confirmed) */}
                                {appt.status === 'confirmed' && (
                                    <button
                                        onClick={() => onCancelAppointment(appt)}
                                        className="w-full mt-2 flex items-center justify-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 font-medium rounded-xl transition-colors text-sm"
                                    >
                                        <XCircle className="w-4 h-4" />
                                        Cancel Appointment
                                    </button>
                                )}

                                {/* Review Button */}
                                {appt.paymentStatus === 'paid' && !appt.hasReview && (
                                    <Button size="sm" fullWidth variant="secondary" onClick={() => onReviewAppointment(appt)} className="mt-2">
                                        Leave Review
                                    </Button>
                                )}

                                {appt.paymentStatus === 'paid' && appt.hasReview && (
                                    <div className="text-xs text-center text-slate-400 italic mt-2">
                                        Reviewed <Check className="w-3 h-3 inline ml-1" />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-center py-12">
                        <div className="bg-slate-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Calendar className="w-10 h-10 text-slate-300" />
                        </div>
                        <p className="text-slate-500 font-medium mb-1">No appointments scheduled</p>
                        <p className="text-sm text-slate-400">Select a different date or book a new appointment</p>
                    </div>
                )}
            </div>
        </div>
    );
};
