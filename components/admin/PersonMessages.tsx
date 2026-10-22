import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, Loader2 } from 'lucide-react';
import { adminService, type EviaThreadMessage, type HumanModeFields } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';

// Per-person Messages tab (2026-10-22) — the person's Evia text thread, as mirrored
// server-side into threads/cara_{uid}/messages (linq/threadMirror.ts): every text
// in and out, newest at the bottom. Read-only here: the team talks to the person
// through Evia (the admin Messages page's support room) or by acting for them.

interface Props { uid: string; personName: string; role?: 'client' | 'caregiver'; onToast?: (msg: string, type: 'success' | 'error') => void }

const fmt = (iso: string) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

export const PersonMessages: React.FC<Props> = ({ uid, personName, role = 'client', onToast }) => {
  const { currentUser: ctxUser, adminUser } = useCareConnex();
  const currentUser = adminUser ?? ctxUser;
  const [messages, setMessages] = useState<EviaThreadMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [human, setHuman] = useState<HumanModeFields | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setHuman(null); return adminService.watchHumanMode(uid, setHuman); }, [uid]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !currentUser || sending) return;
    setSending(true);
    try {
      const id = await adminService.queueAdminAssist({
        type: 'team_text', uid, role, text,
        adminUid: currentUser.uid, adminName: currentUser.displayName || currentUser.email || currentUser.uid,
      });
      adminService.watchAdminAssistRequest(id, ({ error: err }) => {
        setSending(false);
        if (err) onToast?.(err, 'error');
        else { setDraft(''); onToast?.('Sent from Evia\'s number', 'success'); }
      });
    } catch {
      setSending(false);
      onToast?.('Could not send', 'error');
    }
  };

  useEffect(() => {
    setMessages(null); setError(null);
    return adminService.watchEviaThread(uid, (msgs, err) => {
      if (err) { setError(err); setMessages([]); return; }
      setMessages(msgs);
    });
  }, [uid]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const first = /^this /.test(personName) ? personName : (personName.split(/\s+/)[0] || 'the person');

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
          const fromTeam = !fromPerson && m.source === 'team';
          return (
            <div key={m.id} className={`flex ${fromPerson ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${fromPerson ? 'bg-primary-600 text-white rounded-br-sm' : fromTeam ? 'bg-rose-50 border border-rose-200 text-slate-800 rounded-bl-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'}`}>
                <p>{m.text}</p>
                <p className={`mt-1 text-[10px] ${fromPerson ? 'text-primary-100' : fromTeam ? 'text-rose-500' : 'text-slate-400'}`}>
                  {fromPerson ? first : fromTeam ? 'Evia team' : 'Evia'} · {fmt(m.createdAt)}{m.source && m.source !== 'cara_sms' && m.source !== 'team' ? ` · ${m.source.replace(/_/g, ' ')}` : ''}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {human?.humanModeOn ? (
        <div className="px-4 py-3 border-t border-rose-200 bg-rose-50">
          <div className="flex items-end gap-2">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder={`Reply to ${first} as the Evia team — it goes out from Evia's number`}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              className="flex-1 text-sm rounded-lg border border-rose-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-rose-300 resize-none" />
            <button onClick={() => void send()} disabled={sending || !draft.trim()}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-rose-700">Human mode is on: Evia is not replying to {first}. Enter sends, Shift+Enter for a new line.</p>
        </div>
      ) : (
        <p className="px-5 py-2 text-xs text-slate-500 border-t border-slate-100">Evia is replying to {first}. To take over the thread, use Hand to human above; to reach them otherwise, use the send-link buttons or Act for this person.</p>
      )}
    </div>
  );
};

export default PersonMessages;
