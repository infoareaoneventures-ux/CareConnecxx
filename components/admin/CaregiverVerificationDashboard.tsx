import React, { useState, useEffect } from 'react';
import { Shield, Check, X, Clock, User, FileText, AlertCircle, Search, ChevronRight, ExternalLink, Car } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { dbService, adminService } from '../../services/api';
import { documentUploadService, DocumentType } from '../../services/documentUpload';
import { Caregiver, CaregiverDocuments } from '../../types';
import { isCaregiverBookable, UNBOOKABLE_BG_STATUSES } from '../../utils/caregiverEligibility';

interface VerificationQueueItem extends Omit<Caregiver, 'backgroundCheckData'> {
  submittedAt?: string;
  backgroundCheckData?: {
    legalFirstName?: string;
    legalLastName?: string;
    zip?: string;
    state?: string;
    consentGiven?: boolean;
    submittedAt?: string;
    status?: string;           // pending | clear | consider | suspended | canceled | disputed | pre_adverse_action | rejected | post_adverse_action
    invitationStatus?: string; // sent | completed | expired | canceled | error
    checkrReportId?: string;
    checkrCandidateId?: string;
    checkrClearedAt?: string;
    initiatedVia?: string;
    documents?: string[];      // legacy
  };
}

type VerificationFilter = 'exceptions' | 'pending' | 'approved' | 'rejected' | 'all';

// 'checkr_clear' is the legacy webhook value written before functions/src/checkr.ts
// started auto-approving clear results (verificationStatus → 'approved'). Both
// display as approved — no manual "Approve" action is required for them.
const APPROVED_VERIFICATION_STATUSES = ['approved', 'checkr_clear'];
const PENDING_VERIFICATION_STATUSES = ['submitted', 'pending', 'info_requested'];

const isApprovedVerification = (item: VerificationQueueItem): boolean =>
  APPROVED_VERIFICATION_STATUSES.includes(item.verificationStatus || '');

/**
 * The manual-review (exception) queue: docs/profile review still pending, or the
 * background check landed in an exception state (canonical UNBOOKABLE_BG_STATUSES).
 * Final rejections are excluded — they live in the Rejected view.
 */
const isExceptionCase = (item: VerificationQueueItem): boolean => {
  const vs = item.verificationStatus || '';
  const bg = item.backgroundCheckData?.status || '';
  if (vs === 'rejected') return false;
  return (
    PENDING_VERIFICATION_STATUSES.includes(vs) ||
    vs === 'pre_adverse_action' ||
    UNBOOKABLE_BG_STATUSES.includes(bg)
  );
};

/** Evia-onboarded caregivers have random doc ids with no uid — prefer the doc id. */
const getDocId = (item: VerificationQueueItem): string => (item.id || item.uid)!;

