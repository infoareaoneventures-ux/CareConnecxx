import React, { useState, useEffect } from 'react';
import { BellRing, Check, AlertTriangle } from 'lucide-react';
import { dbService } from '../../services/api';
import { Badge } from '../ui/Badge';

/**
 * Admin surface for the `admin_alerts` collection — system alerts written by
 * Cloud Functions (payment failures, Linq circuit breakers, escalations, …).
 * Lists newest first, highlights unresolved, and supports mark-resolved.
 *
 * Backend counterparts: functions/src/adminAlerts.ts exposes v1-listAdminAlerts /
 * v1-resolveAdminAlert / v1-getAlertStats callables; this panel reads Firestore
 * directly (TicketManager pattern) via dbService.subscribeAdminAlerts.
 */

interface AdminAlert {
  id: string;
  type?: string;
  severity?: string; // critical | warning | info
  reason?: string;
  message?: string;
  resolved?: boolean;
  createdAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  [key: string]: unknown;
}

interface AdminAlertsPanelProps {
  onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

type AlertFilter = 'open' | 'resolved' | 'all';

// Bookkeeping fields not worth echoing in the context chips
const META_FIELDS = new Set([
  'id', 'type', 'severity', 'reason', 'message',
  'resolved', 'createdAt', 'resolvedAt', 'resolvedBy', 'resolvedNote',
]);

const severityBadgeVariant = (severity?: string): 'danger' | 'warning' | 'neutral' =>
  severity === 'critical' ? 'danger' : severity === 'warning' ? 'warning' : 'neutral';

export const AdminAlertsPanel: React.FC<AdminAlertsPanelProps> = ({ onShowToast }) => {
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [filter, setFilter] = useState<AlertFilter>('open');
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = dbService.subscribeAdminAlerts(
      (data) => {
        setAlerts(data as AdminAlert[]);
        setLoading(false);
      },
      () => {
        onShowToast('Failed to load admin alerts', 'error');
        setLoading(false);
      }
    );
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResolve = async (alert: AdminAlert) => {
    setResolvingId(alert.id);
    try {
      await dbService.resolveAdminAlert(alert.id, 'admin');
      onShowToast('Alert marked resolved', 'success');
    } catch (error) {
      console.error('Failed to resolve alert:', error);
      onShowToast('Failed to resolve alert', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  const openCount = alerts.filter(a => !a.resolved).length;
  const resolvedCount = alerts.length - openCount;

  const filtered = alerts.filter(a =>
    filter === 'all' ? true : filter === 'open' ? !a.resolved : !!a.resolved
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filter Tabs */}
      <div className="flex space-x-2 border-b border-slate-200">
        {(['open', 'resolved', 'all'] as AlertFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 font-medium text-sm capitalize transition-colors ${filter === f
              ? 'border-b-2 border-primary-600 text-primary-600'
              : 'text-slate-600 hover:text-slate-900'
              }`}
          >
            {f}
            <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-slate-100">
              {f === 'all' ? alerts.length : f === 'open' ? openCount : resolvedCount}
            </span>
          </button>
        ))}
      </div>

      {/* Alerts List */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <BellRing className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-lg">No {filter === 'all' ? '' : filter} alerts</p>
            <p className="text-sm mt-2">System alerts from Cloud Functions appear here</p>
          </div>
        ) : (
          filtered.map((alert) => {
            const contextEntries = Object.entries(alert).filter(
              ([k, v]) => !META_FIELDS.has(k) && (typeof v === 'string' || typeof v === 'number')
            );
            return (
              <div
                key={alert.id}
                className={`rounded-lg border p-4 transition-shadow ${alert.resolved
                  ? 'bg-white border-slate-200'
                  : 'bg-amber-50/60 border-amber-200 border-l-4 border-l-amber-400'
                  }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      {!alert.resolved && (
                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                      )}
                      <Badge variant={severityBadgeVariant(alert.severity)}>
                        {alert.severity || 'info'}
                      </Badge>
                      <span className="px-2 py-1 text-xs font-medium rounded bg-primary-50 text-primary-700">
                        {(alert.type || 'alert').replace(/_/g, ' ')}
                      </span>
                      {alert.resolved && (
                        <Badge variant="success">Resolved</Badge>
                      )}
                    </div>
                    <p className="text-sm text-slate-800 mb-2">
                      {alert.reason || alert.message || 'No details provided'}
                    </p>
                    {contextEntries.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {contextEntries.map(([k, v]) => (
                          <span key={k} className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-mono">
                            {k}: {String(v)}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      {alert.createdAt && (
                        <span>{new Date(alert.createdAt).toLocaleString()}</span>
                      )}
                      {alert.resolved && alert.resolvedAt && (
                        <>
                          <span>•</span>
                          <span>resolved {new Date(alert.resolvedAt).toLocaleString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {!alert.resolved && (
                    <button
                      onClick={() => handleResolve(alert)}
                      disabled={resolvingId === alert.id}
                      className="shrink-0 flex items-center gap-1.5 text-sm font-semibold bg-white text-emerald-700 border border-emerald-200 hover:bg-emerald-50 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Check className="w-4 h-4" />
                      {resolvingId === alert.id ? 'Resolving…' : 'Mark resolved'}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
