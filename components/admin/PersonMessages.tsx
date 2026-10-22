import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { adminService, type EviaThreadMessage } from '../../services/api';

// Per-person Messages tab (2026-10-22) — the person's Evia text thread, as mirrored
// server-side into threads/cara_{uid}/messages (linq/threadMirror.ts): every text
// in and out, newest at the bottom. Read-only here: the team talks to the person
// through Evia (the admin Messages page's support room) or by acting for them.

interface Props { uid: string; personName: string }

const fmt = (iso: string) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

export const PersonMessages: React.FC<Props> = ({ uid, personName }) => {
  const [messages, setMessages] = useState<EviaThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(null); setError(null);
    return adminService.watchEviaThread(uid, (msgs, err) => {
      if (err) { setError(err); setMessages([]); return; }
      setMessages(msgs);
    });
  }, [uid]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const first = personName.split(/\s+/)[0] || 'the person';

  return (
    <div className="bg-white rounded-xl border border-slate-200 flex flex-col" style={{ minHeight: 320, maxHeight: '70vh' }}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h3 className="font-semibold text-slate-900 inline-flex items-center gap-2"><MessageSquare className="w-4 h-4 text-primary-600" /> Texts with Evia</h3>
        <span className="text-xs text-slate-500">{messages ? `${messages.length} message${messages.length === 1 ? '' : 's'}` : 'Loading…'}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2 bg-slate-50">
        {error && <p className="text-sm text-red-700">{error}</p>}
        {!error && messages && messages.length === 0 && <p className="text-sm text-slate-500">No texts with Evia yet for {first}.</p>}
        {messages?.map((m) => {
          const fromPerson = m.senderId !== 'cara';
          return (
            <div key={m.id} className={`flex ${fromPerson ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${fromPerson ? 'bg-primary-600 text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'}`}>
                <p>{m.text}</p>
                <p className={`mt-1 text-[10px] ${fromPerson ? 'text-primary-100' : 'text-slate-400'}`}>
                  {fromPerson ? first : 'Evia'} · {fmt(m.createdAt)}{m.source && m.source !== 'cara_sms' ? ` · ${m.source.replace(/_/g, ' ')}` : ''}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <p className="px-5 py-2 text-xs text-slate-500 border-t border-slate-100">Read-only. To reach {first}, use Messages (support room), the send-link buttons, or Act for this person.</p>
    </div>
  );
};

export default PersonMessages;
