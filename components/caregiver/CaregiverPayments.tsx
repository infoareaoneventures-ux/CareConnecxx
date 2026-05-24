import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  CreditCard,
  Clock,
  CheckCircle,
  AlertCircle,
  Lightbulb,
  Calendar,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { dbService, shiftHoursService } from '../../services/api';
import { db } from '../../lib/firebase';
import { AddToastFunction, Appointment } from '../../types';
import { SubmitShiftHoursModal, CompletedShift } from '../payroll/SubmitShiftHoursModal';

interface CaregiverPaymentsProps {
  caregiverId: string;
  caregiverName?: string;
  onShowToast?: AddToastFunction;
}

interface Timesheet {
  id: string;
  weekStart: string;
  weekEnd: string;
  totalHours: number;
  totalPay: number;
  status: 'pending' | 'approved' | 'paid' | 'disputed';
  submittedAt: string;
  clientName?: string;
}

export const CaregiverPayments: React.FC<CaregiverPaymentsProps> = ({
  caregiverId,
  caregiverName = 'Caregiver',
  onShowToast
}) => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'timesheets' | 'payment-method'>('timesheets');
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);

  // Payment preferences state
  const [payVenmo, setPayVenmo] = useState('');
  const [payZelle, setPayZelle] = useState('');
  const [payCash, setPayCash] = useState(false);
  const [payOther, setPayOther] = useState('');
  const [payPrefSaving, setPayPrefSaving] = useState(false);
  const [payPrefSaved, setPayPrefSaved] = useState(false);

  // Shift hours state (per-appointment, replaces weekly timesheets)
  const [shiftRows, setShiftRows] = useState<any[]>([]);
  const [completedShifts, setCompletedShifts] = useState<CompletedShift[]>([]);
  const [submitModalShift, setSubmitModalShift] = useState<CompletedShift | null>(null);

  useEffect(() => {
    if (!caregiverId) return;
    const unsub = shiftHoursService.subscribeForCaregiver(caregiverId, rows => setShiftRows(rows));
    return () => { try { (unsub as any)?.(); } catch {} };
  }, [caregiverId]);

  useEffect(() => {
    if (!caregiverId || !db) return;
    const unsub = db.collection('shifts')
      .where('caregiverId', '==', caregiverId)
      .where('status', '==', 'completed')
      .onSnapshot(snap => {
        setCompletedShifts(snap.docs.map(d => ({ id: d.id, ...d.data() } as CompletedShift)));
      });
    return () => unsub();
  }, [caregiverId]);

  const submittableAppts = useMemo(() => {
    const withShift = new Set(shiftRows.map(r => r.appointmentId));
    return completedShifts.filter(s => !withShift.has(s.id));
  }, [completedShifts, shiftRows]);

  const pendingRows = shiftRows.filter(r => ['pending_client_review', 'correction_proposed'].includes(r.status));
  const historyRows = shiftRows.filter(r => !['pending_client_review', 'correction_proposed'].includes(r.status));

  useEffect(() => {
    loadTimesheets();
    // Load existing payment preferences
    if (caregiverId && db) {
      db.collection('caregivers').doc(caregiverId).get()
        .then(doc => {
          const prefs = (doc.data() as any)?.paymentPreferences || {};
          setPayVenmo(prefs.venmo || '');
          setPayZelle(prefs.zelle || '');
          setPayCash(!!prefs.cash);
          setPayOther(prefs.other || '');
        })
        .catch(() => {});
    }
  }, [caregiverId]);

  const handleSavePayPrefs = async () => {
    if (!caregiverId || !db) return;
    setPayPrefSaving(true);
    try {
      await db.collection('caregivers').doc(caregiverId).update({
        paymentPreferences: {
          ...(payVenmo.trim() && { venmo: payVenmo.trim() }),
          ...(payZelle.trim() && { zelle: payZelle.trim() }),
          cash: payCash,
          ...(payOther.trim() && { other: payOther.trim() }),
        },
      });
      setPayPrefSaved(true);
      setTimeout(() => setPayPrefSaved(false), 3000);
      onShowToast?.('Payment preferences saved!', 'success');
    } catch {
      onShowToast?.('Failed to save preferences', 'error');
    } finally {
      setPayPrefSaving(false);
    }
  };

  const loadTimesheets = async () => {
    setLoading(true);
    try {
      // @ts-ignore - API method may not be fully typed yet
      const data = await dbService.getCaregiverTimesheets?.(caregiverId) || [];
      setTimesheets(data as any);
    } catch (error) {
      console.error('Failed to load timesheets:', error);
      // Set empty state - no mock data to match the "You have no pending timesheets" message
      setTimesheets([]);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: Timesheet['status']) => {
    switch (status) {
      case 'approved':
      case 'paid':
        return <CheckCircle className="w-4 h-4 text-[var(--color-success-600)]" />;
      case 'pending':
        return <Clock className="w-4 h-4 text-[var(--color-warning-600)]" />;
      case 'disputed':
        return <AlertCircle className="w-4 h-4 text-[var(--color-error-600)]" />;
      default:
        return null;
    }
  };

  const getStatusColor = (status: Timesheet['status']) => {
    switch (status) {
      case 'approved':
      case 'paid':
        return 'bg-[var(--color-success-50)] text-[var(--color-success-700)] border-[var(--color-success-200)]';
      case 'pending':
        return 'bg-[var(--color-warning-50)] text-[var(--color-warning-700)] border-[var(--color-warning-200)]';
      case 'disputed':
        return 'bg-[var(--color-error-50)] text-[var(--color-error-700)] border-[var(--color-error-200)]';
      default:
        return 'bg-[var(--color-neutral-50)] text-[var(--color-neutral-700)] border-[var(--color-neutral-200)]';
    }
  };

  const formatDateRange = (start: string, end: string) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[var(--color-neutral-900)]">Payments</h1>
      </div>

      {/* Tab Navigation */}
      <div className="flex space-x-2 bg-[var(--color-neutral-100)] p-1 rounded-xl mb-6">
        <button
          onClick={() => setActiveTab('timesheets')}
          className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all flex items-center justify-center ${
            activeTab === 'timesheets'
              ? 'bg-white text-[var(--color-neutral-900)] shadow-sm'
              : 'text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-700)]'
          }`}
        >
          <FileText className="w-4 h-4 mr-2" />
          Timesheets
        </button>
        <button
          onClick={() => setActiveTab('payment-method')}
          className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all flex items-center justify-center ${
            activeTab === 'payment-method'
              ? 'bg-white text-[var(--color-neutral-900)] shadow-sm'
              : 'text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-700)]'
          }`}
        >
          <CreditCard className="w-4 h-4 mr-2" />
          Payment Method
        </button>
      </div>

      {/* Timesheets Tab */}
      {activeTab === 'timesheets' && (
        <div className="space-y-6 animate-slide-in">
          {/* Reminder Box */}
          <div className="bg-[var(--color-info-50)] border border-[var(--color-info-100)] rounded-xl p-4 flex items-start gap-3">
            <div className="w-8 h-8 bg-[var(--color-info-100)] rounded-lg flex items-center justify-center flex-shrink-0">
              <Lightbulb className="w-4 h-4 text-[var(--color-info-600)]" />
            </div>
            <div>
              <p className="font-medium text-[var(--color-neutral-900)]">How this works</p>
              <p className="text-sm text-[var(--color-neutral-600)] mt-1">
                Submit hours after each shift. Clients have 24 hours to approve or propose a correction —
                after that, hours auto-approve and (for credit bookings) Stripe processes payment.
              </p>
            </div>
          </div>

          {/* 1. Submit hours */}
          <section>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Submit hours</h3>
            {submittableAppts.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500 text-center">
                No shifts waiting on you to submit hours.
              </div>
            ) : (
              <div className="space-y-2">
                {submittableAppts.map(shift => (
                  <div key={shift.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-slate-900">{shift.clientName}</p>
                      <p className="text-sm text-slate-500">{shift.date} · {shift.startTime}{shift.endTime ? ` – ${shift.endTime}` : ''} · {shift.paymentMethod === 'cash' ? 'Cash' : 'Credit'}</p>
                    </div>
                    <button
                      onClick={() => setSubmitModalShift(shift)}
                      className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700"
                    >
                      Submit hours
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 2. Pending / action needed */}
          <section>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Pending &amp; action needed</h3>
            {pendingRows.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500 text-center">
                Nothing pending.
              </div>
            ) : (
              <div className="space-y-2">
                {pendingRows.map(row => (
                  <PendingShiftRow
                    key={row.id}
                    row={row}
                    onRespond={async (action) => {
                      try {
                        await shiftHoursService.respondToCorrection(row.appointmentId, action);
                        onShowToast?.(action === 'accept' ? 'Correction accepted' : 'Sent to admin for review', 'success');
                      } catch (e: any) {
                        onShowToast?.(e?.message || 'Failed', 'error');
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {/* 3. History */}
          <section>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">History</h3>
            {historyRows.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500 text-center">
                No completed shifts yet.
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                {historyRows.map(row => (
                  <HistoryShiftRow key={row.id} row={row} />
                ))}
              </div>
            )}
          </section>

          {submitModalShift && (
            <SubmitShiftHoursModal
              shift={submitModalShift}
              onClose={() => setSubmitModalShift(null)}
              onSubmitted={() => { setSubmitModalShift(null); onShowToast?.('Hours submitted', 'success'); }}
              onError={msg => onShowToast?.(msg, 'error')}
            />
          )}
        </div>
      )}

      {/* Payment Method Tab */}
      {activeTab === 'payment-method' && (
        <div className="space-y-6 animate-slide-in">
          {/* Payment Preferences — how clients pay YOU */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100">
              <h3 className="font-bold text-slate-900">How Clients Pay You</h3>
              <p className="text-sm text-slate-500 mt-0.5">
                Families pay you directly after each visit. Set the methods you accept so they know how to send money.
              </p>
            </div>
            <div className="p-6 space-y-4">
              {/* Venmo */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Venmo username</label>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 font-medium">@</span>
                  <input
                    value={payVenmo.replace(/^@/, '')}
                    onChange={e => setPayVenmo('@' + e.target.value.replace(/^@/, ''))}
                    placeholder="your-venmo-handle"
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                  />
                </div>
              </div>
              {/* Zelle */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Zelle (phone or email)</label>
                <input
                  value={payZelle}
                  onChange={e => setPayZelle(e.target.value)}
                  placeholder="415-555-0100 or you@email.com"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                />
              </div>
              {/* Cash toggle */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium text-slate-700">Accept cash</p>
                  <p className="text-xs text-slate-400">Shown on your profile</p>
                </div>
                <button
                  onClick={() => setPayCash(v => !v)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${payCash ? 'bg-primary-600' : 'bg-slate-300'}`}
                >
                  <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${payCash ? 'translate-x-5' : ''}`} />
                </button>
              </div>
              {/* Other */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Other (PayPal, Apple Pay, etc.)</label>
                <input
                  value={payOther}
                  onChange={e => setPayOther(e.target.value)}
                  placeholder="PayPal @handle, Apple Pay 415-555-0100…"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                />
              </div>
              <button
                onClick={handleSavePayPrefs}
                disabled={payPrefSaving}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  payPrefSaved
                    ? 'bg-green-50 border border-green-200 text-green-700'
                    : 'bg-primary-600 hover:bg-primary-700 text-white'
                }`}
              >
                {payPrefSaved ? '✓ Saved' : payPrefSaving ? 'Saving…' : 'Save Payment Preferences'}
              </button>
            </div>
          </div>

          {/* Bank Account (managed via Stripe Connect) */}
          <div className="bg-white rounded-xl border border-[var(--color-neutral-200)] p-6">
            <h3 className="font-bold text-[var(--color-neutral-900)] mb-2">Bank Account</h3>
            <p className="text-sm text-[var(--color-neutral-600)] mb-4">
              Your payout bank account is managed securely through Stripe. Add or update your account from the Payouts page.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/caregiver/payout')}
            >
              <CreditCard className="w-4 h-4 mr-2" />
              Manage Bank Account
            </Button>
          </div>

          {/* Payout Schedule */}
          <div className="bg-white rounded-xl border border-[var(--color-neutral-200)] p-6">
            <h3 className="font-bold text-[var(--color-neutral-900)] mb-4 flex items-center gap-2">
              <Calendar className="w-5 h-5 text-[var(--color-primary-600)]" />
              Payout Schedule
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-[var(--color-neutral-50)] rounded-lg">
                <div>
                  <p className="font-medium text-[var(--color-neutral-900)]">Standard Payout</p>
                  <p className="text-sm text-[var(--color-neutral-500)]">Every Friday</p>
                </div>
                <span className="text-sm text-[var(--color-neutral-500)]">Free</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-[var(--color-primary-50)] rounded-lg border border-[var(--color-primary-200)]">
                <div>
                  <p className="font-medium text-[var(--color-neutral-900)]">Instant Payout</p>
                  <p className="text-sm text-[var(--color-neutral-500)]">Available 24/7</p>
                </div>
                <span className="text-sm text-[var(--color-primary-600)] font-medium">1.5% fee</span>
              </div>
            </div>
          </div>

          {/* Tax Info */}
          <div className="bg-[var(--color-neutral-50)] rounded-xl border border-[var(--color-neutral-200)] p-6">
            <h3 className="font-bold text-[var(--color-neutral-900)] mb-4">Tax Information</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[var(--color-neutral-600)]">Tax Form</span>
                <span className="font-medium text-[var(--color-neutral-900)]">1099-NEC</span>
              </div>
              <p className="text-sm text-[var(--color-neutral-500)]">
                Tax documents are issued annually through Stripe. You'll receive an email when your form is ready.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// --- helper row components for the shift-hours sections ---

const statusLabel: Record<string, string> = {
  pending_client_review: 'Pending client review',
  correction_proposed: 'Client proposed correction',
  approved: 'Approved',
  auto_approved: 'Auto-approved',
  disputed_admin_review: 'Admin reviewing',
  paid: 'Paid',
  payment_failed: 'Payment failed',
};

const PendingShiftRow: React.FC<{ row: any; onRespond: (action: 'accept' | 'reject') => void }> = ({ row, onRespond }) => {
  if (row.status === 'correction_proposed') {
    return (
      <div className="bg-primary-50 border border-primary-200 rounded-xl p-4">
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="font-medium text-slate-900">{row.clientName}</p>
            <p className="text-sm text-slate-600">
              You submitted <b>{row.submittedTotalHours}h</b> · Client proposed <b>{row.proposedTotalHours}h</b>
            </p>
            {row.proposalReason && (
              <p className="text-xs text-slate-500 mt-1">Reason: {row.proposalReason}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={() => onRespond('accept')} className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-sm font-medium">
            Accept {row.proposedTotalHours}h
          </button>
          <button onClick={() => onRespond('reject')} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium">
            Reject, send to admin
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
      <div>
        <p className="font-medium text-slate-900">{row.clientName}</p>
        <p className="text-sm text-slate-500">{row.submittedTotalHours}h submitted · auto-approves {new Date(row.autoApproveAt).toLocaleString()}</p>
      </div>
      <span className="text-xs text-slate-500">{statusLabel[row.status]}</span>
    </div>
  );
};

const HistoryShiftRow: React.FC<{ row: any }> = ({ row }) => {
  const hours = row.finalTotalHours ?? row.submittedTotalHours;
  const gross = row.grossPay ?? (hours * row.payRate);
  const paidTag = row.paymentMethod === 'cash' && (row.status === 'approved' || row.status === 'auto_approved')
    ? 'Approved (cash)'
    : statusLabel[row.status] || row.status;
  return (
    <div className="grid grid-cols-3 gap-4 px-6 py-4">
      <div>
        <p className="font-medium text-slate-900">{row.clientName}</p>
        <p className="text-sm text-slate-500">{new Date(row.submittedAt).toLocaleDateString()}</p>
      </div>
      <div>
        <span className="text-sm text-slate-700">{hours}h</span>
        <span className="block text-xs text-slate-500 mt-1">{paidTag}</span>
      </div>
      <div className="text-right">
        <p className="font-bold text-slate-900">${gross.toFixed(2)}</p>
        {row.status === 'payment_failed' && row.stripeFailureReason && (
          <p className="text-xs text-red-600 mt-1">{row.stripeFailureReason}</p>
        )}
      </div>
    </div>
  );
};

export default CaregiverPayments;
