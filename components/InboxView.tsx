import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft, Send, Search, MoreVertical, CheckCheck, Flag, Lock } from 'lucide-react';
import { chatService, ChatRoom, Message } from '../services/chatService';
import { authService } from '../services/api';
import { useCareConnex } from '../context/CareConnexContext';
import { ViewType } from '../types';
import { db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { ClientNavigation } from './client/ClientNavigation';
import { CaregiverTopNav } from './caregiver/CaregiverTopNav';
import { useAccessGates } from '../hooks/useAccessGates';
import { useCaregiverGate } from '../hooks/useCaregiverGate';

interface InboxViewProps {
  userType: 'client' | 'caregiver';
  onNavigate: (view: ViewType) => void;
  onShowToast?: (message: string, type: 'success' | 'error' | 'info') => void;
  onViewProfile?: (caregiverId: string) => void;
}

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

function formatDateSeparator(ts: any): string {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export const InboxView: React.FC<InboxViewProps> = ({
  userType,
  onNavigate,
  onShowToast,
  onViewProfile,
}) => {
  const [searchParams] = useSearchParams();
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [search, setSearch] = useState('');
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportDetails, setReportDetails] = useState('');
  const [reportContactId, setReportContactId] = useState('');
  const [reportContactName, setReportContactName] = useState('');
  const [contactPhoto, setContactPhoto] = useState<string>('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const pendingRoomState = (location.state as any)?.pendingRoom as (ChatRoom & { id: string }) | undefined;
  const { appointments, blockedIds } = useCareConnex();
  const currentUser = authService.getCurrentUser();
  const currentUid = currentUser?.uid ?? '';
  const currentName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'You';
  const isClient = userType === 'client';

  // Gate: clients must complete identity + membership before messaging
  const { identityVerified, membershipActive, gate, Modals: GateModals } = useAccessGates();
  const clientCanMessage = !isClient || (identityVerified && membershipActive);

  const { gateMembership, membershipActive: caregiverMembershipActive, GateModal } = useCaregiverGate();
  const caregiverCanMessage = caregiverMembershipActive;

  // Also track accepted booking_requests for care-team classification
  const [acceptedBookingPartnerIds, setAcceptedBookingPartnerIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!currentUid || !db) return;
    const field = isClient ? 'clientId' : 'caregiverId';
    const otherField = isClient ? 'caregiverId' : 'clientId';
    const unsub = db.collection('booking_requests')
      .where(field, '==', currentUid)
      .where('status', '==', 'accepted')
      .onSnapshot(snap => {
        const ids = new Set<string>();
        snap.forEach(doc => {
          const other = doc.data()[otherField];
          if (other) ids.add(other);
        });
        setAcceptedBookingPartnerIds(ids);
      }, () => {});
    return unsub;
  }, [currentUid, isClient]);

  const handleBlock = async (contactId: string, contactName: string, contactAvatar?: string) => {
    if (!currentUid || !contactId) return;
    const fdb = db;
    if (!fdb) return;
    try {
      await fdb.collection('users').doc(currentUid).update({
        blockedUsers: firebase.firestore.FieldValue.arrayUnion(contactId),
        [`blockedUserProfiles.${contactId}`]: { name: contactName, photo: contactAvatar || '' },
      });
      onShowToast?.(`${contactName} has been blocked.`, 'success');
      setSelectedRoomId(null);
    } catch {
      onShowToast?.('Failed to block user. Please try again.', 'error');
    }
  };

  const handleDeleteConversation = async () => {
    if (!currentUid || !selectedRoomId) return;
    try {
      await chatService.deleteConversation(selectedRoomId, currentUid);
      setSelectedRoomId(null);
      onShowToast?.('Conversation deleted.', 'success');
    } catch {
      onShowToast?.('Failed to delete conversation.', 'error');
    }
  };

  const handleReportSubmit = async () => {
    if (!currentUid || !reportContactId || !reportReason) return;
    const fdb = db;
    if (!fdb) return;
    try {
      await fdb.collection('reports').add({
        reportedBy: currentUid,
        reportedUser: reportContactId,
        reportedUserName: reportContactName,
        reason: reportReason,
        details: reportDetails.trim() || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      setShowReportModal(false);
      setReportReason('');
      setReportDetails('');
      onShowToast?.('Report submitted. Our team will review it.', 'success');
    } catch {
      onShowToast?.('Failed to submit report. Please try again.', 'error');
    }
  };

  // Auto-select room from URL param
  useEffect(() => {
    const roomParam = searchParams.get('room');
    if (roomParam) setSelectedRoomId(roomParam);
  }, [searchParams]);

  // Subscribe to this user's chat rooms
  useEffect(() => {
    if (!currentUid) return;
    const unsub = chatService.subscribeToChatRooms(currentUid, setRooms);
    return unsub;
  }, [currentUid]);

  // Subscribe to messages for selected room, filtered by deletedAt / messagesCutoff for this user
  useEffect(() => {
    if (!selectedRoomId) { setMessages([]); return; }
    const unsub = chatService.subscribeToMessages(selectedRoomId, (msgs) => {
      const room = rooms.find(r => r.id === selectedRoomId);
      const deletedAtTs = room?.deletedAt?.[currentUid];
      const cutoffTs = room?.messagesCutoff?.[currentUid];
      // Use whichever cutoff is later
      const toMs = (ts: any) => ts?.toMillis ? ts.toMillis() : new Date(ts).getTime();
      const effectiveCutoff = deletedAtTs && cutoffTs
        ? (toMs(deletedAtTs) >= toMs(cutoffTs) ? deletedAtTs : cutoffTs)
        : (deletedAtTs || cutoffTs);
      const filtered = effectiveCutoff
        ? msgs.filter(m => {
            if (!m.timestamp) return true;
            return toMs(m.timestamp) > toMs(effectiveCutoff);
          })
        : msgs;
      setMessages(filtered);
      if (currentUid) chatService.markMessagesAsRead(selectedRoomId, currentUid).catch(() => {});
    });
    return unsub;
  }, [selectedRoomId, currentUid, rooms]);

  // Fetch contact photo from Firestore when selected room changes
  useEffect(() => {
    setContactPhoto('');
    if (!selectedRoomId || !db) return;
    const room = rooms.find(r => r.id === selectedRoomId);
    if (!room) return;
    const otherIdx = room.participants.indexOf(currentUid) === 0 ? 1 : 0;
    const storedAvatar = room.participantAvatars?.[otherIdx] || '';
    if (storedAvatar) { setContactPhoto(storedAvatar); return; }
    const otherId = room.participants[otherIdx];
    if (!otherId) return;
    (async () => {
      const cgSnap = await db.collection('caregivers').doc(otherId).get().catch(() => null);
      if (cgSnap?.exists) {
        const d = cgSnap.data() as any;
        setContactPhoto(d?.photo || d?.imageUrl || d?.profilePhotoUrl || '');
        return;
      }
      const uSnap = await db.collection('users').doc(otherId).get().catch(() => null);
      if (uSnap?.exists) {
        const d = uSnap.data() as any;
        setContactPhoto(d?.photoURL || d?.photo || d?.imageUrl || '');
      }
    })();
  }, [selectedRoomId, currentUid]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when room selected
  useEffect(() => {
    if (selectedRoomId) inputRef.current?.focus();
  }, [selectedRoomId]);

  const activeRoom = rooms.find(r => r.id === selectedRoomId)
    || (pendingRoomState?.id === selectedRoomId ? pendingRoomState : undefined);

  // Derive contact info for a room
  function getContact(room: ChatRoom) {
    const otherIdx = room.participants.findIndex(uid => uid !== currentUid);
    return {
      id: otherIdx >= 0 ? room.participants[otherIdx] : '',
      name: otherIdx >= 0 ? (room.participantNames?.[otherIdx] || 'Unknown') : 'Unknown',
      avatar: otherIdx >= 0 ? (room.participantAvatars?.[otherIdx] || '') : '',
    };
  }

  const handleSend = async () => {
    if (!inputText.trim() || !selectedRoomId || sending) return;
    if (!isClient && !gateMembership()) return;
    const text = inputText.trim();
    setInputText('');
    setSending(true);
    try {
      const roomExists = !!rooms.find(r => r.id === selectedRoomId);
      await chatService.sendMessage(
        selectedRoomId, currentUid, currentName, text,
        'text', undefined,
        roomExists ? undefined : pendingRoomState
      );

      // Notify the other participant via their notifications subcollection
      const contact = activeRoom ? getContact(activeRoom) : null;
      const fdb = db;
      if (contact?.id && fdb) {
        fdb.collection('users').doc(contact.id).collection('notifications').add({
          userId: contact.id,
          type: 'new_message',
          title: `New message from ${currentName}`,
          message: text.length > 80 ? text.slice(0, 80) + '…' : text,
          data: { chatRoomId: selectedRoomId, senderId: currentUid },
          read: false,
          isRead: false,
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString()
        }).catch(() => {}); // fire-and-forget
      }
    } catch {
      setInputText(text);
      onShowToast?.('Failed to send message. Please try again.', 'error');
    } finally {
      setSending(false);
    }
  };

  const filteredRooms = rooms.filter(r => {
    const otherId = r.participants.find(uid => uid !== currentUid) ?? '';
    if (blockedIds.has(otherId)) return false;
    if (!search) return true;
    const c = getContact(r);
    return c.name.toLowerCase().includes(search.toLowerCase()) ||
      r.lastMessage?.toLowerCase().includes(search.toLowerCase());
  });

  // Derive care team IDs from active bookings (appointments + accepted booking_requests)
  const careTeamIds = new Set([
    ...appointments
      .filter(a => ['pending_caregiver_confirmation', 'confirmed', 'in-progress'].includes(a.status))
      .map(a => isClient ? a.caregiverId : (a.clientId || ''))
      .filter(Boolean),
    ...acceptedBookingPartnerIds,
  ]);

  const careTeamRooms = filteredRooms.filter(r => !r.isSupport && careTeamIds.has(getContact(r).id));
  const supportRooms = filteredRooms.filter(r => r.isSupport);
  const otherRooms = filteredRooms.filter(r => !r.isSupport && !careTeamIds.has(getContact(r).id));

  // Auto-expand section if the selected room sits beyond the first visible item
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!selectedRoomId) return;
    const careTeamLabel = isClient ? 'My Care Team' : 'My Families';
    const otherLabel = isClient ? 'Other Caregivers' : 'Other Clients';
    if (careTeamRooms.findIndex(r => r.id === selectedRoomId) >= 3)
      setExpandedSections(prev => prev[careTeamLabel] ? prev : { ...prev, [careTeamLabel]: true });
    if (otherRooms.findIndex(r => r.id === selectedRoomId) >= 3)
      setExpandedSections(prev => prev[otherLabel] ? prev : { ...prev, [otherLabel]: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoomId, careTeamRooms.length, otherRooms.length]);

  // Group messages by date
  const groupedMessages: { date: string; msgs: Message[] }[] = [];
  messages.forEach(msg => {
    const label = formatDateSeparator(msg.timestamp);
    const last = groupedMessages[groupedMessages.length - 1];
    if (last && last.date === label) { last.msgs.push(msg); }
    else { groupedMessages.push({ date: label, msgs: [msg] }); }
  });

  const contact = activeRoom ? getContact(activeRoom) : null;
  const unreadTotal = rooms
    .filter(r => !blockedIds.has(r.participants.find(uid => uid !== currentUid) ?? ''))
    .reduce((sum, r) => sum + (r.unreadCount?.[currentUid] || 0), 0);

  return (
    <>
      {isClient ? <ClientNavigation /> : <CaregiverTopNav />}
      <div className="max-w-4xl mx-auto h-[calc(100vh-64px)] flex bg-white border-x border-slate-200 overflow-hidden pb-16 md:pb-0">

      {/* ── Thread List ── */}
      <div className={`w-full md:w-[320px] flex-shrink-0 bg-slate-50 border-r border-slate-200 flex flex-col ${selectedRoomId ? 'hidden md:flex' : 'flex'}`}>
        {/* Header */}
        <div className="p-4 border-b border-slate-200 bg-white">
          <div className="flex items-center gap-2 mb-3">
            <h1 className="text-lg font-bold text-slate-900 flex-1">Messages</h1>
            {unreadTotal > 0 && (
              <span className="px-2 py-0.5 bg-primary-600 text-white text-xs font-bold rounded-full">{unreadTotal}</span>
            )}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search conversations…"
              className="w-full pl-9 pr-3 py-2 bg-slate-100 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 transition-all"
            />
          </div>
        </div>

        {/* Room list */}
        <div className="flex-1 overflow-y-auto">
          {filteredRooms.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <Send className="w-6 h-6 text-slate-300" />
              </div>
              No conversations yet
            </div>
          ) : (
            <>
              {[
                { label: isClient ? 'My Care Team' : 'My Families', rooms: careTeamRooms, collapsible: true },
                { label: isClient ? 'Other Caregivers' : 'Other Clients', rooms: otherRooms, collapsible: true },
                { label: 'Support', rooms: supportRooms, collapsible: false },
              ].map(({ label, rooms: sectionRooms, collapsible }) => {
                if (sectionRooms.length === 0) return null;
                const isExpanded = expandedSections[label] ?? false;
                const visibleRooms = collapsible && !isExpanded ? sectionRooms.slice(0, 3) : sectionRooms;
                const hiddenCount = sectionRooms.length - 3;
                return (
                <div key={label}>
                  <p className="px-4 pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
                  {visibleRooms.map(room => {
                    const c = getContact(room);
                    const unread = room.unreadCount?.[currentUid] || 0;
                    const isActive = room.id === selectedRoomId;
                    return (
                      <button
                        key={room.id}
                        onClick={() => setSelectedRoomId(room.id)}
                        className={`w-full text-left px-4 py-3.5 border-b border-slate-100 transition-colors hover:bg-white ${isActive ? 'bg-white border-l-4 border-l-primary-500 pl-3' : ''}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="relative flex-shrink-0">
                            {c.avatar ? (
                              <img src={c.avatar} alt={c.name} className="w-11 h-11 rounded-full object-cover" />
                            ) : (
                              <div className="w-11 h-11 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold text-base">
                                {c.name.charAt(0).toUpperCase()}
                              </div>
                            )}
                            {unread > 0 && (
                              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-primary-600 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{unread}</span>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline justify-between gap-1">
                              <p className={`text-sm truncate ${unread > 0 ? 'font-bold text-slate-900' : 'font-semibold text-slate-700'}`}>{c.name}</p>
                              <span className="text-[10px] text-slate-400 whitespace-nowrap flex-shrink-0">{formatRoomTime(room.lastMessageTime)}</span>
                            </div>
                            <p className={`text-xs truncate mt-0.5 ${unread > 0 ? 'font-medium text-slate-700' : 'text-slate-400'}`}>
                              {room.lastMessage || 'Start a conversation'}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {collapsible && hiddenCount > 0 && (
                    <button
                      onClick={() => setExpandedSections(prev => ({ ...prev, [label]: !isExpanded }))}
                      className="w-full px-4 py-2 text-xs font-medium text-primary-600 hover:bg-slate-100 transition-colors text-left border-b border-slate-100"
                    >
                      {isExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* ── Chat Area ── */}
      <div className={`flex-1 flex flex-col min-w-0 ${!selectedRoomId ? 'hidden md:flex' : 'flex'}`}>
        {activeRoom && contact ? (
          <>
            {/* Chat header */}
            <div className="px-4 py-3 bg-white border-b border-slate-100 flex items-center justify-between shadow-sm z-10">
              <div className="flex items-center gap-3">
                <button onClick={() => setSelectedRoomId(null)} className="md:hidden p-1 text-slate-400">
                  <ChevronLeft className="w-6 h-6" />
                </button>
                {contactPhoto || contact.avatar ? (
                  <img src={contactPhoto || contact.avatar} alt={contact.name} className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-bold">
                    {contact.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <p className="font-bold text-slate-900 text-sm">{contact.name}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 relative">
                <div className="relative">
                  {!careTeamIds.has(contact.id) && !activeRoom.isSupport && (
                  <button onClick={() => setShowMenu(v => !v)} className="p-2 text-slate-400 hover:bg-slate-100 rounded-full transition-colors">
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  )}
                  {showMenu && !careTeamIds.has(contact.id) && !activeRoom.isSupport && (
                    <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-xl shadow-lg border border-slate-200 py-1 z-50">
                      {onViewProfile && (
                        <button onClick={() => { setShowMenu(false); onViewProfile(contact.id); }} className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                          View Profile
                        </button>
                      )}
                      <button onClick={() => { setShowMenu(false); handleBlock(contact.id, contact.name, contact.avatar); }} className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50">
                        Block User
                      </button>
                      <button onClick={() => { setShowMenu(false); setReportContactId(contact.id); setReportContactName(contact.name); setShowReportModal(true); }} className="w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                        <Flag className="w-3.5 h-3.5" />
                        Report
                      </button>
                      <button onClick={() => { setShowMenu(false); handleDeleteConversation(); }} className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50">
                        Delete Conversation
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 bg-slate-50 space-y-1" onClick={() => setShowMenu(false)}>
              {groupedMessages.map(({ date, msgs }) => (
                <div key={date}>
                  <div className="flex items-center justify-center my-4">
                    <span className="px-3 py-1 bg-slate-200 text-slate-500 text-xs rounded-full">{date}</span>
                  </div>
                  {msgs.map((msg, i) => {
                    const isMe = msg.senderId === currentUid;
                    const isSystem = msg.type === 'system';
                    const showName = !isMe && !isSystem && (i === 0 || msgs[i - 1].senderId !== msg.senderId);

                    if (isSystem) return (
                      <div key={msg.id} className="flex justify-center my-2">
                        <span className="px-3 py-1.5 bg-slate-200 text-slate-500 text-xs rounded-full text-center max-w-xs">{msg.text}</span>
                      </div>
                    );

                    return (
                      <div key={msg.id} className={`flex gap-2 ${isMe ? 'justify-end' : 'justify-start'} mb-1`}>
                        {!isMe && showName && (
                          <div className="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-semibold text-xs flex-shrink-0 mt-1">
                            {msg.senderName?.charAt(0)?.toUpperCase() || '?'}
                          </div>
                        )}
                        {!isMe && !showName && <div className="w-7 flex-shrink-0" />}
                        <div className={`max-w-[72%] ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                          {showName && !isMe && <p className="text-xs font-semibold text-primary-600 mb-0.5 ml-1">{msg.senderName}</p>}
                          <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${isMe
                            ? `${isClient ? 'bg-primary-600' : 'bg-accent-500'} text-white rounded-br-sm`
                            : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-sm'
                          }`}>
                            {msg.text}
                          </div>
                          <div className={`flex items-center gap-1 mt-0.5 ${isMe ? 'justify-end' : ''}`}>
                            <span className="text-[10px] text-slate-400">{formatMsgTime(msg.timestamp)}</span>
                            {isMe && msg.readBy && msg.readBy.length > 1 && (
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
            <div className="px-4 py-3 bg-white border-t border-slate-100">
              {isClient && !clientCanMessage ? (
                <div className="flex items-center justify-between gap-3 bg-slate-100 border border-slate-200 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-2 text-slate-500">
                    <Lock className="w-4 h-4 flex-shrink-0" />
                    <span className="text-sm font-medium">
                      {!identityVerified
                        ? 'Verify your identity to send messages'
                        : 'Activate your membership to send messages'}
                    </span>
                  </div>
                  <button
                    onClick={() => gate('message', contact?.name, () => {})}
                    className="text-xs font-semibold text-slate-600 hover:text-slate-800 underline whitespace-nowrap"
                  >
                    {!identityVerified ? 'Verify identity →' : 'Activate Membership →'}
                  </button>
                </div>
              ) : !isClient && !caregiverCanMessage ? (
                <div className="flex items-center justify-between gap-3 bg-slate-100 border border-slate-200 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-2 text-slate-500">
                    <Lock className="w-4 h-4 flex-shrink-0" />
                    <span className="text-sm font-medium">Activate your membership to send messages</span>
                  </div>
                  <button
                    onClick={() => navigate('/caregiver/membership')}
                    className="text-xs font-semibold text-slate-600 hover:text-slate-800 underline whitespace-nowrap"
                  >
                    Activate Membership →
                  </button>
                </div>
              ) : (
                <div className="flex gap-2 items-center">
                  <input
                    ref={inputRef}
                    value={inputText}
                    onChange={e => setInputText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                    placeholder="Type a message…"
                    className="flex-1 px-4 py-2.5 bg-slate-100 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 transition-all"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!inputText.trim() || sending}
                    className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
                      inputText.trim() && !sending
                        ? isClient ? 'bg-primary-600 hover:bg-primary-700 text-white' : 'bg-accent-500 hover:bg-accent-600 text-white'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="hidden md:flex flex-col items-center justify-center h-full text-slate-400">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
              <Send className="w-7 h-7 text-slate-300 ml-0.5" />
            </div>
            <p className="font-medium text-slate-500">Select a conversation</p>
            <p className="text-sm mt-1">Choose a chat from the list to start messaging</p>
          </div>
        )}
      </div>

      {isClient && <GateModals />}
      {!isClient && GateModal}

      {/* Report Modal */}
      {showReportModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-900 mb-1">Report User</h3>
            <p className="text-sm text-slate-500 mb-4">What's the reason for this report?</p>
            <div className="space-y-2 mb-4">
              {['Inappropriate behavior', 'Spam or scam', 'Harassment', 'Fake profile', 'Other'].map(r => (
                <button
                  key={r}
                  onClick={() => setReportReason(r)}
                  className={`w-full px-4 py-2.5 rounded-xl text-left text-sm font-medium border transition-colors ${
                    reportReason === r
                      ? 'border-primary-500 bg-primary-50 text-primary-800'
                      : 'border-slate-200 text-slate-700 hover:border-slate-300'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="mb-6">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Additional details <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={reportDetails}
                onChange={e => setReportDetails(e.target.value)}
                placeholder="Describe what happened…"
                rows={3}
                maxLength={500}
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200 resize-none placeholder-slate-400"
              />
              {reportDetails.length > 0 && (
                <p className="text-xs text-slate-400 text-right mt-1">{reportDetails.length}/500</p>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setShowReportModal(false); setReportReason(''); setReportDetails(''); }}
                className="flex-1 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReportSubmit}
                disabled={!reportReason}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                Submit Report
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
};
