import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  CreditCard,
  Lightbulb,
  Calendar,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { shiftHoursService } from '../../services/api';
import { db } from '../../lib/firebase';
import { AddToastFunction, Appointment, isOfflinePaymentMethod, paymentMethodLabel } from '../../types';
import { SubmitShiftHoursModal, CompletedShift } from '../payroll/SubmitShiftHoursModal';

interface CaregiverPaymentsProps {
  caregiverId: string;
  caregiverName?: string;
  onShowToast?: AddToastFunction;
}

// U4 (2026-07-20): the legacy Timesheet interface + timesheets state/fetch and
// their unused status helpers were removed. This page renders canonical
// shiftHours data (shiftRows/pendingRows/historyRows). The "Timesheets" tab
// label is kept intentionally — it is the familiar caregiver-facing wording.

export const CaregiverPayments: React.FC<CaregiverPaymentsProps> = ({
  caregiverId,
  caregiverName = 'Caregiver',
  onShowToast
}) => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'timesheets' | 'payment-method'>('timesheets');

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
                      <p className="text-sm text-slate-500">{shift.date} · {shift.startTime}{shift.endTime ? ` – ${shift.endTime}` : ''} · {paymentMethodLabel(shift.paymentMethod)}</p>
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
                    onRespond={async (action: 'accept' | 'counter_propose') => {
                      try {
                        await shiftHoursService.respondToCorrection(row.appointmentId, action);
                        onShowToast?.(action === 'accept' ? 'Correction accepted' : 'Counter-proposal sent to client', 'success');
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
                  <p className="font-medium text-[var(--color-neutral-900)]">Automatic Payout</p>
                  <p className="text-sm text-[var(--color-neutral-500)]">Daily — arrives ~2 business days after each visit is paid</p>
                </div>
                <span className="text-sm text-[var(--color-neutral-500)]">Free</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-[var(--color-primary-50)] rounded-lg border border-[var(--color-primary-200)]">
                <div>
                  <p className="font-medium text-[var(--color-neutral-900)]">Instant Payout</p>
                  <p className="text-sm text-[var(--color-neutral-500)]">Available 24/7 — arrives in ~30 minutes</p>
                </div>
                <span className="text-sm text-[var(--color-primary-600)] font-medium">Free</span>
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

const PendingShiftRow: React.FC<{ row: any; onRespond: (action: 'accept' | 'counter_propose') => void }> = ({ row, onRespond }) => {
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
          <button onClick={() => onRespond('counter_propose')} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium">
            Counter / send back
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
  const paidTag = isOfflinePaymentMethod(row.paymentMethod) && (row.status === 'approved' || row.status === 'auto_approved')
    ? `Approved (${paymentMethodLabel(row.paymentMethod).toLowerCase()})`
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
