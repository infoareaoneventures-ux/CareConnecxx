

import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Calendar, Clock, ArrowLeft, ShieldCheck, MapPin, Info, AlertCircle } from 'lucide-react';
import { Caregiver, Appointment, MicroTask, MICRO_TASKS } from '../types';
import { Button } from './ui/Button';
import { db } from '../lib/firebase';
import { useCareConnex } from '../context/CareConnexContext';
import { availabilityService } from '../services/availabilityService';

/** Convert "09:00 AM" / "02:30 PM" → "09:00" / "14:30" */
function to24h(t: string): string {
  const [tp, period] = t.split(' ');
  const [h, m] = tp.split(':');
  let hour = parseInt(h, 10);
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return `${hour.toString().padStart(2, '0')}:${m}`;
}

/** Parse "YYYY-MM-DD" as a local (not UTC) Date */
function isoToLocalDate(iso: string): Date {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

interface BookingModalProps {
  caregiver: Caregiver;
  onClose: () => void;
  onConfirm: (appt: Appointment) => void;
}

export const BookingModal: React.FC<BookingModalProps> = ({ caregiver, onClose, onConfirm }) => {
  const { currentUser } = useCareConnex();
  const [step, setStep] = useState<'select' | 'confirm'>('select');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Micro-Visit State
  const [bookingType, setBookingType] = useState<'hourly' | 'task'>('hourly');
  const [selectedTask, setSelectedTask] = useState<MicroTask | null>(null);

  // Recurring Booking State
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFrequency, setRecurringFrequency] = useState<'weekly' | 'biweekly' | 'monthly'>('weekly');
  const [recurringEndDate, setRecurringEndDate] = useState<string>('');

  // Generate recurring end date options
  const recurringEndOptions = useMemo(() => {
    const options = [];
    const today = new Date();
    
    // 1 month from now
    const oneMonth = new Date(today);
    oneMonth.setMonth(oneMonth.getMonth() + 1);
    options.push({ value: oneMonth.toISOString().split('T')[0], label: '1 month (' + oneMonth.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')' });
    
    // 2 months from now
    const twoMonths = new Date(today);
    twoMonths.setMonth(twoMonths.getMonth() + 2);
    options.push({ value: twoMonths.toISOString().split('T')[0], label: '2 months (' + twoMonths.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')' });
    
    // 3 months from now
    const threeMonths = new Date(today);
    threeMonths.setMonth(threeMonths.getMonth() + 3);
    options.push({ value: threeMonths.toISOString().split('T')[0], label: '3 months (' + threeMonths.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')' });
    
    // 6 months from now
    const sixMonths = new Date(today);
    sixMonths.setMonth(sixMonths.getMonth() + 6);
    options.push({ value: sixMonths.toISOString().split('T')[0], label: '6 months (' + sixMonths.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')' });
    
    return options;
  }, []);

  // Calculate number of recurring appointments
  const calculateRecurringCount = () => {
    if (!isRecurring || !selectedDate || !recurringEndDate) return 1;
    
    // Find the ISO date from the dates array
    const dateObj = dates.find(d => d.full === selectedDate);
    if (!dateObj) return 1;
    
    const start = new Date(dateObj.iso);
    const end = new Date(recurringEndDate);
    
    // Validate dates
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 1;
    
    const diffTime = end.getTime() - start.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) return 1;
    
    let count = 1;
    switch (recurringFrequency) {
      case 'weekly': count = Math.max(1, Math.floor(diffDays / 7) + 1); break;
      case 'biweekly': count = Math.max(1, Math.floor(diffDays / 14) + 1); break;
      case 'monthly': count = Math.max(1, Math.floor(diffDays / 30) + 1); break;
    }
    return Math.min(count, 52); // Cap at 52 appointments (1 year weekly)
  };

  // Generate next 30 days for selection
  // BUG FIX: Store dates in UTC, display in local timezone
  const dates = Array.from({ length: 30 }).map((_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i + 1); // Start from tomorrow
    // Store as UTC ISO string (YYYY-MM-DD)
    const utcIso = d.toISOString().split('T')[0];
    // Display in local timezone
    return {
      day: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      date: d.getUTCDate(),
      full: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      iso: utcIso
    };
  });

  const times = ["09:00 AM", "11:00 AM", "02:00 PM", "04:30 PM"];

  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  // Duration in hours for the current booking type
  const durationHours = bookingType === 'task' && selectedTask ? selectedTask.durationMin / 60 : 3;

  // Dates where NO time slot fits the caregiver's weekly schedule → disable the chip
  const disabledDates = useMemo(() => {
    const disabled = new Set<string>();
    dates.forEach(d => {
      const dateObj = isoToLocalDate(d.iso);
      const anyAvailable = times.some(t =>
        availabilityService.checkWeeklyAvailability(caregiver, dateObj, to24h(t), durationHours)
      );
      if (!anyAvailable) disabled.add(d.full);
    });
    return disabled;
  }, [caregiver, bookingType, selectedTask]);

  // Times that don't fit the caregiver's schedule for the selected date → disable the button
  const disabledTimes = useMemo(() => {
    if (!selectedDate) return new Set<string>();
    const d = dates.find(dt => dt.full === selectedDate);
    if (!d) return new Set<string>();
    const dateObj = isoToLocalDate(d.iso);
    const disabled = new Set<string>();
    times.forEach(t => {
      if (!availabilityService.checkWeeklyAvailability(caregiver, dateObj, to24h(t), durationHours)) {
        disabled.add(t);
      }
    });
    return disabled;
  }, [selectedDate, caregiver, bookingType, selectedTask]);

  // Clear selected time if it becomes unavailable after date change
  useEffect(() => {
    if (selectedTime && disabledTimes.has(selectedTime)) {
      setSelectedTime(null);
    }
  }, [disabledTimes]);

  const handleContinue = () => {
    if (selectedDate && selectedTime) {
      setStep('confirm');
    }
  };

  const handleConfirmBooking = async () => {
    if (!selectedDate || !selectedTime) return;
    setLoading(true);
    setAvailabilityError(null);

    const dateObj = dates.find(d => d.full === selectedDate);
    const isoDate = dateObj ? dateObj.iso : new Date().toISOString().split('T')[0];

    // Final guard: check weekly schedule + calendar conflicts before confirming
    const requestDate = isoToLocalDate(isoDate);
    const isAvail = await availabilityService.isAvailable(caregiver, requestDate, to24h(selectedTime), durationHours);
    if (!isAvail) {
      setLoading(false);
      setAvailabilityError('This time slot conflicts with the caregiver\'s schedule or an existing booking. Please select a different time.');
      setStep('select');
      return;
    }

    // Cost Logic
    let totalCost = 0;

    if (bookingType === 'task' && selectedTask) {
      totalCost = selectedTask.flatRate;
    } else {
      totalCost = caregiver.hourlyRate * 3; // Default 3 hours
    }

    // Use current user's info if available, fallback to placeholder
    const clientId = currentUser?.uid || 'temp-client-id';
    const clientName = currentUser?.displayName || 'Guest User';

    // Calculate duration
    const duration = bookingType === 'task' && selectedTask
      ? selectedTask.durationMin / 60
      : 3; // Default 3 hours for hourly

    // Generate recurring group ID if this is a recurring booking
    const fdb = db;
    if (!fdb) {
      setLoading(false);
      return;
    }
    const recurringGroupId = isRecurring ? fdb.collection('appointments').doc().id : undefined;
    const dayOfWeek = selectedDate ? new Date(selectedDate).getDay() : undefined;

    const newAppt: Appointment = {
      id: fdb.collection('appointments').doc().id,
      clientId,
      caregiverId: caregiver.id,
      caregiverName: caregiver.name,
      clientName,
      date: selectedDate,
      isoDate,
      time: selectedTime,
      duration,
      // Caregiver must accept before the visit is confirmed — they see it in
      // their pending requests (api.getPendingBookingRequests) and via Cara.
      status: 'pending_caregiver_confirmation',
      paymentStatus: 'pending',
      paymentMethod: 'credit' as const,
      cost: totalCost,

      // Micro-Visit Data
      bookingType,
      taskName: selectedTask?.name,
      isMicroVisit: bookingType === 'task',

      // Recurring Data
      isRecurring,
      recurringGroupId,
      recurringFrequency: isRecurring ? recurringFrequency : undefined,
      recurringEndDate: isRecurring ? recurringEndDate : undefined,
      recurringDayOfWeek: isRecurring ? dayOfWeek : undefined
    };

    onConfirm(newAppt);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity" onClick={onClose} />

      <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden transform transition-all animate-slide-in">

        {/* Modal Header */}
        <div className="bg-primary-600 p-6 text-white relative transition-all duration-300">
          {/* Back Button (Only on Confirm step) */}
          <button
            onClick={step === 'confirm' ? () => setStep('select') : onClose}
            className={`absolute top-4 left-4 p-1 rounded-full transition-colors ${step === 'confirm' ? 'text-primary-100 hover:text-white hover:bg-white/10' : 'hidden'}`}
          >
            <ArrowLeft size={20} />
          </button>

          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-primary-100 hover:text-white bg-white/10 rounded-full p-1 transition-colors"
          >
            <X size={20} />
          </button>

          <h2 className="text-2xl font-bold text-center">
            {step === 'select' ? 'Book Appointment' : 'Confirm Details'}
          </h2>
          <p className="text-primary-100 text-center text-sm mt-1">
            {step === 'select' ? `with ${caregiver.name}` : 'Review your booking below'}
          </p>
        </div>

        <div className="p-6">
          {step === 'select' ? (
            /* STEP 1: SELECTION */
            <div className="space-y-6 animate-slide-in">
              {/* Availability error */}
              {availabilityError && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-700 font-medium">{availabilityError}</p>
                </div>
              )}
              {/* Booking Type Toggle */}
              <div className="flex bg-slate-100 p-1 rounded-xl">
                <button
                  onClick={() => { setBookingType('hourly'); setSelectedTask(null); }}
                  className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${bookingType === 'hourly' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Hourly Shift
                </button>
                <button
                  onClick={() => setBookingType('task')}
                  className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${bookingType === 'task' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Micro-Visit
                </button>
              </div>

              {/* Task Selection (Only for Micro-Visits) */}
              {bookingType === 'task' && (
                <div>
                  <div className="flex items-center text-slate-800 font-semibold mb-3">
                    <Info className="w-5 h-5 mr-2 text-primary-600" />
                    Select Service
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {MICRO_TASKS.map(task => (
                      <button
                        key={task.id}
                        onClick={() => setSelectedTask(task)}
                        className={`
                          w-full p-3 rounded-xl border text-left transition-all flex justify-between items-center group
                          ${selectedTask?.id === task.id ? 'border-primary-600 bg-primary-50 ring-1 ring-primary-600' : 'border-slate-200 hover:border-primary-300'}
                        `}
                      >
                        <div>
                          <p className={`font-bold ${selectedTask?.id === task.id ? 'text-primary-900' : 'text-slate-700'}`}>{task.name}</p>
                          <p className="text-xs text-slate-500">{task.durationMin} mins • Flat Rate</p>
                        </div>
                        <span className={`font-bold ${selectedTask?.id === task.id ? 'text-primary-700' : 'text-slate-900'}`}>${task.flatRate}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Date Selection */}
              <div>
                <div className="flex items-center text-slate-800 font-semibold mb-3">
                  <Calendar className="w-5 h-5 mr-2 text-primary-600" />
                  Select Date
                </div>
                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                  {dates.map((d) => {
                    const isDisabled = disabledDates.has(d.full);
                    return (
                      <button
                        key={d.iso}
                        disabled={isDisabled}
                        onClick={() => !isDisabled && setSelectedDate(d.full)}
                        className={`
                          flex flex-col items-center justify-center min-w-[70px] h-[80px] rounded-xl border-2 transition-all flex-shrink-0
                          ${isDisabled
                            ? 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed opacity-50'
                            : selectedDate === d.full
                              ? 'border-primary-600 bg-primary-50 text-primary-700 shadow-sm'
                              : 'border-slate-100 hover:border-primary-200 text-slate-600'
                          }
                        `}
                      >
                        <span className="text-xs font-medium uppercase">{d.day}</span>
                        <span className="text-2xl font-bold">{d.date}</span>
                        {isDisabled && <span className="text-[9px] mt-0.5 text-slate-300">Unavailable</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Time Selection */}
              <div>
                <div className="flex items-center text-slate-800 font-semibold mb-3">
                  <Clock className="w-5 h-5 mr-2 text-primary-600" />
                  Select Time
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {times.map((t) => {
                    const isDisabled = disabledTimes.has(t);
                    return (
                      <button
                        key={t}
                        disabled={isDisabled}
                        onClick={() => !isDisabled && setSelectedTime(t)}
                        className={`
                          py-3 px-4 rounded-xl border text-sm font-medium transition-all
                          ${isDisabled
                            ? 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed line-through opacity-50'
                            : selectedTime === t
                              ? 'bg-primary-600 border-primary-600 text-white shadow-md'
                              : 'border-slate-200 text-slate-600 hover:border-primary-300'
                          }
                        `}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Recurring Booking Option */}
              <div className="bg-accent-50 rounded-xl p-4 border border-accent-100">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center text-accent-800 font-semibold">
                    <Calendar className="w-5 h-5 mr-2 text-accent-600" />
                    Make This Recurring?
                  </div>
                  <button
                    onClick={() => setIsRecurring(!isRecurring)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      isRecurring ? 'bg-accent-500' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        isRecurring ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
                
                {isRecurring && (
                  <div className="space-y-3 animate-fade-in">
                    <div>
                      <label className="text-sm text-accent-700 font-medium">Repeat</label>
                      <div className="grid grid-cols-3 gap-2 mt-1">
                        {(['weekly', 'biweekly', 'monthly'] as const).map((freq) => (
                          <button
                            key={freq}
                            onClick={() => setRecurringFrequency(freq)}
                            className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                              recurringFrequency === freq
                                ? 'bg-accent-500 text-white'
                                : 'bg-white text-accent-700 border border-accent-200 hover:border-accent-400'
                            }`}
                          >
                            {freq === 'weekly' ? 'Weekly' : freq === 'biweekly' ? 'Bi-weekly' : 'Monthly'}
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    <div>
                      <label className="text-sm text-accent-700 font-medium">Until</label>
                      <select
                        value={recurringEndDate}
                        onChange={(e) => setRecurringEndDate(e.target.value)}
                        className="w-full mt-1 px-3 py-2 rounded-lg border border-accent-200 bg-white text-accent-900 focus:ring-2 focus:ring-accent-500 focus:border-accent-500"
                      >
                        <option value="">Select end date...</option>
                        {recurringEndOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    
                    <p className="text-xs text-accent-600">
                      This will book {calculateRecurringCount()} appointments total
                    </p>
                  </div>
                )}
              </div>

              {/* Rate Info & Action */}
              <div className="pt-4 border-t border-slate-100">
                <div className="flex justify-between items-center mb-4 text-sm bg-slate-50 p-3 rounded-lg">
                  <span className="text-slate-500">
                    {bookingType === 'task' ? 'Service Cost' : 'Hourly Rate'}
                  </span>
                  <span className="font-bold text-slate-900">
                    {bookingType === 'task'
                      ? (selectedTask ? `$${selectedTask.flatRate}` : '-')
                      : `$${caregiver.hourlyRate}/hr`
                    }
                  </span>
                </div>

                <Button
                  fullWidth
                  size="lg"
                  onClick={handleContinue}
                  disabled={!selectedDate || !selectedTime || (bookingType === 'task' && !selectedTask)}
                >
                  Continue
                </Button>
              </div>
            </div>
          ) : (
            /* STEP 2: CONFIRMATION */
            <div className="space-y-6 animate-slide-in">
              {/* Caregiver Summary Card */}
              <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 flex gap-4 items-center">
                <img
                  src={caregiver.imageUrl}
                  alt={caregiver.name}
                  className="w-16 h-16 rounded-xl object-cover border border-slate-200"
                />
                <div>
                  <h3 className="font-bold text-slate-900 text-lg">{caregiver.name}</h3>
                  {caregiver.verified && (
                    <div className="flex items-center text-xs text-blue-700 font-medium mt-1 bg-blue-100/50 px-2 py-0.5 rounded w-fit">
                      <ShieldCheck className="w-3 h-3 mr-1" />
                      Background Verified
                    </div>
                  )}
                  <div className="flex items-center text-xs text-slate-500 mt-1">
                    <MapPin className="w-3 h-3 text-slate-400 mr-1" />
                    {caregiver.distance} miles away
                  </div>
                </div>
              </div>

              {/* Appointment Details */}
              <div className="border-t border-b border-slate-100 py-4 space-y-3">
                <div className="flex justify-between items-center">
                  <div className="flex items-center text-slate-600">
                    <Calendar className="w-5 h-5 mr-3 text-primary-600" />
                    <span className="font-medium">Date</span>
                  </div>
                  <span className="font-bold text-slate-900">{selectedDate}</span>
                </div>
                <div className="flex justify-between items-center">
                  <div className="flex items-center text-slate-600">
                    <Clock className="w-5 h-5 mr-3 text-primary-600" />
                    <span className="font-medium">Time</span>
                  </div>
                  <span className="font-bold text-slate-900">{selectedTime}</span>
                </div>
                {isRecurring && (
                  <div className="flex justify-between items-center bg-accent-50 p-2 rounded-lg">
                    <div className="flex items-center text-accent-700">
                      <Calendar className="w-5 h-5 mr-3 text-accent-600" />
                      <span className="font-medium">Repeats {recurringFrequency}</span>
                    </div>
                    <span className="font-bold text-accent-900">{calculateRecurringCount()} visits</span>
                  </div>
                )}
              </div>

              {/* Cost Estimation */}
              <div className="bg-primary-50 p-4 rounded-xl border border-primary-100">
                <div className="flex justify-between items-end">
                  <div>
                    <p className="text-sm text-primary-800 font-bold mb-1">
                      {isRecurring ? `Estimated Total (${calculateRecurringCount()} visits)` : 'Estimated Total'}
                    </p>
                    <p className="text-xs text-primary-600">
                      {bookingType === 'task' && selectedTask
                        ? `${selectedTask.name} ($${selectedTask.flatRate}${isRecurring ? ' each' : ''})`
                        : `(3 hrs x $${caregiver.hourlyRate}${isRecurring ? ' each' : ''})`
                      }
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-3xl font-bold text-primary-700">
                      ${(bookingType === 'task' && selectedTask ? selectedTask.flatRate : caregiver.hourlyRate * 3) * (isRecurring ? calculateRecurringCount() : 1)}
                    </p>
                    {isRecurring && (
                      <p className="text-xs text-primary-600">
                        ${bookingType === 'task' && selectedTask ? selectedTask.flatRate : caregiver.hourlyRate * 3} per visit
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-2">
                <Button
                  fullWidth
                  size="lg"
                  onClick={handleConfirmBooking}
                  variant="primary"
                  className="bg-primary-600 hover:bg-primary-700 text-white shadow-lg shadow-primary-200"
                >
                  {isRecurring 
                    ? `Book ${calculateRecurringCount()} Appointments` 
                    : 'Confirm Booking'
                  }
                </Button>

                {/* Payment instructions */}
                <div className="mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <p className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1">
                    <Info className="w-3.5 h-3.5 text-slate-400" />
                    How to pay {caregiver.name.split(' ')[0]}
                  </p>
                  {caregiver.paymentPreferences ? (
                    <div className="flex flex-wrap gap-1.5">
                      {caregiver.paymentPreferences.venmo && (
                        <span className="px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 font-medium">
                          Venmo {caregiver.paymentPreferences.venmo}
                        </span>
                      )}
                      {caregiver.paymentPreferences.zelle && (
                        <span className="px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 font-medium">
                          Zelle {caregiver.paymentPreferences.zelle}
                        </span>
                      )}
                      {caregiver.paymentPreferences.cash && (
                        <span className="px-2 py-1 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700 font-medium">
                          Cash
                        </span>
                      )}
                      {caregiver.paymentPreferences.other && (
                        <span className="px-2 py-1 bg-slate-100 border border-slate-200 rounded-lg text-xs text-slate-600">
                          {caregiver.paymentPreferences.other}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">Pay directly via Venmo, Zelle, or cash after service is completed.</p>
                  )}
                </div>

                <button
                  onClick={() => setStep('select')}
                  className="w-full text-center text-slate-500 text-sm mt-4 hover:text-slate-700 hover:underline"
                >
                  Change Details
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  , document.body);
};
