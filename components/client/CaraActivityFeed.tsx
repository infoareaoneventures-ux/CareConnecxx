import React, { useEffect, useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { dbService, type AgentActivityItem } from '../../services/api';

// Family-facing "Cara Activity" feed (U9): a transparent, chronological view of
// what Cara did on the family's behalf, backed by the projected user_activity_feed
// (allow-listed, PII-free). Framed as "recent activity" — not a guaranteed-complete
// ledger — because audit writes are best-effort (see U8).

interface CaraActivityFeedProps {
  ownerUid: string;
  limit?: number;
}

type FeedState = 'loading' | 'ready' | 'error';

export const CaraActivityFeed: React.FC<CaraActivityFeedProps> = ({ ownerUid, limit = 20 }) => {
  const [items, setItems] = useState<AgentActivityItem[]>([]);
  const [state, setState] = useState<FeedState>('loading');

  useEffect(() => {
    if (!ownerUid) { setState('ready'); return; }
    setState('loading');
    const unsub = dbService.subscribeAgentActivity(
      ownerUid,
      list => { setItems(list); setState('ready'); },
      () => { setItems([]); setState('error'); },
    );
    return () => { try { unsub(); } catch { /* already unsubscribed */ } };
  }, [ownerUid]);

  const Header = (
    <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
      <Sparkles className="w-4 h-4 text-primary-600" />
      Recent activity from Cara
    </h2>
  );

  if (state === 'loading') {
    return (
      <section className="mb-6">
        {Header}
        <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
      </section>
    );
  }

  if (state === 'error') {
    return (
      <section className="mb-6">
        {Header}
        <p className="text-xs text-slate-500 bg-white border border-slate-100 rounded-xl p-3">
          Couldn’t load Cara’s recent activity right now. Please try again later.
        </p>
      </section>
    );
  }

  // ready
  if (items.length === 0) {
    // Explanatory empty state (not null) so the feature is discoverable before
    // Cara has taken any action for a new family.
    return (
      <section className="mb-6">
        {Header}
        <p className="text-xs text-slate-500 bg-white border border-slate-100 rounded-xl p-3">
          Actions Cara takes — booking visits, sending messages, updating your schedule — will show up here.
        </p>
      </section>
    );
  }

  return (
    <section className="mb-6">
      {Header}
      <div className="space-y-2">
        {items.slice(0, limit).map((item) => {
          const when = item.timestamp
            ? new Date(item.timestamp).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })
            : '';
          return (
            <div key={item.id} className="flex items-center justify-between gap-3 bg-white border border-slate-100 rounded-xl px-3 py-2 shadow-sm">
              <p className="text-sm text-slate-700 min-w-0">{item.description}</p>
              <span className="shrink-0 text-xs text-slate-400">{when}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
};
