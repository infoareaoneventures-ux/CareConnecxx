import React from 'react';
import { FileText, Clock4, CheckCircle, XCircle } from 'lucide-react';
import { useMyApplications } from '../../hooks/useJobApplications';
import type { AddToastFunction } from '../../types';

type ApplicationStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

const StatusBadge: React.FC<{ status: ApplicationStatus }> = ({ status }) => {
  const styles: Record<ApplicationStatus, { icon: React.ReactNode; className: string; label: string }> = {
    pending:   { icon: <Clock4 className="w-3 h-3" />,      className: 'text-primary-700 bg-primary-50',   label: 'Pending' },
    accepted:  { icon: <CheckCircle className="w-3 h-3" />, className: 'text-emerald-700 bg-emerald-50',   label: 'Accepted' },
    rejected:  { icon: <XCircle className="w-3 h-3" />,     className: 'text-rose-700 bg-rose-50',         label: 'Not Selected' },
    withdrawn: { icon: null,                                  className: 'text-slate-600 bg-slate-100',     label: 'Withdrawn' },
  };
  const s = styles[status] || styles.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${s.className}`}>
      {s.icon}
      {s.label}
    </span>
  );
};

interface MyApplicationsListProps {
  caregiverId: string | null;
  onShowToast?: AddToastFunction;
  emptyCtaLabel?: string;
  onEmptyCtaClick?: () => void;
}

export const MyApplicationsList: React.FC<MyApplicationsListProps> = ({
  caregiverId,
  onShowToast,
  emptyCtaLabel,
  onEmptyCtaClick,
}) => {
  const { applications, loading, withdrawApplication } = useMyApplications(caregiverId);

  const handleWithdraw = async (appId: string) => {
    try {
      await withdrawApplication(appId);
      onShowToast?.('Application withdrawn', 'success');
    } catch {
      onShowToast?.('Failed to withdraw application', 'error');
    }
  };

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 text-sm">
        Loading applications…
      </div>
    );
  }

  if (applications.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
        <FileText className="w-10 h-10 text-slate-300 mx-auto mb-2" />
        <p className="font-semibold text-slate-900 mb-1">No applications yet</p>
        <p className="text-sm text-slate-500 mb-4">Apply to jobs from the Job Board to see them here.</p>
        {emptyCtaLabel && onEmptyCtaClick && (
          <button onClick={onEmptyCtaClick} className="inline-flex items-center px-4 py-2 rounded-full bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600">
            {emptyCtaLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {applications.map((app) => (
        <div key={app.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h4 className="font-bold text-slate-900">{app.jobTitle}</h4>
              <p className="text-sm text-slate-500">Client: {app.clientName}</p>
            </div>
            <StatusBadge status={app.status as ApplicationStatus} />
          </div>
          <div className="flex justify-between items-center text-sm text-slate-500">
            <span>Applied {new Date(app.appliedAt).toLocaleDateString()}</span>
            {app.status === 'pending' && (
              <button
                onClick={() => handleWithdraw(app.id)}
                className="text-rose-600 hover:text-rose-700 font-medium"
              >
                Withdraw
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
