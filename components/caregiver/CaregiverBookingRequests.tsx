import React, { useState, useEffect, useMemo } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import {
  CheckCircle, XCircle, Clock, MapPin, Calendar,
  DollarSign, User, AlertCircle, Loader2, Repeat,
} from 'lucide-react';
import type { Appointment } from '../../types';
import { dbService } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// A "request" is either a single appointment or the lead appointment for a recurring group.
interface GroupedRequest {
  groupId: string;          // recurringGroupId, or appointmentId for one-offs
  isRecurring: boolean;
  appointments: Appointment[];
  clientId: string;
  clientName: string;
  caregiverName: string;
  firstDate: string;
  lastDate: string;
  daysOfWeek: string[];
  totalCost: number;
  location?: string;
  requestedAt: string;
}

function buildGroups(appts: Appointment[]): GroupedRequest[] {
  const grouped: Record<string, Appointment[]> = {};

  for (const a of appts) {
    const key = a.recurringGroupId || a.id;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(a);
  }

  return Object.entries(grouped).map(([key, list]) => {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const first = list[0];
    const last = list[list.length - 1];

    // Collect unique day names across the series
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const daySet = new Set(list.map(a => DAY_NAMES[new Date(a.date + 'T12:00:00').getDay()]));

    return {
      groupId: key,
      isRecurring: list.length > 1 || !!first.recurringGroupId,
      appointments: list,
      clientId: first.clientId || '',
      clientName: first.clientName,
      caregiverName: first.caregiverName,
      firstDate: first.date,
      lastDate: last.date,
      daysOfWeek: Array.from(daySet),
      totalCost: list.reduce((s, a) => s + (a.cost || 0), 0),
      location: first.location || first.address,
      requestedAt: (first as any).createdAt || new Date().toISOString(),
    };
  });
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

interface Props {
  caregiverId: string;
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const CaregiverBookingRequests: React.FC<Props> = ({ caregiverId, onShowToast }) => {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const { currentUser } = useCareConnex();

  const groups = useMemo(() => buildGroups(appointments), [appointments]);

  const fetchRequests = async () => {
    if (!caregiverId) return;
    try {
      const pending = await dbService.getPendingBookingRequests(caregiverId);
      setAppointments(pending);
    } catch (err) {
      console.error('Failed to fetch booking requests:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
    const interval = setInterval(fetchRequests, 30000);
    return () => clearInterval(interval);
  }, [caregiverId]);

  const removeGroup = (groupId: string) => {
    setAppointments(prev =>
      prev.filter(a => (a.recurringGroupId || a.id) !== groupId),
    );
  };

  const handleAccept = async (group: GroupedRequest) => {
    setProcessingId(group.groupId);
    try {
      if (group.isRecurring && group.appointments[0].recurringGroupId) {
        await (dbService as any).confirmRecurringGroup(
          group.appointments[0].recurringGroupId,
          caregiverId,
          group.clientId,
          group.clientName,
          group.caregiverName,
        );
      } else {
        const appt = group.appointments[0];
        await dbService.updateAppointment(appt.id, {
          status: 'confirmed',
          caregiverConfirmedAt: new Date().toISOString(),
        });
        await dbService.createNotification({
          userId: group.clientId,
          type: 'booking',
          title: 'Booking Confirmed!',
          message: `${group.caregiverName} accepted your booking for ${fmtDate(group.firstDate)}.`,
          data: { appointmentId: appt.id },
        });
      }

      removeGroup(group.groupId);
      onShowToast('Booking accepted! The client has been notified.', 'success');
    } catch (err) {
      console.error('Accept failed:', err);
      onShowToast('Failed to accept booking. Please try again.', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  const handleDecline = async (group: GroupedRequest) => {
    setProcessingId(group.groupId);
    try {
      if (group.isRecurring && group.appointments[0].recurringGroupId) {
        await (dbService as any).declineRecurringGroup(
          group.appointments[0].recurringGroupId,
          caregiverId,
          group.clientId,
          group.caregiverName,
        );
      } else {
        const appt = group.appointments[0];
        await dbService.updateAppointment(appt.id, {
          status: 'cancelled',
          cancelledBy: 'caregiver',
          caregiverDeclinedAt: new Date().toISOString(),
          cancellationReason: 'Caregiver declined',
        });
        await dbService.createNotification({
          userId: group.clientId,
          type: 'alert',
          title: 'Booking Declined',
          message: `${group.caregiverName} is unable to accept your booking for ${fmtDate(group.firstDate)}.`,
          data: { appointmentId: appt.id },
        });
      }

      removeGroup(group.groupId);
      onShowToast('Booking declined. The client will be notified.', 'info');
    } catch (err) {
      console.error('Decline failed:', err);
      onShowToast('Failed to decline booking. Please try again.', 'error');
    } finally {
      setProcessingId(null);
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
        </div>
      </Card>
    );
  }

  if (groups.length === 0) {
    return (
      <Card className="p-6">
        <div className="text-center py-8">
          <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Calendar className="w-8 h-8 text-slate-400" />
          </div>
          <h3 className="text-lg font-semibold text-slate-900 mb-2">No Booking Requests</h3>
          <p className="text-slate-500 text-sm">
            When clients request to book you, they'll appear here for you to accept or decline.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-slate-900">Booking Requests</h2>
        <span className="bg-primary-100 text-primary-800 text-xs font-semibold px-3 py-1 rounded-full">
          {groups.length} pending
        </span>
      </div>

      {groups.map(group => {
        const isProcessing = processingId === group.groupId;
        const n = group.appointments.length;

        return (
          <Card key={group.groupId} className="p-5 border-l-4 border-l-accent-500">
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <User className="w-6 h-6 text-primary-600" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900">{group.clientName}</h3>
                  <p className="text-sm text-slate-500">
                    Requested {new Date(group.requestedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-primary-500" />
                <span className="text-sm text-primary-600 font-medium">Awaiting response</span>
              </div>
            </div>

            {/* Details */}
            <div className="bg-slate-50 rounded-xl p-4 mb-4 space-y-2">
              {group.isRecurring ? (
                <>
                  <div className="flex items-center gap-2 text-slate-700">
                    <Repeat className="w-4 h-4 text-primary-600" />
                    <span className="font-semibold">
                      Recurring — {n} date{n !== 1 ? 's' : ''} ({group.daysOfWeek.join(', ')})
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-600 text-sm pl-6">
                    <span>{fmtDate(group.firstDate)} → {fmtDate(group.lastDate)}</span>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-slate-700">
                  <Calendar className="w-4 h-4 text-primary-600" />
                  <span className="font-medium">
                    {fmtDate(group.firstDate)} · {group.appointments[0].time} · {group.appointments[0].duration}h
                  </span>
                </div>
              )}

              {group.location && (
                <div className="flex items-center gap-2 text-slate-700">
                  <MapPin className="w-4 h-4 text-primary-600" />
                  <span className="text-sm">{group.location}</span>
                </div>
              )}

              <div className="flex items-center gap-2 text-slate-700">
                <DollarSign className="w-4 h-4 text-primary-600" />
                <span className="font-semibold">
                  ${group.totalCost.toFixed(2)} total
                  {group.isRecurring && <span className="text-xs text-slate-500 font-normal ml-1">({n} sessions)</span>}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3">
              <Button
                variant="secondary"
                className="flex-1 bg-red-50 text-red-700 hover:bg-red-100 border-red-200"
                onClick={() => handleDecline(group)}
                disabled={isProcessing}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <><XCircle className="w-4 h-4 mr-2" />Decline</>
                )}
              </Button>
              <Button
                className="flex-1 bg-primary-600 hover:bg-primary-700 text-white"
                onClick={() => handleAccept(group)}
                disabled={isProcessing}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <><CheckCircle className="w-4 h-4 mr-2" />Accept</>
                )}
              </Button>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs text-primary-600 bg-primary-50 p-2 rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>Please respond within 24 hours to maintain your response rate</span>
            </div>
          </Card>
        );
      })}
    </div>
  );
};
