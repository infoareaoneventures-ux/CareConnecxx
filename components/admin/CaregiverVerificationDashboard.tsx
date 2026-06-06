import React, { useState, useEffect } from 'react';
import { Shield, Check, X, Clock, User, FileText, AlertCircle, Search, ChevronRight, ExternalLink, Car } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { dbService } from '../../services/api';
import { documentUploadService, DocumentType } from '../../services/documentUpload';
import { Caregiver, CaregiverDocuments } from '../../types';

interface VerificationQueueItem extends Omit<Caregiver, 'backgroundCheckData'> {
  submittedAt?: string;
  backgroundCheckData?: {
    legalFirstName?: string;
    legalLastName?: string;
    zip?: string;
    state?: string;
    consentGiven?: boolean;
    submittedAt?: string;
    status?: string;           // pending | clear | consider | suspended | canceled
    invitationStatus?: string; // sent | completed | expired | canceled | error
    checkrReportId?: string;
    checkrCandidateId?: string;
    checkrClearedAt?: string;
    initiatedVia?: string;
    documents?: string[];      // legacy
  };
}

interface CaregiverVerificationDashboardProps {
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

/**
 * Admin Dashboard for Manual Caregiver Verification
 * Review background checks, documents, and approve/reject caregivers
 */
export const CaregiverVerificationDashboard: React.FC<CaregiverVerificationDashboardProps> = ({
  onShowToast
}) => {
  const [queue, setQueue] = useState<VerificationQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCaregiver, setSelectedCaregiver] = useState<VerificationQueueItem | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'checkr_clear' | 'approved' | 'rejected' | 'consider'>('pending');
  const [searchTerm, setSearchTerm] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [transportDocExpiry, setTransportDocExpiry] = useState<Record<string, string>>({});
  const [docActionProcessing, setDocActionProcessing] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadVerificationQueue();
  }, [filter]);

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
      await dbService.updateUser('caregivers', caregiver.uid!, {
        verificationStatus: 'approved',
        verified: true,
        onboardingStep: 3,
        approvedAt: new Date().toISOString(),
        approvedBy: 'admin', // Current admin ID
        reviewNotes: reviewNotes
      });

      // Send approval notification to caregiver
      await dbService.sendNotification(caregiver.uid!, {
        type: 'verification_approved',
        title: 'You\'re Verified!',
        body: 'Your background check has been approved. You can now start accepting jobs.',
        message: 'Your background check has been approved. You can now start accepting jobs.',
        userId: caregiver.uid!,
        isRead: false,
      });

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
      await dbService.updateUser('caregivers', caregiver.uid!, {
        verificationStatus: 'rejected',
        onboardingStep: 2,
        rejectedAt: new Date().toISOString(),
        rejectedBy: 'admin',
        rejectionReason: reviewNotes
      });

      // Send rejection notification
      await dbService.sendNotification(caregiver.uid!, {
        type: 'verification_rejected',
        title: 'Verification Update',
        body: `Your application was not approved. Reason: ${reviewNotes}`,
        message: `Your application was not approved. Reason: ${reviewNotes}`,
        userId: caregiver.uid!,
        isRead: false,
      });

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
      await dbService.updateUser('caregivers', caregiver.uid!, {
        verificationStatus: 'info_requested',
        infoRequestNotes: reviewNotes,
        infoRequestedAt: new Date().toISOString()
      });

      await dbService.sendNotification(caregiver.uid!, {
        type: 'info_requested',
        title: 'Additional Information Needed',
        body: `We need more information to complete your verification: ${reviewNotes}`,
        message: `We need more information to complete your verification: ${reviewNotes}`,
        userId: caregiver.uid!,
        isRead: false,
      });

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
    } else if (filter === 'consider') {
      matchesFilter = item.backgroundCheckData?.status === 'consider';
    } else if (filter === 'checkr_clear') {
      matchesFilter = item.verificationStatus === 'checkr_clear';
    } else if (filter === 'pending') {
      matchesFilter = item.verificationStatus === 'submitted' || item.verificationStatus === 'pending';
    } else {
      matchesFilter = item.verificationStatus === filter;
    }
    const matchesSearch = !searchTerm ||
      item.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.email?.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const stats = {
    pending: queue.filter(q => q.verificationStatus === 'submitted' || q.verificationStatus === 'pending').length,
    checkrClear: queue.filter(q => q.verificationStatus === 'checkr_clear').length,
    approved: queue.filter(q => q.verificationStatus === 'approved').length,
    rejected: queue.filter(q => q.verificationStatus === 'rejected').length,
    needsReview: queue.filter(q => q.backgroundCheckData?.status === 'consider').length,
    total: queue.length
  };

  return (
    <div className="max-w-7xl mx-auto p-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Caregiver Verification</h1>
        <p className="text-slate-500">Review and approve caregiver background checks</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4 mb-8">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="text-3xl font-bold text-accent-600">{stats.pending}</div>
          <div className="text-sm text-slate-500">Awaiting Checkr</div>
        </div>
        <div className={`p-6 rounded-2xl shadow-sm border ${stats.checkrClear > 0 ? 'bg-teal-50 border-teal-200' : 'bg-white border-slate-200'}`}>
          <div className={`text-3xl font-bold ${stats.checkrClear > 0 ? 'text-teal-600' : 'text-slate-400'}`}>{stats.checkrClear}</div>
          <div className="text-sm text-slate-500">Checkr Clear — Approve</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="text-3xl font-bold text-emerald-600">{stats.approved}</div>
          <div className="text-sm text-slate-500">Approved</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="text-3xl font-bold text-red-600">{stats.rejected}</div>
          <div className="text-sm text-slate-500">Rejected</div>
        </div>
        <div className={`p-6 rounded-2xl shadow-sm border ${stats.needsReview > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white border-slate-200'}`}>
          <div className={`text-3xl font-bold ${stats.needsReview > 0 ? 'text-orange-600' : 'text-slate-900'}`}>{stats.needsReview}</div>
          <div className="text-sm text-slate-500">Checkr Consider</div>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <div className="flex gap-2 flex-wrap">
          {([
            { value: 'pending', label: 'Awaiting Checkr', count: stats.pending, color: 'accent' },
            { value: 'checkr_clear', label: 'Checkr Clear', count: stats.checkrClear, color: 'teal' },
            { value: 'consider', label: 'Needs Review', count: stats.needsReview, color: 'orange' },
            { value: 'approved', label: 'Approved', count: null, color: 'emerald' },
            { value: 'rejected', label: 'Rejected', count: null, color: 'red' },
            { value: 'all', label: 'All', count: null, color: 'slate' },
          ] as const).map(({ value, label, count, color }) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                filter === value
                  ? color === 'teal' ? 'bg-teal-500 text-white'
                  : color === 'orange' ? 'bg-orange-500 text-white'
                  : color === 'emerald' ? 'bg-emerald-600 text-white'
                  : color === 'red' ? 'bg-red-600 text-white'
                  : 'bg-primary-600 text-white'
                  : count && count > 0
                  ? color === 'teal' ? 'bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100'
                  : color === 'orange' ? 'bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100'
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
                  key={caregiver.uid}
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
                      <Badge
                        variant={
                          caregiver.verificationStatus === 'approved' ? 'success'
                          : caregiver.verificationStatus === 'rejected' ? 'danger'
                          : caregiver.verificationStatus === 'checkr_clear' ? 'success'
                          : 'warning'
                        }
                      >
                        {caregiver.verificationStatus === 'checkr_clear' ? 'Checkr Clear'
                          : caregiver.verificationStatus === 'submitted' ? 'Awaiting Checkr'
                          : caregiver.verificationStatus || 'pending'}
                      </Badge>
                      {caregiver.backgroundCheckData?.status && caregiver.backgroundCheckData.status !== 'pending' && (
                        <span className={`text-xs px-2 py-0.5 rounded-full w-fit font-medium ${
                          caregiver.backgroundCheckData.status === 'clear' ? 'bg-teal-100 text-teal-700'
                          : caregiver.backgroundCheckData.status === 'consider' ? 'bg-orange-100 text-orange-700'
                          : caregiver.backgroundCheckData.status === 'suspended' ? 'bg-red-100 text-red-700'
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
                    : selectedCaregiver.backgroundCheckData.status === 'consider' ? 'bg-orange-50 border border-orange-200 text-orange-800'
                    : selectedCaregiver.backgroundCheckData.status === 'suspended' ? 'bg-red-50 border border-red-200 text-red-800'
                    : 'bg-slate-50 border border-slate-200 text-slate-700'
                  }`}>
                    <Shield className="w-4 h-4 shrink-0" />
                    <div>
                      <span className="font-semibold">Checkr result: </span>
                      <span className="capitalize">{selectedCaregiver.backgroundCheckData.status}</span>
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
                        const processingKey = `${selectedCaregiver.uid}_${key}`;
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
                                    onClick={() => handleDocAction(selectedCaregiver.uid!, key, 'approved')}
                                    disabled={isProcessingDoc}
                                    className="flex-1 flex items-center justify-center gap-1 text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                                  >
                                    <Check className="w-3 h-3" /> Approve
                                  </button>
                                  <button
                                    onClick={() => handleDocAction(selectedCaregiver.uid!, key, 'rejected')}
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

                {/* Review Actions */}
                {(['submitted', 'pending', 'checkr_clear', 'info_requested'].includes(selectedCaregiver.verificationStatus || '') || selectedCaregiver.backgroundCheckData?.status === 'consider') && (
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

                {selectedCaregiver.verificationStatus === 'approved' && (
                  <div className="p-4 bg-emerald-50 rounded-xl text-emerald-700 flex items-center gap-3">
                    <Check className="w-5 h-5" />
                    <div>
                      <p className="font-semibold">Approved</p>
                      <p className="text-sm">{selectedCaregiver.reviewNotes}</p>
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