interface CaregiverVerificationDashboardProps {
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

/**
 * Admin Dashboard for Caregiver Verification Exceptions
 *
 * Checkr-clear caregivers are AUTO-approved by the webhook (functions/src/checkr.ts
 * sets verified=true, verificationStatus='approved', status='active') — they need
 * no manual action here. This dashboard exists for the exceptions: pending docs
 * review and background checks in consider/suspended/canceled/disputed/
 * pre_adverse_action/rejected/post_adverse_action states.
 */
export const CaregiverVerificationDashboard: React.FC<CaregiverVerificationDashboardProps> = ({
  onShowToast
}) => {
  const [queue, setQueue] = useState<VerificationQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCaregiver, setSelectedCaregiver] = useState<VerificationQueueItem | null>(null);
  const [filter, setFilter] = useState<VerificationFilter>('exceptions');
  const [searchTerm, setSearchTerm] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [transportDocExpiry, setTransportDocExpiry] = useState<Record<string, string>>({});
  const [docActionProcessing, setDocActionProcessing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadVerificationQueue();
  }, [filter]);

  // Live refresh: when a caregiver's verification status changes (Checkr webhook
  // or an Evia/admin action), re-pull the queue so the dashboard reflects it
  // without a manual reload. A doc entering OR leaving these pending states
  // fires the listener, which covers the common "moved to approved" transition.
  useEffect(() => {
    const unsub = dbService.subscribeCaregiverVerificationChanges(() => { loadVerificationQueue(); });
    return () => { try { (unsub as any)?.(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Identity PII moved off the world-readable caregiver doc into
  // caregivers/{uid}/private/background. Merge it into the selected caregiver
  // so the detail view renders; parent values are a pre-backfill fallback.
  useEffect(() => {
    const uid = (selectedCaregiver as any)?.id || (selectedCaregiver as any)?.uid;
    if (!uid) return;
    let cancelled = false;
    (async () => {
      const pii = await adminService.getCaregiverBackgroundPII(uid);
      if (cancelled || !pii || Object.keys(pii).length === 0) return;
      setSelectedCaregiver(prev => {
        const pid = (prev as any)?.id || (prev as any)?.uid;
        if (!prev || pid !== uid) return prev;
        return { ...prev, backgroundCheckData: { ...(prev as any).backgroundCheckData, ...pii } } as VerificationQueueItem;
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(selectedCaregiver as any)?.id, (selectedCaregiver as any)?.uid]);

  const loadVerificationQueue = async () => {
    setLoading(true);
    try {
      const caregivers = await dbService.getCaregiversForVerification(filter);
      setQueue(caregivers as VerificationQueueItem[]);
    } catch (error) {
      console.error('Failed to load verification queue:', error);
      onShowToast('Failed to load verification queue', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (caregiver: VerificationQueueItem) => {
    setIsProcessing(true);
    try {
      // Mirror the Checkr auto-approval contract (functions/src/checkr.ts):
      // verified + verificationStatus 'approved' + status 'active'
      await dbService.updateUser('caregivers', getDocId(caregiver), {
        verificationStatus: 'approved',
        verified: true,
        status: 'active', // not on the Caregiver TS type, but the canonical Firestore field the Checkr webhook writes
        onboardingStep: 3,
        approvedAt: new Date().toISOString(),
        approvedBy: 'admin', // Current admin ID
        reviewNotes: reviewNotes
      } as Partial<Caregiver>);

      // The caregiver is told by the server (onCaregiverAccountChange — bell +
      // text, once) from the record change above.

      onShowToast(`${caregiver.name} has been approved`, 'success');
      setSelectedCaregiver(null);
      setReviewNotes('');
      loadVerificationQueue();
    } catch (error) {
      console.error('Failed to approve caregiver:', error);
      onShowToast('Failed to approve caregiver', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async (caregiver: VerificationQueueItem) => {
    if (!reviewNotes) {
      onShowToast('Please provide a reason for rejection', 'error');
      return;
    }

    setIsProcessing(true);
    try {
      await dbService.updateUser('caregivers', getDocId(caregiver), {
        verificationStatus: 'rejected',
        verified: false,
        onboardingStep: 2,
        rejectedAt: new Date().toISOString(),
        rejectedBy: 'admin',
        rejectionReason: reviewNotes
      });

      // Told by the server (onCaregiverAccountChange: "Background check not
      // approved"); the site sends no reason.

      onShowToast(`${caregiver.name} has been rejected`, 'info');
      setSelectedCaregiver(null);
      setReviewNotes('');
      loadVerificationQueue();
    } catch (error) {
      console.error('Failed to reject caregiver:', error);
      onShowToast('Failed to reject caregiver', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRequestMoreInfo = async (caregiver: VerificationQueueItem) => {
    setIsProcessing(true);
    try {
      await dbService.updateUser('caregivers', getDocId(caregiver), {
        verificationStatus: 'info_requested',
        infoRequestNotes: reviewNotes,
        infoRequestedAt: new Date().toISOString()
      });

      // Told by the server (onCaregiverAccountChange) from the record change above.

      onShowToast(`Information requested from ${caregiver.name}`, 'info');
      setSelectedCaregiver(null);
      setReviewNotes('');
      loadVerificationQueue();
    } catch (error) {
      console.error('Failed to request info:', error);
      onShowToast('Failed to request information', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDocAction = async (
    caregiverId: string,
    docType: DocumentType,
    action: 'approved' | 'rejected',
  ) => {
    const key = `${caregiverId}_${docType}`;
    setDocActionProcessing(prev => ({ ...prev, [key]: true }));
    try {
      await documentUploadService.updateDocumentStatus(
        caregiverId,
        docType,
        action,
        undefined,
        'admin',
        transportDocExpiry[`${docType}`] || undefined,
      );
      onShowToast(`${docType} ${action}`, action === 'approved' ? 'success' : 'info');

      loadVerificationQueue();
    } catch {
      onShowToast('Failed to update document status', 'error');
    } finally {
      setDocActionProcessing(prev => ({ ...prev, [key]: false }));
    }
  };

  const filteredQueue = queue.filter(item => {
    let matchesFilter: boolean;
    if (filter === 'all') {
      matchesFilter = true;
    } else if (filter === 'exceptions') {
      matchesFilter = isExceptionCase(item);
    } else if (filter === 'pending') {
      matchesFilter = PENDING_VERIFICATION_STATUSES.includes(item.verificationStatus || '');
    } else if (filter === 'approved') {
      matchesFilter = isApprovedVerification(item);
    } else {
      matchesFilter = item.verificationStatus === 'rejected';
    }
    const matchesSearch = !searchTerm ||
      item.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.email?.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const stats = {
    exceptions: queue.filter(isExceptionCase).length,
    pending: queue.filter(q => PENDING_VERIFICATION_STATUSES.includes(q.verificationStatus || '')).length,
    approved: queue.filter(isApprovedVerification).length,
    rejected: queue.filter(q => q.verificationStatus === 'rejected').length,
    total: queue.length
  };

  return (
    <div className="max-w-7xl mx-auto p-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Caregiver Verification</h1>
        <p className="text-slate-500">
          Checkr-clear caregivers are approved automatically — review document submissions and background-check exceptions here
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4 mb-8">
        <div className={`p-6 rounded-2xl shadow-sm border ${stats.exceptions > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white border-slate-200'}`}>
          <div className={`text-3xl font-bold ${stats.exceptions > 0 ? 'text-orange-600' : 'text-slate-400'}`}>{stats.exceptions}</div>
          <div className="text-sm text-slate-500">Needs Review</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="text-3xl font-bold text-accent-600">{stats.pending}</div>
          <div className="text-sm text-slate-500">Awaiting Checkr</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="text-3xl font-bold text-emerald-600">{stats.approved}</div>
          <div className="text-sm text-slate-500">Approved (incl. auto)</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="text-3xl font-bold text-red-600">{stats.rejected}</div>
          <div className="text-sm text-slate-500">Rejected</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="text-3xl font-bold text-slate-900">{stats.total}</div>
          <div className="text-sm text-slate-500">In View</div>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="flex gap-2 flex-wrap">
          {([
            { value: 'exceptions', label: 'Needs Review', count: stats.exceptions, color: 'orange' },
            { value: 'pending', label: 'Awaiting Checkr', count: stats.pending, color: 'accent' },
            { value: 'approved', label: 'Approved', count: null, color: 'emerald' },
            { value: 'rejected', label: 'Rejected', count: null, color: 'red' },
            { value: 'all', label: 'All', count: null, color: 'slate' },
          ] as const).map(({ value, label, count, color }) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                filter === value
                  ? color === 'orange' ? 'bg-orange-500 text-white'
                  : color === 'emerald' ? 'bg-emerald-600 text-white'
                  : color === 'red' ? 'bg-red-600 text-white'
                  : 'bg-primary-600 text-white'
                  : count && count > 0
                  ? color === 'orange' ? 'bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100'
                  : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'
                  : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'
              }`}
            >
              {label}{count && count > 0 ? ` (${count})` : ''}
            </button>
          ))}
        </div>
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search caregivers..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none"
          />
        </div>
      </div>

      {/* Queue List */}
      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-slate-500">Loading verification queue...</p>
        </div>
      ) : filteredQueue.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-2xl border border-slate-200">
          <Shield className="w-16 h-16 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-500">No caregivers in this queue</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left p-4 font-semibold text-slate-700">Caregiver</th>
                <th className="text-left p-4 font-semibold text-slate-700">Status</th>
                <th className="text-left p-4 font-semibold text-slate-700">Submitted</th>
                <th className="text-left p-4 font-semibold text-slate-700">Documents</th>
                <th className="text-right p-4 font-semibold text-slate-700">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredQueue.map((caregiver) => (
                <tr
                  key={getDocId(caregiver)}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                  onClick={() => setSelectedCaregiver(caregiver)}
                >
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                        <User className="w-5 h-5 text-primary-600" />
                      </div>
                      <div>
                        <div className="font-semibold text-slate-900">{caregiver.name}</div>
                        <div className="text-sm text-slate-500">{caregiver.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge
                          variant={
                            isApprovedVerification(caregiver) ? 'success'
                            : caregiver.verificationStatus === 'rejected' ? 'danger'
                            : 'warning'
                          }
                        >
                          {isApprovedVerification(caregiver)
                            ? (caregiver.verificationStatus === 'checkr_clear' ? 'Approved — Checkr clear' : 'Approved')
                            : caregiver.verificationStatus === 'submitted' ? 'Awaiting Checkr'
                            : caregiver.verificationStatus || 'pending'}
                        </Badge>
                        <span className={`text-xs px-2 py-0.5 rounded-full w-fit font-medium ${
                          isCaregiverBookable(caregiver)
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}>
                          {isCaregiverBookable(caregiver) ? 'Bookable' : 'Not bookable'}
                        </span>
                      </div>
                      {caregiver.backgroundCheckData?.status && caregiver.backgroundCheckData.status !== 'pending' && (
                        <span className={`text-xs px-2 py-0.5 rounded-full w-fit font-medium ${
                          caregiver.backgroundCheckData.status === 'clear' ? 'bg-teal-100 text-teal-700'
                          : caregiver.backgroundCheckData.status === 'suspended' ? 'bg-red-100 text-red-700'
                          : UNBOOKABLE_BG_STATUSES.includes(caregiver.backgroundCheckData.status) ? 'bg-orange-100 text-orange-700'
                          : 'bg-slate-100 text-slate-600'
                        }`}>
                          Checkr: {caregiver.backgroundCheckData.status}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4 text-slate-600">
                    {caregiver.backgroundCheckData?.submittedAt
                      ? new Date(caregiver.backgroundCheckData.submittedAt).toLocaleDateString()
                      : 'N/A'}
                  </td>
                  <td className="p-4">
                    {caregiver.backgroundCheckData?.checkrCandidateId ? (
                      <span className="text-xs text-teal-600 font-medium">Checkr submitted</span>
                    ) : (
                      <span className="text-xs text-slate-400">Not submitted</span>
                    )}
                  </td>
                  <td className="p-4 text-right">
                    <button className="text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1 ml-auto">
                      Review <ChevronRight className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Review Modal */}
      {selectedCaregiver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSelectedCaregiver(null)} />
          <div className="relative bg-white w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-3xl shadow-2xl animate-slide-in">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-slate-200 p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 bg-primary-100 rounded-2xl flex items-center justify-center">
                  <User className="w-8 h-8 text-primary-600" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-slate-900">{selectedCaregiver.name}</h2>
                  <p className="text-slate-500">{selectedCaregiver.email}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedCaregiver(null)}
                className="p-2 hover:bg-slate-100 rounded-full"
              >
                <X className="w-6 h-6 text-slate-500" />
              </button>
            </div>

            <div className="p-6 grid md:grid-cols-2 gap-8">
              {/* Left Column - Profile Info */}
              <div className="space-y-6">
                <section>
                  <h3 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
                    <User className="w-5 h-5 text-primary-600" /> Profile Information
                  </h3>
                  <div className="space-y-3 bg-slate-50 p-4 rounded-xl">
                    {(selectedCaregiver as any).gender && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Gender</span>
                        <span className="font-medium">{(selectedCaregiver as any).gender}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-slate-500">Experience</span>
                      <span className="font-medium">{(selectedCaregiver as any).experience || (selectedCaregiver as any).yearsExperience || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Hourly Rate</span>
                      <span className="font-medium">${selectedCaregiver.hourlyRate}/hr</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Location</span>
                      <span className="font-medium">{selectedCaregiver.location || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Phone</span>
                      <span className="font-medium">{selectedCaregiver.phone || 'Not provided'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Membership</span>
                      <span className={`font-medium text-sm ${(selectedCaregiver as any).membershipPaid ? 'text-teal-600' : 'text-amber-600'}`}>
                        {(selectedCaregiver as any).membershipPaid ? 'Paid ✓' : 'Not paid'}
                      </span>
                    </div>
                  </div>
                </section>

                <section>
                  <h3 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
                    <Shield className="w-5 h-5 text-primary-600" /> Skills & Certifications
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedCaregiver.skills?.map((skill, idx) => (
                      <span key={idx} className="px-3 py-1 bg-primary-50 text-primary-700 rounded-full text-sm">
                        {skill}
                      </span>
                    ))}
                  </div>
                </section>

              </div>

              {/* Right Column - Background Check & Review */}
              <div className="space-y-6">
                <section>
                  <h3 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
                    <Shield className="w-5 h-5 text-primary-600" /> Background Check Information
                  </h3>
                  {selectedCaregiver.backgroundCheckData ? (
                    <div className="space-y-3 bg-slate-50 p-4 rounded-xl">
                      {(selectedCaregiver.backgroundCheckData.legalFirstName || selectedCaregiver.backgroundCheckData.legalLastName) && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Legal Name</span>
                          <span className="font-medium">
                            {selectedCaregiver.backgroundCheckData.legalFirstName}{' '}
                            {selectedCaregiver.backgroundCheckData.legalLastName}
                          </span>
                        </div>
                      )}
                      {selectedCaregiver.backgroundCheckData.zip && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Location</span>
                          <span className="font-medium">
                            {selectedCaregiver.backgroundCheckData.state} {selectedCaregiver.backgroundCheckData.zip}
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-slate-500">Checkr Status</span>
                        <span className={`font-medium capitalize ${
                          selectedCaregiver.backgroundCheckData.status === 'clear' ? 'text-teal-600'
                          : selectedCaregiver.backgroundCheckData.status === 'consider' ? 'text-orange-600'
                          : 'text-slate-700'
                        }`}>
                          {selectedCaregiver.backgroundCheckData.status || 'pending'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Invitation</span>
                        <span className="font-medium capitalize">
                          {selectedCaregiver.backgroundCheckData.invitationStatus || '—'}
                        </span>
                      </div>
                      {selectedCaregiver.backgroundCheckData.submittedAt && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Submitted</span>
                          <span className="font-medium">
                            {new Date(selectedCaregiver.backgroundCheckData.submittedAt).toLocaleDateString()}
                          </span>
                        </div>
                      )}
                      {selectedCaregiver.backgroundCheckData.initiatedVia && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">Initiated via</span>
                          <span className="font-medium text-xs text-slate-500">
                            {selectedCaregiver.backgroundCheckData.initiatedVia}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-4 bg-accent-50 rounded-xl text-accent-700">
                      No background check data yet
                    </div>
                  )}
                </section>

                {/* Checkr Status Banner */}
                {selectedCaregiver.backgroundCheckData?.status && (
                  <div className={`p-3 rounded-xl flex items-center gap-3 text-sm ${
                    selectedCaregiver.backgroundCheckData.status === 'clear' ? 'bg-teal-50 border border-teal-200 text-teal-800'
                    : selectedCaregiver.backgroundCheckData.status === 'suspended' ? 'bg-red-50 border border-red-200 text-red-800'
                    : UNBOOKABLE_BG_STATUSES.includes(selectedCaregiver.backgroundCheckData.status) ? 'bg-orange-50 border border-orange-200 text-orange-800'
                    : 'bg-slate-50 border border-slate-200 text-slate-700'
                  }`}>
                    <Shield className="w-4 h-4 shrink-0" />
                    <div>
                      <span className="font-semibold">Checkr result: </span>
                      <span className="capitalize">{selectedCaregiver.backgroundCheckData.status.replace(/_/g, ' ')}</span>
                      {selectedCaregiver.backgroundCheckData.status === 'clear' && (
                        <span className="text-xs ml-2 opacity-70">auto-approved</span>
                      )}
                      {selectedCaregiver.backgroundCheckData.checkrClearedAt && (
                        <span className="text-xs ml-2 opacity-70">
                          cleared {new Date(selectedCaregiver.backgroundCheckData.checkrClearedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Transportation Documents */}
                {(
                  ((selectedCaregiver as any).services || (selectedCaregiver as any).skills || []).includes('Transportation') ||
                  !!(selectedCaregiver.documents as any)
                ) && (
                  <section>
                    <h3 className="font-bold text-slate-900 mb-3 flex items-center gap-2">
                      <Car className="w-5 h-5 text-primary-600" /> Transportation Documents
                    </h3>
                    <div className="space-y-3">
                      {([
                        { key: 'driversLicense' as DocumentType, label: "Driver's License", hasExpiry: true },
                        { key: 'insurance' as DocumentType, label: 'Vehicle Insurance', hasExpiry: true },
                        { key: 'registration' as DocumentType, label: 'Vehicle Registration', hasExpiry: true },
                      ]).map(({ key, label, hasExpiry }) => {
                        const doc = (selectedCaregiver.documents as any)?.[key];
                        const processingKey = `${getDocId(selectedCaregiver)}_${key}`;
                        const isProcessingDoc = docActionProcessing[processingKey];
                        return (
                          <div key={key} className="border border-slate-200 rounded-xl p-3 space-y-2">
                            <div className="flex items-center gap-3">
                              <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                              <span className="flex-1 text-sm font-medium text-slate-700">{label}</span>
                              {doc ? (
                                <>
                                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                    doc.status === 'approved' ? 'bg-teal-100 text-teal-700'
                                    : doc.status === 'rejected' ? 'bg-red-100 text-red-700'
                                    : 'bg-amber-100 text-amber-700'
                                  }`}>{doc.status || 'pending'}</span>
                                  <a href={doc.url} target="_blank" rel="noopener noreferrer"
                                    className="text-xs text-primary-600 hover:underline flex items-center gap-0.5">
                                    View <ExternalLink className="w-3 h-3" />
                                  </a>
                                </>
                              ) : (
                                <span className="text-xs text-slate-400 italic">Not uploaded</span>
                              )}
                            </div>
                            {doc && doc.status !== 'approved' && doc.status !== 'rejected' && (
                              <div className="flex flex-col gap-2 pl-7">
                                {hasExpiry && (
                                  <div className="flex items-center gap-2">
                                    <label className="text-xs text-slate-500 whitespace-nowrap">Expiry date</label>
                                    <input
                                      type="date"
                                      value={transportDocExpiry[key] || ''}
                                      onChange={e => setTransportDocExpiry(prev => ({ ...prev, [key]: e.target.value }))}
                                      className="flex-1 text-xs px-2 py-1 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400"
                                    />
                                  </div>
                                )}
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => handleDocAction(getDocId(selectedCaregiver), key, 'approved')}
                                    disabled={isProcessingDoc}
                                    className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                                  >
                                    <Check className="w-3 h-3" /> Approve
                                  </button>
                                  <button
                                    onClick={() => handleDocAction(getDocId(selectedCaregiver), key, 'rejected')}
                                    disabled={isProcessingDoc}
                                    className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                                  >
                                    <X className="w-3 h-3" /> Reject
                                  </button>
                                </div>
                              </div>
                            )}
                            {doc?.expirationDate && (
                              <p className="pl-7 text-xs text-slate-500">Expires: {new Date(doc.expirationDate).toLocaleDateString()}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Checkr Report Link */}
                {selectedCaregiver.backgroundCheckData?.checkrReportId && (
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-700">Checkr Report</p>
                      <p className="text-xs text-slate-500 font-mono mt-0.5">{selectedCaregiver.backgroundCheckData.checkrReportId}</p>
                    </div>
                    <a
                      href={`https://dashboard.checkr.com/reports/${selectedCaregiver.backgroundCheckData.checkrReportId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 font-medium"
                    >
                      View in Checkr <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                )}

                {/* Review Actions — only exception cases need a manual decision.
                    Checkr-clear caregivers are auto-approved by the webhook. */}
                {isExceptionCase(selectedCaregiver) && (
                  <section>
                    <h3 className="font-bold text-slate-900 mb-4">Review Decision</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Review Notes
                        </label>
                        <textarea
                          value={reviewNotes}
                          onChange={(e) => setReviewNotes(e.target.value)}
                          placeholder="Add notes about your decision..."
                          className="w-full p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none resize-none"
                          rows={4}
                        />
                      </div>

                      <div className="flex gap-3">
                        <Button
                          onClick={() => handleApprove(selectedCaregiver)}
                          disabled={isProcessing}
                          className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                        >
                          {isProcessing ? 'Processing...' : <><Check className="w-4 h-4 mr-2" /> Approve</>}
                        </Button>
                        <Button
                          onClick={() => handleRequestMoreInfo(selectedCaregiver)}
                          disabled={isProcessing}
                          variant="outline"
                          className="flex-1"
                        >
                          Request Info
                        </Button>
                        <Button
                          onClick={() => handleReject(selectedCaregiver)}
                          disabled={isProcessing}
                          variant="outline"
                          className="flex-1 border-red-300 text-red-600 hover:bg-red-50"
                        >
                          {isProcessing ? 'Processing...' : <><X className="w-4 h-4 mr-2" /> Reject</>}
                        </Button>
                      </div>
                    </div>
                  </section>
                )}

                {isApprovedVerification(selectedCaregiver) && (
                  <div className="p-4 bg-emerald-50 rounded-xl text-emerald-700 flex items-center gap-3">
                    <Check className="w-5 h-5" />
                    <div>
                      <p className="font-semibold">
                        {selectedCaregiver.backgroundCheckData?.status === 'clear' && !(selectedCaregiver as any).approvedBy
                          ? 'Approved — auto-approved on Checkr clear result'
                          : 'Approved'}
                      </p>
                      {selectedCaregiver.reviewNotes && (
                        <p className="text-sm">{selectedCaregiver.reviewNotes}</p>
                      )}
                      <p className="text-sm">
                        {isCaregiverBookable(selectedCaregiver)
                          ? 'Bookable — visible to families in search.'
                          // 2026-09-06: isCaregiverBookable() now also returns false while
                          // paused — checked first here so admin doesn't misread a caregiver's
                          // own pause as an onboarding problem.
                          : (selectedCaregiver as any).pausedUntil && (selectedCaregiver as any).pausedUntil > new Date().toISOString()
                          ? 'Not bookable — caregiver has paused their own account.'
                          : selectedCaregiver.verificationStatus === 'checkr_clear'
                          ? 'Not yet bookable — legacy "checkr_clear" status; bookability requires verificationStatus "approved".'
                          : 'Not yet bookable — profile onboarding incomplete (requires onboardingStatus "profile_complete").'}
                      </p>
                      {selectedCaregiver.verificationStatus === 'checkr_clear' && (
                        <button
                          onClick={() => handleApprove(selectedCaregiver)}
                          disabled={isProcessing}
                          className="mt-2 text-sm font-semibold text-emerald-700 underline hover:text-emerald-800 disabled:opacity-50"
                        >
                          {isProcessing ? 'Migrating…' : 'Migrate to approved status'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {selectedCaregiver.verificationStatus === 'rejected' && (
                  <div className="p-4 bg-red-50 rounded-xl text-red-700 flex items-center gap-3">
                    <X className="w-5 h-5" />
                    <div>
                      <p className="font-semibold">Rejected</p>
                      <p className="text-sm">{selectedCaregiver.rejectionReason}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
