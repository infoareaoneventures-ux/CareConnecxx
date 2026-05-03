import React, { useState } from 'react';
import { WeeklySchedule, TimeSlot } from '../../types';

interface AvailabilityCalendarProps {
    availability: WeeklySchedule;
    onAvailabilityChange: (availability: WeeklySchedule) => void;
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const AvailabilityCalendar: React.FC<AvailabilityCalendarProps> = ({
    availability,
    onAvailabilityChange
}) => {
    const [selectedDay, setSelectedDay] = useState<typeof DAYS[number] | null>(null);

    const addTimeSlot = (day: typeof DAYS[number]) => {
        const newSlot: TimeSlot = {
            start: '09:00',
            end: '17:00'
        };

        onAvailabilityChange({
            ...availability,
            [day]: [...(availability[day] || []), newSlot]
        });
    };

    const removeTimeSlot = (day: typeof DAYS[number], index: number) => {
        const daySlots = availability[day] || [];
        onAvailabilityChange({
            ...availability,
            [day]: daySlots.filter((_, i) => i !== index)
        });
    };

    const updateTimeSlot = (day: typeof DAYS[number], index: number, field: 'start' | 'end', value: string) => {
        const daySlots = [...(availability[day] || [])];
        daySlots[index] = { ...daySlots[index], [field]: value };
        onAvailabilityChange({
            ...availability,
            [day]: daySlots
        });
    };

    const getDayAvailability = (day: typeof DAYS[number]) => {
        return availability[day] || [];
    };

    return (
        <div className="space-y-4">
            <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-2">
                    Set Your Weekly Availability
                </h3>
                <p className="text-sm text-slate-600 mb-4">
                    Add the days and times you're available to work. You can add multiple time slots per day.
                </p>
            </div>

            <div className="grid grid-cols-7 gap-2">
                {DAYS.map((day, index) => {
                    const slots = getDayAvailability(day);
                    const hasSlots = slots.length > 0;

                    return (
                        <div key={day} className="flex flex-col">
                            <button
                                type="button"
                                onClick={() => setSelectedDay(day)}
                                className={`
                  p-3 rounded-lg text-center transition-all border-2
                  ${selectedDay === day
                                        ? 'border-primary-500 bg-primary-50'
                                        : hasSlots
                                            ? 'border-primary-300 bg-primary-50'
                                            : 'border-slate-200 bg-white hover:border-primary-200'
                                    }
                `}
                            >
                                <div className="text-xs font-medium text-slate-600">{DAY_LABELS[index]}</div>
                                {hasSlots && (
                                    <div className="text-xs text-primary-600 mt-1">
                                        {slots.length} slot{slots.length !== 1 ? 's' : ''}
                                    </div>
                                )}
                            </button>
                        </div>
                    );
                })}
            </div>

            {selectedDay && (
                <div className="p-4 bg-slate-50 rounded-lg space-y-3">
                    <div className="flex items-center justify-between">
                        <h4 className="font-semibold text-slate-800 capitalize">{selectedDay}</h4>
                        <button
                            type="button"
                            onClick={() => addTimeSlot(selectedDay)}
                            className="px-3 py-1 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700 transition-colors"
                        >
                            + Add Time Slot
                        </button>
                    </div>

                    {getDayAvailability(selectedDay).length === 0 ? (
                        <p className="text-sm text-slate-500 text-center py-4">
                            No availability set for this day. Click "Add Time Slot" to get started.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {getDayAvailability(selectedDay).map((slot, index) => (
                                <div key={index} className="flex items-center gap-2 bg-white p-3 rounded-lg">
                                    <input
                                        type="time"
                                        value={slot.start}
                                        onChange={(e) => updateTimeSlot(selectedDay, index, 'start', e.target.value)}
                                        className="px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                    />
                                    <span className="text-slate-500">to</span>
                                    <input
                                        type="time"
                                        value={slot.end}
                                        onChange={(e) => updateTimeSlot(selectedDay, index, 'end', e.target.value)}
                                        className="px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removeTimeSlot(selectedDay, index)}
                                        className="ml-auto p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                    >
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                        </svg>
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="mt-4 p-4 bg-blue-50 rounded-lg">
                <p className="text-sm text-blue-800">
                    💡 <strong>Tip:</strong> Setting accurate availability helps us match you with clients who need care during your available hours.
                </p>
            </div>
        </div>
    );
};
