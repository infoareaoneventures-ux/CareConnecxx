
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertOctagon, CalendarX } from 'lucide-react';
import { Button } from './ui/Button';
import { dbService } from '../services/api';
import { AddToastFunction, Appointment } from '../types';

interface CancellationModalProps {
  appointment: Appointment;
  onClose: () => void;
  onSuccess: () => void;
  onShowToast: AddToastFunction;
  cancelledBy: 'client' | 'caregiver';
}

export const CancellationModal: React.FC<CancellationModalProps> = ({ appointment, onClose, onSuccess, onShowToast, cancelledBy }) => {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  // Simple policy check: is it within 24 hours?
  const apptDate = new Date(`${appointment.isoDate}T${convertTime12to24(appointment.time)}`);
  const now = new Date();
  const diffHours = (apptDate.getTime() - now.getTime()) / (1000 * 60 * 60);
  const isLateCancel = diffHours < 24 && diffHours > 0;
  const isPastAppointment = diffHours < 0;

  function convertTime12to24(time12h: string) {
    const [time, modifier] = time12h.split(' ');
    let [hours, minutes] = time.split(':');
    if (hours === '12') hours = '00';
    if (modifier === 'PM') hours = (parseInt(hours, 10) + 12).toString();
    return `${hours}:${minutes}`;
  }

  const handleCancel = async () => {
      // BUG FIX: Check if appointment is in the past
      if (isPastAppointment) {
          onShowToast("Cannot cancel appointments that have already passed.", 'error');
          return;
      }

      setLoading(true);
      try {
          await dbService.cancelAppointment(appointment.id, reason, cancelledBy);
          onShowToast("Appointment cancelled.", 'info');
          onSuccess();
          onClose();
      } catch (e) {
          onShowToast("Failed to cancel.", 'error');
      } finally {
          setLoading(false);
      }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 animate-slide-in">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
          <X size={24} />
        </button>

        <div className="flex items-center gap-3 mb-6">
           <div className="bg-red-100 p-2 rounded-full">
             <CalendarX className="w-6 h-6 text-red-600" />
           </div>
           <h2 className="text-2xl font-bold text-slate-900">Cancel Appointment</h2>
        </div>

        {isPastAppointment && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 flex gap-3">
                <AlertOctagon className="w-5 h-5 text-red-600 flex-shrink-0" />
                <p className="text-sm text-red-800">
                    <strong>Past Appointment:</strong> This appointment has already passed and cannot be cancelled.
                </p>
            </div>
        )}

        {isLateCancel && cancelledBy === 'client' && !isPastAppointment && (
            <div className="bg-accent-50 border border-accent-200 rounded-xl p-4 mb-4 flex gap-3">
                <AlertOctagon className="w-5 h-5 text-accent-600 flex-shrink-0" />
                <p className="text-sm text-accent-800">
                    <strong>Late Cancellation Warning:</strong> Cancelling within 24 hours of the start time may incur a $20 fee to compensate the caregiver.
                </p>
            </div>
        )}

        <div className="space-y-4">
            <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Reason for Cancellation</label>
                <select 
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-red-100"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                >
                    <option value="">Select a reason...</option>
                    <option value="sick">Medical / Health Issue</option>
                    <option value="schedule">Scheduling Conflict</option>
                    <option value="found_other">Found Alternative Care</option>
                    <option value="emergency">Family Emergency</option>
                    <option value="other">Other</option>
                </select>
            </div>

            <p className="text-sm text-slate-500">
                Are you sure you want to cancel your appointment with <strong>{appointment.caregiverName}</strong> on {appointment.date}?
            </p>

            <div className="flex gap-3 pt-2">
                <Button variant="secondary" fullWidth onClick={onClose}>Keep</Button>
                <Button
                    fullWidth
                    onClick={handleCancel}
                    disabled={!reason || loading || isPastAppointment}
                    className="bg-red-600 hover:bg-red-700 text-white border-none"
                >
                    {loading ? 'Processing...' : 'Confirm Cancellation'}
                </Button>
            </div>
        </div>
      </div>
    </div>
  , document.body);
};
