import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Activity, AlertCircle, CheckCircle, TrendingUp, Printer, Loader } from 'lucide-react';
import { db } from '../../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';

interface HealthTrend {
  seniorId:    string;
  clientId:    string;
  period:      string;
  trends:      string[];
  flags:       string[];
  highlights:  string;
  generatedAt: string;
  shareToken:  string;
  expiresAt?:  string;
  seniorName?: string;
}

type PageState = 'loading' | 'ready' | 'notfound';

export default function HealthSummaryPage() {
  const { token }             = useParams<{ token: string }>();
  const [state, setState]     = useState<PageState>('loading');
  const [trend, setTrend]     = useState<HealthTrend | null>(null);
  const [seniorName, setSeniorName] = useState('');

  useEffect(() => {
    if (!token) { setState('notfound'); return; }
    loadTrend(token);
  }, [token]);

  async function loadTrend(t: string) {
    const fdb = db;
    if (!fdb) { setState('notfound'); return; }
    try {
      const snap = await getDoc(doc(fdb, 'health_summaries', t));
      if (!snap.exists()) { setState('notfound'); return; }

      const data = snap.data() as HealthTrend;

      // Reject expired tokens
      if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
        setState('notfound');
        return;
      }

      setTrend(data);
      if (data.seniorName) setSeniorName(data.seniorName);

      setState('ready');
    } catch {
      setState('notfound');
    }
  }

  if (state === 'loading') {
    return (
      <Page>
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          <Loader className="w-8 h-8 text-ink-400 animate-spin mb-3" />
          <p className="text-ink-400 text-sm">Loading health summary…</p>
        </div>
      </Page>
    );
  }

  if (state === 'notfound' || !trend) {
    return (
      <Page>
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
          <AlertCircle className="w-10 h-10 text-ink-400 mb-3" />
          <h1 className="font-display text-lg font-semibold text-ink-900 mb-1">Summary not found</h1>
          <p className="text-ink-400 text-sm">This link may have expired or is invalid.</p>
        </div>
      </Page>
    );
  }

  const monthLabel = trend.period
    ? new Date(trend.period + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : '';

  const generatedDate = trend.generatedAt
    ? new Date(trend.generatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <Page>
      <div className="max-w-2xl mx-auto py-10 px-6 print:py-4 print:px-0">

        {/* Header */}
        <div className="flex items-start justify-between mb-8 print:mb-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4 text-ink-900 shrink-0" strokeWidth={2.5} />
              <span className="font-display font-semibold text-ink-900 text-sm">Evia</span>
            </div>
            <h1 className="font-display text-2xl font-semibold text-ink-900 tracking-[-0.02em]">
              {seniorName ? `${seniorName}'s ` : ''}Health Summary
            </h1>
            <p className="text-ink-600 text-sm mt-1">{monthLabel} · Generated {generatedDate}</p>
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 text-sm text-ink-600 hover:text-ink-900 bg-white border hairline rounded-lg px-3 py-2 min-h-[44px] print:hidden"
          >
            <Printer className="w-4 h-4" /> Print / PDF
          </button>
        </div>

        {/* Highlights */}
        {trend.highlights && (
          <div className="bg-teal-50 border border-teal-100 rounded-xl p-5 mb-6">
            <p className="text-teal-800 text-sm leading-relaxed">{trend.highlights}</p>
          </div>
        )}

        {/* Trends */}
        {trend.trends.length > 0 && (
          <Section icon={<TrendingUp className="w-4 h-4 text-teal-500" />} title="Observations this period">
            <ul className="space-y-2">
              {trend.trends.map((t, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-ink-600">
                  <CheckCircle className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" />
                  {t}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Flags */}
        {trend.flags.length > 0 && (
          <Section icon={<AlertCircle className="w-4 h-4 text-amber-500" />} title="Worth discussing with a doctor">
            <ul className="space-y-2">
              {trend.flags.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-ink-600">
                  <span className="w-4 h-4 mt-0.5 shrink-0 text-amber-400">⚠️</span>
                  {f}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Footer */}
        <div className="mt-10 pt-6 border-t hairline text-xs text-ink-400 text-center print:mt-6">
          <p>Generated by Evia · For informational purposes only · Not a medical diagnosis</p>
          <p className="mt-1">eviacares.com</p>
        </div>
      </div>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper-50">
      {children}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h2 className="text-sm font-semibold text-ink-600 uppercase tracking-wide">{title}</h2>
      </div>
      <div className="bg-white rounded-xl p-4 border hairline">
        {children}
      </div>
    </div>
  );
}
