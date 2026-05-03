import React, { useState, useEffect, useRef } from 'react';
import { Search, Send, Plus, X, Users, CheckCheck } from 'lucide-react';
import { chatService, ChatRoom, Message, SUPPORT_AGENT_ID } from '../../services/chatService';
import { authService, dbService } from '../../services/api';
import { db } from '../../lib/firebase';

// ─── helpers ────────────────────────────────────────────────────────────────

function formatRoomTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatMsgTime(ts: any): string {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateLabel(ts: any): string {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

interface UserOption {
  uid: string;
  name: string;
  email: string;
  userType: string;
  avatar?: string;
}

// ─── component ──────────────────────────────────────────────────────────────

export const AdminMessages: React.FC = () => {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState('');

  // New conversation modal
  const [showNewConvo, setShowNewConvo] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState<UserOption[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserOption | null>(null);
  const [creating, setCreating] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentUser = authService.getCurrentUser();
  const adminUid = currentUser?.uid ?? '';
  const adminName = 'CareConnex Team';

  // Subscribe to ALL chat rooms (admin)
  useEffect(() => {
    const unsub = chatService.subscribeToAllChatRooms(setRooms);
    return unsub;
  }, []);

  // Subscribe to messages for selected room
  useEffect(() => {
    if (!selectedRoomId) { setMessages([]); return; }
    const unsub = chatService.subscribeToMessages(selectedRoomId, (msgs) => {
      setMessages(msgs);
      if (adminUid) {
        chatService.markMessagesAsRead(selectedRoomId, adminUid).catch(() => {});
        // For support rooms, also clear the support-agent unread count
        const room = rooms.find(r => r.id === selectedRoomId);
        if (room?.isSupport) {
          chatService.markMessagesAsRead(selectedRoomId, SUPPORT_AGENT_ID).catch(() => {});
        }
      }
    });
    return unsub;
  }, [selectedRoomId, adminUid]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (selectedRoomId) inputRef.current?.focus();
  }, [selectedRoomId]);

  // Search users for new conversation
  useEffect(() => {
    if (!userSearch.trim() || userSearch.length < 2) { setUserResults([]); return; }
    let cancelled = false;
    setLoadingUsers(true);
    (async () => {
      try {
        if (!db) return;
        const snap = await db.collection('users').limit(30).get();
        if (cancelled) return;
        const term = userSearch.toLowerCase();
        const results: UserOption[] = snap.docs
          .map(d => {
            const data = d.data() as any;
            return {
              uid: d.id,
              name: data.displayName || data.firstName || data.name || data.email?.split('@')[0] || 'User',
              email: data.email || '',
              userType: data.userType || 'client',
              avatar: data.photoURL || data.imageUrl || '',
            };
          })
          .filter(u => u.uid !== adminUid && (
            u.name.toLowerCase().includes(term) ||
            u.email.toLowerCase().includes(term) ||
            u.userType.toLowerCase().includes(term)
          ));
        setUserResults(results.slice(0, 10));
      } catch {
        setUserResults([]);
      } finally {
        if (!cancelled) setLoadingUsers(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userSearch, adminUid]);

  const handleSend = async () => {
    if (!inputText.trim() || !selectedRoomId || sending) return;
    const text = inputText.trim();
    setInputText('');
    setSending(true);
    try {
      await chatService.sendMessage(selectedRoomId, adminUid, adminName, text);
    } catch {
      setInputText(text);
    } finally {
      setSending(false);
    }
  };

  const handleStartConversation = async () => {
    if (!selectedUser || creating) return;
    setCreating(true);
    try {
      const roomId = await chatService.getOrCreateChatRoom(
        adminUid, adminName,
        selectedUser.uid, selectedUser.name
      );
      setShowNewConvo(false);
      setSelectedUser(null);
      setUserSearch('');
      setSelectedRoomId(roomId);
    } catch {
      // silently ignore
    } finally {
      setCreating(false);
    }
  };

  // Derive contact info for a room from admin's perspective
  function getParticipantList(room: ChatRoom): string {
    return (room.participantNames || []).filter(n => n !== adminName).join(', ') || 'Unknown';
  }

  function getAdminContact(room: ChatRoom) {
    if (room.isSupport) {
      // For support rooms the non-support participant is the user who sent the request
      const userIdx = (room.participants || []).findIndex(uid => uid !== SUPPORT_AGENT_ID);
      return {
        name: userIdx >= 0 ? (room.participantNames?.[userIdx] || 'User') : 'User',
        avatar: userIdx >= 0 ? (room.participantAvatars?.[userIdx] || '') : '',
        id: userIdx >= 0 ? (room.participants?.[userIdx] || '') : '',
      };
    }
    const otherIdx = room.participants?.findIndex(uid => uid !== adminUid) ?? -1;
    return {
      name: otherIdx >= 0 ? (room.participantNames?.[otherIdx] || getParticipantList(room)) : getParticipantList(room),
      avatar: otherIdx >= 0 ? (room.participantAvatars?.[otherIdx] || '') : '',
      id: otherIdx >= 0 ? (room.participants?.[otherIdx] || '') : '',
    };
  }

  const filteredRooms = rooms.filter(r => {
    if (!search) return true;
    const names = (r.participantNames || []).join(' ').toLowerCase();
    return names.includes(search.toLowerCase()) || r.lastMessage?.toLowerCase().includes(search.toLowerCase());
  });

  const activeRoom = rooms.find(r => r.id === selectedRoomId);
  const contact = activeRoom ? getAdminContact(activeRoom) : null;

  // Group messages by date
  const groupedMessages: { date: string; msgs: Message[] }[] = [];
  messages.forEach(msg => {
    const label = formatDateLabel(msg.timestamp);
    const last = groupedMessages[groupedMessages.length - 1];
    if (last && last.date === label) { last.msgs.push(msg); }
    else { groupedMessages.push({ date: label, msgs: [msg] }); }
  });

  const totalUnread = rooms.reduce((sum, r) => {
    const myUnread = r.unreadCount?.[adminUid] || 0;
    // Support rooms accumulate unread under the support-agent key, not the admin uid
    const supportUnread = r.isSupport ? (r.unreadCount?.[SUPPORT_AGENT_ID] || 0) : 0;
    return sum + Math.max(myUnread, supportUnread);
  }, 0);

  return (
    <div className="flex h-[calc(100vh-64px)] bg-white overflow-hidden">

      {/* ── Left: room list ── */}
      <div className="w-[300px] flex-shrink-0 border-r border-slate-200 flex flex-col bg-slate-50">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 bg-white">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-slate-900">Messages</h2>
              {totalUnread > 0 && (
                <span className="px-2 py-0.5 bg-primary-600 text-white text-xs font-bold rounded-full">{totalUnread}</span>
              )}
            </div>
            <button
              onClick={() => setShowNewConvo(true)}
              className="p-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg transition-colors"
              title="New conversation"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search conversations…"
              className="w-full pl-9 pr-3 py-2 bg-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
            />
          </div>
        </div>

        {/* Room list */}
        <div className="flex-1 overflow-y-auto">
          {filteredRooms.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              <Users className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No conversations yet
            </div>
          ) : filteredRooms.map(room => {
            const c = getAdminContact(room);
            const unread = Math.max(
              room.unreadCount?.[adminUid] || 0,
              room.isSupport ? (room.unreadCount?.[SUPPORT_AGENT_ID] || 0) : 0
            );
            const isActive = room.id === selectedRoomId;
            const participantCount = (room.participants || []).length;
            return (
              <button
                key={room.id}
                onClick={() => setSelectedRoomId(room.id)}
                className={`w-full text-left px-4 py-3.5 border-b border-slate-100 transition-colors hover:bg-white ${isActive ? 'bg-white border-l-4 border-l-primary-600 pl-3' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <div className="relative flex-shrink-0">
                    {c.avatar ? (
                      <img src={c.avatar} alt={c.name} className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-bold text-sm">
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    {unread > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-primary-600 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{unread}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-1">
                      <p className={`text-sm truncate ${unread > 0 ? 'font-bold text-slate-900' : 'font-semibold text-slate-700'}`}>
                        {c.name}
                        {participantCount > 2 && <span className="ml-1 text-slate-400 font-normal">+{participantCount - 2}</span>}
                      </p>
                      <span className="text-[10px] text-slate-400 whitespace-nowrap flex-shrink-0">{formatRoomTime(room.lastMessageTime)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {room.isSupport && (
                        <span className="flex-shrink-0 text-[9px] px-1.5 py-0.5 bg-amber-100 text-amber-700 font-bold rounded-full uppercase tracking-wide">Support</span>
                      )}
                      <p className={`text-xs truncate ${unread > 0 ? 'font-medium text-slate-700' : 'text-slate-400'}`}>
                        {room.lastMessage || 'No messages yet'}
                      </p>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right: chat area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeRoom && contact ? (
          <>
            {/* Header */}
            <div className="px-5 py-3.5 bg-white border-b border-slate-100 shadow-sm flex items-center gap-3">
              {contact.avatar ? (
                <img src={contact.avatar} alt={contact.name} className="w-9 h-9 rounded-full object-cover" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-bold text-sm flex-shrink-0">
                  {contact.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="font-bold text-slate-900 text-sm">{contact.name}</p>
                <p className="text-xs text-slate-400">
                  {(activeRoom.participantNames || []).join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {activeRoom.isSupport && (
                  <span className="text-xs px-2 py-1 bg-amber-50 text-amber-700 border border-amber-200 rounded-full font-medium">Support Request</span>
                )}
                <span className="text-xs px-2 py-1 bg-primary-50 text-primary-700 border border-primary-200 rounded-full font-medium">Admin</span>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 bg-slate-50 space-y-1">
              {groupedMessages.map(({ date, msgs }) => (
                <div key={date}>
                  <div className="flex items-center justify-center my-4">
                    <span className="px-3 py-1 bg-slate-200 text-slate-500 text-xs rounded-full">{date}</span>
                  </div>
                  {msgs.map((msg, i) => {
                    const isAdmin = msg.senderId === adminUid;
                    const isSystem = msg.type === 'system';
                    const showName = !isAdmin && !isSystem && (i === 0 || msgs[i - 1].senderId !== msg.senderId);

                    if (isSystem) return (
                      <div key={msg.id} className="flex justify-center my-2">
                        <span className="px-3 py-1.5 bg-slate-200 text-slate-500 text-xs rounded-full">{msg.text}</span>
                      </div>
                    );

                    return (
                      <div key={msg.id} className={`flex gap-2 mb-1 ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                        {!isAdmin && showName && (
                          <div className="w-7 h-7 rounded-full bg-slate-300 flex items-center justify-center text-slate-600 font-semibold text-xs flex-shrink-0 mt-1">
                            {msg.senderName?.charAt(0)?.toUpperCase() || '?'}
                          </div>
                        )}
                        {!isAdmin && !showName && <div className="w-7 flex-shrink-0" />}
                        <div className={`max-w-[70%] flex flex-col ${isAdmin ? 'items-end' : 'items-start'}`}>
                          {showName && !isAdmin && <p className="text-xs font-semibold text-slate-500 mb-0.5 ml-1">{msg.senderName}</p>}
                          <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                            isAdmin
                              ? 'bg-primary-600 text-white rounded-br-sm'
                              : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-sm'
                          }`}>
                            {msg.text}
                          </div>
                          <div className={`flex items-center gap-1 mt-0.5 ${isAdmin ? 'justify-end' : ''}`}>
                            <span className="text-[10px] text-slate-400">{formatMsgTime(msg.timestamp)}</span>
                            {isAdmin && msg.readBy && msg.readBy.length > 1 && (
                              <CheckCheck className="w-3 h-3 text-primary-500" />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="px-5 py-3 bg-white border-t border-slate-100">
              <div className="flex gap-2 items-center">
                <input
                  ref={inputRef}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="Message as CareConnex Team…"
                  className="flex-1 px-4 py-2.5 bg-slate-100 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                />
                <button
                  onClick={handleSend}
                  disabled={!inputText.trim() || sending}
                  className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
                    inputText.trim() && !sending
                      ? 'bg-primary-600 hover:bg-primary-700 text-white'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
              <Send className="w-7 h-7 text-slate-300 ml-0.5" />
            </div>
            <p className="font-medium text-slate-500">Select a conversation</p>
            <p className="text-sm mt-1">Or start a new one with any client or caregiver</p>
            <button
              onClick={() => setShowNewConvo(true)}
              className="mt-4 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold rounded-xl transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              New Conversation
            </button>
          </div>
        )}
      </div>

      {/* ── New Conversation Modal ── */}
      {showNewConvo && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h3 className="font-bold text-slate-900">New Conversation</h3>
              <button onClick={() => { setShowNewConvo(false); setSelectedUser(null); setUserSearch(''); }} className="p-1.5 hover:bg-slate-100 rounded-full transition-colors">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="p-5">
              <p className="text-sm text-slate-500 mb-4">Search for a client or caregiver to message them as CareConnex Team.</p>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                <input
                  autoFocus
                  value={userSearch}
                  onChange={e => { setUserSearch(e.target.value); setSelectedUser(null); }}
                  placeholder="Search by name or email…"
                  className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200"
                />
              </div>

              {/* Results */}
              {loadingUsers && <p className="text-sm text-slate-400 text-center py-3">Searching…</p>}
              {!loadingUsers && userResults.length > 0 && !selectedUser && (
                <div className="border border-slate-200 rounded-xl overflow-hidden mb-4">
                  {userResults.map(u => (
                    <button
                      key={u.uid}
                      onClick={() => setSelectedUser(u)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 border-b border-slate-100 last:border-b-0 text-left transition-colors"
                    >
                      <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{u.name}</p>
                        <p className="text-xs text-slate-400 truncate">{u.email}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
                        u.userType === 'caregiver' ? 'bg-accent-50 text-accent-700' : 'bg-primary-50 text-primary-700'
                      }`}>{u.userType}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Selected user confirmation */}
              {selectedUser && (
                <div className="flex items-center gap-3 p-3 bg-primary-50 border border-primary-200 rounded-xl mb-4">
                  <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-sm flex-shrink-0">
                    {selectedUser.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate">{selectedUser.name}</p>
                    <p className="text-xs text-slate-500 truncate">{selectedUser.email}</p>
                  </div>
                  <button onClick={() => setSelectedUser(null)} className="p-1 hover:bg-primary-100 rounded-full">
                    <X className="w-3.5 h-3.5 text-primary-600" />
                  </button>
                </div>
              )}

              <button
                onClick={handleStartConversation}
                disabled={!selectedUser || creating}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  selectedUser && !creating
                    ? 'bg-primary-600 hover:bg-primary-700 text-white'
                    : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                }`}
              >
                {creating ? 'Opening…' : 'Start Conversation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};