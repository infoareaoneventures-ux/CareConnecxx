import React, { useState, useEffect } from 'react';
import { Shield, AlertTriangle, Activity, Users, Clock, Eye } from 'lucide-react';
import { db } from '../../lib/firebase';

interface AuditEntry {
  id:        string;
  eventType: string;
  userId:    string;
  phone?:    string;
  timestamp: string;
  data:      Record<string, unknown>;
}

interface SafetyLogEntry {
  id:          string;
  phone:       string;
  violation:   string;
  original:    string;
  rewritten?:  string;
  timestamp:   string;
}

interface CrisisEntry {
  id:         string;
  phone:      string;
  crisisType: string;
  timestamp:  string;
}

export const AuditDashboard: React.FC = () => {
  const [auditLog,     setAuditLog]     = useState<AuditEntry[]>([]);
  const [safetyLog,    setSafetyLog]    = useState<SafetyLogEntry[]>([]);
  const [crisisEvents, setCrisisEvents] = useState<CrisisEntry[]>([]);
  const [sessionCount, setSessionCount] = useState<number>(0);
  const [pendingTasks, setPendingTasks] = useState<number>(0);
  const [loading,      setLoading]      = useState(true);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const weekAgo   = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    async function load() {
      try {
        const [auditSnap, safetySnap, crisisSnap, sessionsSnap, tasksSnap] = await Promise.all([
          (db as any).collection("agent_audit_log")
            .orderBy("timestamp", "desc")
            .limit(50)
            .get(),
          (db as any).collection("agent_safety_log")
            .where("timestamp", ">=", weekAgo)
            .orderBy("timestamp", "desc")
            .limit(50)
            .get(),
          (db as any).collection("agent_audit_log")
            .where("eventType",  "==", "crisis_detected")
            .where("timestamp",  ">=", monthAgo)
            .orderBy("timestamp", "desc")
            .limit(50)
            .get(),
          (db as any).collection("agent_sessions")
            .where("optedOut", "==", false)
            .get(),
          (db as any).collection("agent_tasks")
            .where("status", "in", ["awaiting_approval", "awaiting_replace_or_skip"])
            .get(),
        ]);

        if (cancelled) return;

        setAuditLog(auditSnap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
        setSafetyLog(safetySnap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
        setCrisisEvents(crisisSnap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
        setSessionCount(sessionsSnap.size);
        setPendingTasks(tasksSnap.size);
      } catch (err) {
        console.error("AuditDashboard load error:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const formatTs = (ts: string) => {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  };

  const eventColor = (type: string) => {
    if (type === "crisis_detected")    return "bg-red-100 text-red-700";
    if (type === "health_data_accessed") return "bg-amber-100 text-amber-700";
    if (type === "booking_created")    return "bg-green-100 text-green-700";
    if (type === "safety_violation")   return "bg-orange-100 text-orange-700";
    return "bg-slate-100 text-slate-600";
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Audit Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">HIPAA audit log · Safety violations · Crisis events</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Active sessions", value: sessionCount,       icon: Users,         color: "text-indigo-600" },
          { label: "Pending tasks",   value: pendingTasks,       icon: Clock,         color: "text-amber-600"  },
          { label: "Safety violations (7d)", value: safetyLog.length, icon: Shield,   color: "text-orange-600" },
          { label: "Crisis events (30d)",    value: crisisEvents.length, icon: AlertTriangle, color: "text-red-600" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Icon className={`w-4 h-4 ${color}`} />
              <span className="text-xs text-slate-500">{label}</span>
            </div>
            <p className={`text-2xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Safety violations */}
      {safetyLog.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Shield className="w-4 h-4 text-orange-500" />
            <h2 className="font-semibold text-slate-800">Supervisor violations this week</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {safetyLog.slice(0, 10).map((entry) => (
              <div key={entry.id} className="px-5 py-3 text-sm">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-slate-700">{entry.violation}</span>
                  <span className="text-xs text-slate-400">{formatTs(entry.timestamp)}</span>
                </div>
                {entry.original && (
                  <p className="text-slate-500 truncate text-xs">Original: {entry.original.slice(0, 120)}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Crisis events */}
      {crisisEvents.length > 0 && (
        <section className="bg-white rounded-xl border border-red-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-red-100 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <h2 className="font-semibold text-slate-800">Crisis events this month (anonymized)</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {crisisEvents.map((entry) => (
              <div key={entry.id} className="px-5 py-3 text-sm flex items-center justify-between">
                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                  entry.crisisType === "medical" ? "bg-red-100 text-red-700" : "bg-purple-100 text-purple-700"
                }`}>
                  {entry.crisisType}
                </span>
                <span className="text-xs text-slate-400">{formatTs(entry.timestamp)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Audit log timeline */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <Activity className="w-4 h-4 text-indigo-500" />
          <h2 className="font-semibold text-slate-800">Recent audit log (last 50 events)</h2>
        </div>
        <div className="divide-y divide-slate-100">
          {auditLog.map((entry) => (
            <div key={entry.id} className="px-5 py-3 text-sm flex items-start gap-3">
              <span className={`mt-0.5 inline-block px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${eventColor(entry.eventType)}`}>
                {entry.eventType}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-slate-600 truncate text-xs">
                  uid: {entry.userId}
                  {entry.data && Object.keys(entry.data).length > 0 && (
                    <span className="text-slate-400 ml-2">
                      {JSON.stringify(entry.data).slice(0, 80)}
                    </span>
                  )}
                </p>
              </div>
              <span className="text-xs text-slate-400 whitespace-nowrap">{formatTs(entry.timestamp)}</span>
            </div>
          ))}
          {auditLog.length === 0 && (
            <div className="px-5 py-8 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
              <Eye className="w-6 h-6" />
              No audit events yet
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
