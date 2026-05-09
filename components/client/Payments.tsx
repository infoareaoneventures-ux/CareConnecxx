import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Check, X, Clock, DollarSign, CreditCard, Download } from 'lucide-react';
import { Button } from '../ui/Button';
import { ClientNavigation } from './ClientNavigation';
import { useCareConnex } from '../../context/CareConnexContext';
import { auth, db } from '../../lib/firebase';
import firebase from 'firebase/compat/app';
import { dbService } from '../../services/api';

type TabType = 'weekly-summary' | 'invoices' | 'timesheets' | 'payment-method' | 'financial-activity';

interface TimesheetEntry {
  id: string;
  caregiverId: string;
  caregiverName: string;
  caregiverImage?: string;
  date: string;
  hours: number;
  hourlyRate: number;
  total: number;
  status: 'pending' | 'approved' | 'paid';
  submittedAt: string;
}

interface BillingEntry {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: 'paid' | 'pending' | 'failed';
}

interface PaymentCard {
  id: string;
  last4: string;
  brand: string;
  expiryMonth: string;
  expiryYear: string;
}

interface BankAccount {
  id: string;
  accountType: 'checking' | 'savings';
  last4: string;
  bankName: string;
}

export const Payments: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();
  const [activeTab, setActiveTab] = useState<TabType>('weekly-summary');
  const [loadingData, setLoadingData] = useState(true);

  const [timesheets, setTimesheets] = useState<TimesheetEntry[]>([]);
  const [billingHistory, setBillingHistory] = useState<BillingEntry[]>([]);

  // Load real data from Firestore
  useEffect(() => {
    let isMounted = true;
    const loadPaymentData = async () => {
      const user = auth.currentUser;
      if (!user) { setLoadingData(false); return; }
      try {
        // Load timesheets submitted by caregivers for this client
        const tsSnap = await db.collection('timesheets')
          .where('clientId', '==', user.uid)
          .orderBy('submittedAt', 'desc')
          .limit(50)
          .get();
        const tsList: TimesheetEntry[] = tsSnap.docs.map(doc => {
          const d = doc.data();
          return {
            id: doc.id,
            caregiverId: d.caregiverId || d.caregiverUid || '',
            caregiverName: d.caregiverName || 'Caregiver',
            caregiverImage: d.caregiverImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(d.caregiverName || 'C')}&background=14b8a6&color=fff`,
            date: d.date || '',
            hours: d.hours || 0,
            hourlyRate: d.hourlyRate || 0,
            total: d.total || (d.hours * d.hourlyRate) || 0,
            status: d.status || 'pending',
            submittedAt: d.submittedAt?.toDate?.()?.toLocaleDateString() || d.submittedAt || '',
          };
        });

        // Load billing history (membership payments)
        const billSnap = await db.collection('payments')
          .where('userId', '==', user.uid)
          .orderBy('createdAt', 'desc')
          .limit(24)
          .get();
        const billList: BillingEntry[] = billSnap.docs.map(doc => {
          const d = doc.data();
          return {
            id: doc.id,
            date: d.createdAt?.toDate?.()?.toLocaleDateString() || d.date || '',
            description: d.description || 'Membership',
            amount: d.amount || 0,
            status: d.status || 'paid',
          };
        });

        if (!isMounted) return;
        setTimesheets(tsList);
        setBillingHistory(billList);
      } catch (err) {
        console.error('Error loading payment data:', err);
        if (isMounted) addToast('Failed to load payment data. Please refresh.', 'error');
      } finally {
        if (isMounted) setLoadingData(false);
      }
    };
    loadPaymentData();
    return () => { isMounted = false; };
  }, []);

  const handleApproveTimesheet = async (id: string) => {
    try {
      await db.collection('timesheets').doc(id).update({
        status: 'approved',
        approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      const timesheet = timesheets.find(t => t.id === id);
      setTimesheets(prev => prev.map(t => t.id === id ? { ...t, status: 'approved' } : t));
      addToast('Timesheet approved', 'success');

      if (timesheet?.caregiverId) {
        try {
          await dbService.createNotification({
            userId: timesheet.caregiverId,
            type: 'timesheet_approved',
            title: 'Timesheet Approved',
            message: `Your timesheet for ${timesheet.hours} hours ($${timesheet.total.toFixed(2)}) has been approved.`,
            data: { timesheetId: id }
          });
        } catch { /* non-critical */ }
      }
    } catch {
      addToast('Failed to approve timesheet. Please try again.', 'error');
    }
  };

  const handleRejectTimesheet = async (id: string) => {
    try {
      await db.collection('timesheets').doc(id).update({
        status: 'rejected',
        rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      const timesheet = timesheets.find(t => t.id === id);
      setTimesheets(prev => prev.filter(t => t.id !== id));
      addToast('Timesheet rejected', 'info');

      if (timesheet?.caregiverId) {
        try {
          await dbService.createNotification({
            userId: timesheet.caregiverId,
            type: 'timesheet_rejected',
            title: 'Timesheet Needs Revision',
            message: `Your timesheet for ${timesheet.hours} hours was rejected. Please contact the client for details.`,
            data: { timesheetId: id }
          });
        } catch { /* non-critical */ }
      }
    } catch {
      addToast('Failed to reject timesheet. Please try again.', 'error');
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: 'bg-yellow-100 text-yellow-700',
      approved: 'bg-blue-100 text-blue-700',
      paid: 'bg-green-100 text-green-700',
      failed: 'bg-red-100 text-red-700'
    };
    return styles[status as keyof typeof styles] || styles.pending;
  };

  return (
    <div className="min-h-screen bg-[var(--color-neutral-50)]">
      <ClientNavigation />
      
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-32">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-[var(--color-neutral-900)]">Payments</h1>
          <p className="text-[var(--color-neutral-600)] mt-2">Manage timesheets, billing, and payment methods</p>
        </div>

        {/* Tabs */}
        <div className="bg-slate-50 rounded-t-2xl border border-slate-200 border-b-0 p-2">
          <div className="flex overflow-x-auto scrollbar-hide gap-1">
            {[
              { id: 'weekly-summary', label: 'Weekly Summary', icon: FileText },
              { id: 'invoices', label: 'Invoices', icon: FileText },
              { id: 'timesheets', label: 'Timesheets', icon: Clock },
              { id: 'payment-method', label: 'Payment', icon: CreditCard },
              { id: 'financial-activity', label: 'Activity', icon: DollarSign }
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id as TabType)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs sm:text-sm font-medium whitespace-nowrap transition-all duration-200 flex-shrink-0 ${
                  activeTab === id 
                    ? 'bg-white text-primary-600 shadow-sm border border-primary-200' 
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div className="bg-white rounded-b-2xl border border-slate-200 border-t-0 shadow-sm min-h-[400px]">
          
          {/* Weekly Summary Tab */}
          {activeTab === 'weekly-summary' && (
            <div className="p-4 sm:p-6">
              <h2 className="text-xl font-bold text-[var(--color-neutral-900)] mb-6">Weekly Summary</h2>
              <div className="text-center py-12">
                <DollarSign className="w-12 h-12 text-[var(--color-neutral-400)] mx-auto mb-4" />
                <p className="text-[var(--color-neutral-600)] mb-2">No weekly summary yet</p>
                <p className="text-sm text-[var(--color-neutral-500)]">Your weekly care spending will appear here</p>
              </div>
            </div>
          )}

          {/* Invoices Tab */}
          {activeTab === 'invoices' && (
            <div className="p-4 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-2">
                <h2 className="text-xl font-bold text-slate-900">Your Invoices</h2>
                <p className="text-sm text-slate-500">48-hour auto-approval window</p>
              </div>
              <div className="text-center py-12 bg-slate-50 rounded-xl border border-slate-100">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <FileText className="w-8 h-8 text-slate-400" />
                </div>
                <p className="text-slate-600 font-medium mb-1">No pending invoices</p>
                <p className="text-sm text-slate-500">Invoices will appear here when caregivers submit timesheets</p>
              </div>
            </div>
          )}

          {/* Timesheets Tab */}
          {activeTab === 'timesheets' && (
            <div>
              <h2 className="text-xl font-bold text-[var(--color-neutral-900)] mb-4">Pending Timesheets</h2>
              {timesheets.length === 0 ? (
                <div className="text-center py-12">
                  <FileText className="w-12 h-12 text-[var(--color-neutral-400)] mx-auto mb-4" />
                  <p className="text-[var(--color-neutral-600)]">You have no pending timesheet entries</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {timesheets.map(timesheet => (
                    <div key={timesheet.id} className="border border-[var(--color-neutral-200)] rounded-xl p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center space-x-3">
                          <img src={timesheet.caregiverImage} alt={timesheet.caregiverName} className="w-10 h-10 rounded-full" />
                          <div>
                            <h3 className="font-semibold text-[var(--color-neutral-900)]">{timesheet.caregiverName}</h3>
                            <p className="text-sm text-[var(--color-neutral-600)]">Submitted {timesheet.submittedAt}</p>
                          </div>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusBadge(timesheet.status)}`}>
                          {timesheet.status.charAt(0).toUpperCase() + timesheet.status.slice(1)}
                        </span>
                      </div>
                      <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <p className="text-[var(--color-neutral-500)]">Date</p>
                          <p className="font-medium text-[var(--color-neutral-900)]">{timesheet.date}</p>
                        </div>
                        <div>
                          <p className="text-[var(--color-neutral-500)]">Hours</p>
                          <p className="font-medium text-[var(--color-neutral-900)]">{timesheet.hours} hrs @ ${timesheet.hourlyRate}/hr</p>
                        </div>
                        <div>
                          <p className="text-[var(--color-neutral-500)]">Total</p>
                          <p className="font-medium text-[var(--color-primary-600)]">${timesheet.total}</p>
                        </div>
                      </div>
                      {timesheet.status === 'pending' && (
                        <div className="mt-4 flex space-x-3">
                          <Button variant="secondary" onClick={() => handleRejectTimesheet(timesheet.id)} className="flex-1">
                            <X className="w-4 h-4 mr-2" />Reject
                          </Button>
                          <Button onClick={() => handleApproveTimesheet(timesheet.id)} className="flex-1">
                            <Check className="w-4 h-4 mr-2" />Approve
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}


          {/* Payment Method Tab */}
          {activeTab === 'payment-method' && (
            <div className="p-4 sm:p-6">
              <h2 className="text-xl font-bold text-[var(--color-neutral-900)] mb-6">Payment</h2>
              <div className="text-center py-12">
                <DollarSign className="w-12 h-12 text-[var(--color-neutral-400)] mx-auto mb-4" />
                <p className="text-[var(--color-neutral-600)] mb-2">No payment methods yet</p>
                <p className="text-sm text-[var(--color-neutral-500)]">Payment methods will appear here</p>
              </div>
            </div>
          )}

          {/* Financial Activity Tab */}
          {activeTab === 'financial-activity' && (
            <div>
              <h2 className="text-xl font-bold text-[var(--color-neutral-900)] mb-6">Financial Activity</h2>
              <div className="text-center py-12">
                <DollarSign className="w-12 h-12 text-[var(--color-neutral-400)] mx-auto mb-4" />
                <p className="text-[var(--color-neutral-600)] mb-2">No financial activity yet</p>
                <p className="text-sm text-[var(--color-neutral-500)]">Payments and transactions will appear here</p>
              </div>
            </div>
          )}
        </div>
      </main>

    </div>
  );
};
