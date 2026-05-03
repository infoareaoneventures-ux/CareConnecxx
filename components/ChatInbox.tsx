import React, { useState, useEffect } from 'react';
import { MessageSquare, ChevronRight, Circle, Search, Clock } from 'lucide-react';
import { chatService, ChatRoom } from '../services/chatService';
import { Chat } from './Chat';

interface ChatInboxProps {
  userId: string;
  userName: string;
  userType: 'client' | 'caregiver';
}

export const ChatInbox: React.FC<ChatInboxProps> = ({ userId, userName, userType }) => {
  const [chatRooms, setChatRooms] = useState<ChatRoom[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<ChatRoom | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Subscribe to chat rooms
  useEffect(() => {
    const unsubscribe = chatService.subscribeToChatRooms(userId, (rooms) => {
      setChatRooms(rooms);
      setIsLoading(false);
      
      // Calculate total unread
      const total = rooms.reduce((sum, room) => {
        return sum + (room.unreadCount?.[userId] || 0);
      }, 0);
      setUnreadCount(total);
    });

    return () => unsubscribe();
  }, [userId]);

  const formatTime = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return 'Yesterday';
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  const getOtherParticipant = (room: ChatRoom) => {
    const index = room.participants.indexOf(userId);
    const otherIndex = index === 0 ? 1 : 0;
    return {
      id: room.participants[otherIndex],
      name: room.participantNames[otherIndex],
      avatar: room.participantAvatars[otherIndex]
    };
  };

  const filteredRooms = chatRooms.filter(room => {
    const other = getOtherParticipant(room);
    return other.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  if (selectedRoom) {
    const otherParticipant = getOtherParticipant(selectedRoom);
    return (
      <Chat
        chatRoomId={selectedRoom.id}
        currentUserId={userId}
        currentUserName={userName}
        otherUserId={otherParticipant.id}
        otherUserName={otherParticipant.name}
        otherUserAvatar={otherParticipant.avatar}
        onBack={() => setSelectedRoom(null)}
        isModal={false}
      />
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-primary-600 to-blue-600 text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <MessageSquare className="w-6 h-6" />
              {unreadCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </div>
            <h2 className="text-xl font-bold">Messages</h2>
          </div>
          <span className="text-primary-100 text-sm">
            {chatRooms.length} conversation{chatRooms.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Search */}
      <div className="p-4 border-b border-slate-200">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-100 border-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>

      {/* Chat List */}
      <div className="max-h-[500px] overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : filteredRooms.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium">No conversations yet</p>
            <p className="text-sm">
              {searchQuery ? 'No matches found' : 'Start chatting with your caregivers'}
            </p>
          </div>
        ) : (
          filteredRooms.map((room) => {
            const other = getOtherParticipant(room);
            const unread = room.unreadCount?.[userId] || 0;
            
            return (
              <button
                key={room.id}
                onClick={() => setSelectedRoom(room)}
                className="w-full flex items-center gap-4 p-4 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0 text-left"
              >
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                  {other.avatar ? (
                    <img
                      src={other.avatar}
                      alt={other.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary-500 to-blue-500 flex items-center justify-center text-white font-semibold">
                      {other.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  {unread > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-white"></span>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className={`font-semibold truncate ${unread > 0 ? 'text-slate-900' : 'text-slate-700'}`}>
                      {other.name}
                    </h3>
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      {formatTime(room.lastMessageTimestamp)}
                    </span>
                  </div>
                  <p className={`text-sm truncate ${unread > 0 ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                    {room.lastMessage || 'No messages yet'}
                  </p>
                </div>

                {/* Arrow */}
                <ChevronRight className="w-5 h-5 text-slate-300 flex-shrink-0" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

// Chat Badge Component for Navigation
interface ChatBadgeProps {
  userId: string;
}

export const ChatBadge: React.FC<ChatBadgeProps> = ({ userId }) => {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const fetchUnread = async () => {
      const count = await chatService.getUnreadCount(userId);
      setUnreadCount(count);
    };

    fetchUnread();
    
    // Poll every 30 seconds
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, [userId]);

  if (unreadCount === 0) return null;

  return (
    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
      {unreadCount > 9 ? '9+' : unreadCount}
    </span>
  );
};
