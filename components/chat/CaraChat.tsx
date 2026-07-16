import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, MessageCircle, AlertCircle, RotateCcw, HelpCircle } from 'lucide-react';
import { dbService, authService } from '../../services/api';
import { featuredCapabilities, capabilityExample, buildCapabilityMenu } from '../../constants/caraCapabilities';
import { useCareConnex } from '../../context/CareConnexContext';
import { ClientNavigation } from '../client/ClientNavigation';
import { CaregiverTopNav } from '../caregiver/CaregiverTopNav';
import type { DirectMessage } from '../../types';
import { BloomMark } from '../ui/BloomMark';

// Evia web chat (U4, docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md).
// Renders threads/cara_{uid} — the SAME conversation the user has with Evia
// over SMS/iMessage. Messages are server-written; sending goes through the
// v1-chatWithCara callable, which also delivers Evia's reply as a text when
// the user has a live SMS thread. The browser never writes message docs
// (firestore.rules) — optimistic bubbles live in local state keyed by a
// client-generated id and reconcile when the mirrored doc arrives.

type PendingState = 'sending' | 'failed';
interface PendingMessage {
  clientMessageId: string;
  text: string;
  state: PendingState;
}

type ChatMode = 'chat' | 'notSetUp' | 'finishSetup';

const newClientMessageId = () =>
  `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export const CaraChat: React.FC<{ userType: 'client' | 'caregiver' }> = ({ userType }) => {
  const navigate = useNavigate();
  const currentUid = authService.getCurrentUser()?.uid ?? '';

  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [caraTyping, setCaraTyping] = useState(false);
  const [mode, setMode] = useState<ChatMode>('chat');
  const [notice, setNotice] = useState<string | null>(null);
  const [optedOut, setOptedOut] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Client-side-only capability menu bubble ("What can Evia do?" header button).
  // Rendered locally from constants/caraCapabilities.ts, never sent to the backend.
  const [capabilityMenu, setCapabilityMenu] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadId = dbService.caraThreadId();

  // Live message stream — SMS turns and web turns land in the same collection.
  useEffect(() => {
    if (!threadId) return;
    const unsub = dbService.subscribeToMessages(threadId, (msgs) => {
      setMessages(msgs);
      setLoaded(true);
      // Reconcile optimistic bubbles: a mirrored doc carrying our
      // clientMessageId replaces the local pending entry.
      setPending((prev) =>
        prev.filter((p) => !msgs.some((m: any) => m.clientMessageId === p.clientMessageId))
      );
    });
    return unsub;
  }, [threadId]);

  // Clearing unread is the one thread write the rules allow from the browser.
  const clearUnread = useCallback(() => { dbService.clearCaraThreadUnread(); }, []);
  useEffect(() => {
    clearUnread();
    window.addEventListener('focus', clearUnread);
    return () => window.removeEventListener('focus', clearUnread);
  }, [clearUnread]);
  useEffect(() => {
    if (document.visibilityState === 'visible') clearUnread();
  }, [messages.length, clearUnread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages.length, pending.length, caraTyping, capabilityMenu]);

  const send = async (text: string, existingId?: string) => {
    const body = text.trim();
    if (!body || caraTyping) return;

    const clientMessageId = existingId ?? newClientMessageId();
    setNotice(null);
    setDraft('');
    setPending((prev) => [
      ...prev.filter((p) => p.clientMessageId !== clientMessageId),
      { clientMessageId, text: body, state: 'sending' },
    ]);
    setCaraTyping(true);

    try {
      const res = await dbService.sendCaraMessage(body, clientMessageId);
      switch (res.status) {
        case 'ok':
          if (res.optedOut) setOptedOut(true);
          // Bubble reconciles when the mirrored doc arrives via the listener.
          break;
        case 'rateLimited':
          setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
          setDraft(body);
          setNotice('Evia is getting a lot of messages — wait a moment and try again.');
          break;
        case 'caraBusy':
          setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
          setDraft(body);
          setNotice('Evia is still replying to your last message — try again in a moment.');
          break;
        case 'smsFlowActive':
          // A fresh SMS flow is mid-flight; the web turn deferred without running
          // the agent. Restore the draft and show Evia's grounded notice so the
          // user can finish over text (or retry once it clears).
          setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
          setDraft(body);
          setNotice(res.reply || "You've got something in progress with Evia over text — finish that first, then this chat picks back up.");
          break;
        case 'duplicate':
          // The server already processed this clientMessageId on an earlier
          // attempt — no mirrored doc will arrive for THIS turn, so waiting
          // (the 'ok' path) would leave the bubble stuck forever. Clear it and
          // surface Evia's deterministic reply as a notice. No draft restore:
          // resending the same message is exactly what shouldn't happen.
          setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
          setNotice(res.reply || 'Evia already got that message — no need to resend.');
          break;
        case 'notSetUp':
          setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
          setMode('notSetUp');
          break;
        case 'finishSetup':
          setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
          setMode('finishSetup');
          break;
        default:
          if (res.available === false) {
            setPending((prev) => prev.filter((p) => p.clientMessageId !== clientMessageId));
            setMode('notSetUp');
          }
      }
    } catch {
      // Agent failure after the user message may already be mirrored — mark
      // failed; retry reuses the same clientMessageId so nothing duplicates.
      setPending((prev) =>
        prev.map((p) => (p.clientMessageId === clientMessageId ? { ...p, state: 'failed' } : p))
      );
    } finally {
      setCaraTyping(false);
    }
  };

  // Suggestion chips come from the CI-synced capability mirror
  // (constants/caraCapabilities.ts) so they always match what Evia can do.
  const suggestions = featuredCapabilities(userType).map((e) => capabilityExample(e));
  const isEmpty = loaded && messages.length === 0 && pending.length === 0;

  if (mode === 'notSetUp') {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center max-w-sm space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-primary-50 flex items-center justify-center mx-auto">
            <MessageCircle className="w-7 h-7 text-primary-600" />
          </div>
          <h2 className="text-lg font-bold text-neutral-900">Meet Evia</h2>
          <p className="text-sm text-neutral-500">
            Evia gets set up over a quick text conversation. Once you've said hi
            by text, this chat and your messages stay in sync everywhere.
          </p>
          <button
            onClick={() => navigate('/start')}
            className="min-h-[44px] px-6 py-3 rounded-xl bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold transition-colors"
          >
            Get set up with Evia
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-200 bg-white flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-primary-600 flex items-center justify-center flex-shrink-0">
          <BloomMark className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold text-neutral-900 leading-tight">Evia</h1>
          <p className="text-xs text-neutral-500 truncate">
            Texts and web chat — one conversation
          </p>
        </div>
        <button
          onClick={() => setCapabilityMenu(buildCapabilityMenu(userType))}
          className="min-h-[44px] px-3 rounded-full border border-neutral-200 bg-white text-xs font-semibold text-neutral-600 hover:border-primary-300 hover:text-primary-700 transition-colors flex items-center gap-1.5 flex-shrink-0"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          What can Evia do?
        </button>
      </div>

      {/* Banners */}
      {optedOut && (
        <div className="px-4 py-2 bg-warning-50 border-b border-warning-100 text-xs text-warning-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Texting is paused (you replied STOP), so Evia answers here on the web only.
        </div>
      )}
      {mode === 'finishSetup' && (
        <div className="px-4 py-2 bg-info-50 border-b border-info-100 text-xs text-info-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          Finish setting up with Evia over text first — this chat unlocks right after.
        </div>
      )}

      {/* Messages */}
      <div role="log" aria-label="Conversation with Evia" className="flex-1 overflow-y-auto px-4 py-4 space-y-2 bg-neutral-50">
        {isEmpty && mode === 'chat' && (
          <div className="text-center pt-10 space-y-4">
            <p className="text-sm text-neutral-500">
              Say hi — Evia remembers your conversation whether you text her or type here.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => { setDraft(s); inputRef.current?.focus(); }}
                  className="min-h-[44px] px-4 py-2 rounded-full border border-neutral-200 bg-white text-sm text-neutral-700 hover:border-primary-300 hover:text-primary-700 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m: any) => {
          const fromCara = m.senderId !== currentUid;
          return (
            <div key={m.id} className={`flex ${fromCara ? 'justify-start' : 'justify-end'}`}>
              <div
                className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                  fromCara
                    ? 'bg-white border border-neutral-200 text-neutral-900 rounded-bl-md'
                    : 'bg-primary-600 text-white rounded-br-md'
                }`}
              >
                {m.text}
                <div className={`text-[10px] mt-1 ${fromCara ? 'text-neutral-400' : 'text-white/60'}`}>
                  {m.timestamp}
                </div>
              </div>
            </div>
          );
        })}

        {pending.map((p) => (
          <div key={p.clientMessageId} className="flex justify-end">
            <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md text-sm whitespace-pre-wrap break-words ${
              p.state === 'failed' ? 'bg-error-50 border border-error-200 text-neutral-900' : 'bg-primary-600/80 text-white'
            }`}>
              {p.text}
              {p.state === 'failed' ? (
                <button
                  onClick={() => send(p.text, p.clientMessageId)}
                  className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-error-600 hover:text-error-700 min-h-[24px]"
                >
                  <RotateCcw className="w-3 h-3" /> Couldn't reach Evia — tap to retry
                </button>
              ) : (
                <div className="text-[10px] mt-1 text-white/60">Sending…</div>
              )}
            </div>
          </div>
        ))}

        {/* Local capability menu bubble (client-side only, not part of the thread) */}
        {capabilityMenu && (
          <div className="flex justify-start">
            <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-bl-md text-sm whitespace-pre-wrap break-words bg-white border border-neutral-200 text-neutral-900">
              {capabilityMenu}
            </div>
          </div>
        )}

        {caraTyping && (
          <div className="flex justify-start">
            <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-white border border-neutral-200">
              <span className="inline-flex gap-1" aria-label="Evia is typing">
                <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 animate-bounce [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        )}

        {notice && (
          <p className="text-center text-xs text-neutral-500 py-1">{notice}</p>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Composer (hidden while onboarding finishes over text) */}
      {mode === 'chat' && (
        <div className="p-3 border-t border-neutral-200 bg-white safe-area-bottom">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => { e.preventDefault(); send(draft); }}
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              rows={1}
              placeholder="Message Evia… (try /help)"
              aria-label="Message Evia"
              disabled={caraTyping}
              className="flex-1 resize-none px-4 py-3 bg-neutral-100 rounded-2xl text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!draft.trim() || caraTyping}
              aria-label="Send message"
              className="min-w-[44px] min-h-[44px] rounded-full bg-primary-600 hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
            >
              <Send className="w-5 h-5 text-white" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

// Routed page: nav shell + the chat, matching the InboxView layout conventions
// (64px sticky nav, mobile bottom bar padding).
export const CaraChatPage: React.FC = () => {
  const { currentUser } = useCareConnex();
  const role: 'client' | 'caregiver' = currentUser?.userType === 'caregiver' ? 'caregiver' : 'client';

  return (
    <>
      {role === 'client' ? <ClientNavigation /> : <CaregiverTopNav />}
      <div className="max-w-3xl mx-auto h-[calc(100vh-64px)] flex flex-col bg-white border-x border-neutral-200 overflow-hidden pb-16 md:pb-0">
        <CaraChat userType={role} />
      </div>
    </>
  );
};

export default CaraChatPage;
