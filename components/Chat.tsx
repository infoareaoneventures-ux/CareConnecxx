import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Send, Paperclip, Phone, Video, MoreVertical, ChevronLeft, Image as ImageIcon } from 'lucide-react';
import { chatService, ChatRoom, Message } from '../services/chatService';
import { Button } from './ui/Button';

/**
 * Sanitize user input to prevent XSS attacks
 */
const sanitizeInput = (input: string): string => {
  const div = document.createElement('div');
  div.textContent = input;
  return div.innerHTML;
};

interface ChatProps {
  chatRoomId?: string;
  currentUserId: string;
  currentUserName: string;
  otherUserId?: string;
  otherUserName?: string;
  otherUserAvatar?: string;
  onClose?: () => void;
  onBack?: () => void;
  isModal?: boolean;
}

export const Chat: React.FC<ChatProps> = ({
  chatRoomId: initialChatRoomId,
  currentUserId,
  currentUserName,
  otherUserId,
  otherUserName,
  otherUserAvatar,
  onClose,
  onBack,
  isModal = false
}) => {
  const [chatRoomId, setChatRoomId] = useState<string | undefined>(initialChatRoomId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize chat room if needed
  useEffect(() => {
    const initChat = async () => {
      if (!chatRoomId && otherUserId && otherUserName) {
        setIsLoading(true);
        try {
          const roomId = await chatService.getOrCreateChatRoom(
            currentUserId,
            currentUserName,
            otherUserId,
            otherUserName
          );
          setChatRoomId(roomId);
        } catch (error) {
          console.error('Failed to create chat room:', error);
        } finally {
          setIsLoading(false);
        }
      }
    };

    initChat();
  }, [chatRoomId, currentUserId, currentUserName, otherUserId, otherUserName]);

  // Subscribe to messages
  useEffect(() => {
    if (!chatRoomId) return;

    const unsubscribe = chatService.subscribeToMessages(chatRoomId, (newMessages) => {
      setMessages(newMessages);
      // Mark messages as read
      chatService.markMessagesAsRead(chatRoomId, currentUserId);
    });

    return () => unsubscribe();
  }, [chatRoomId, currentUserId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    if (!inputText.trim() || !chatRoomId) return;

    const text = inputText.trim();
    const sanitizedText = sanitizeInput(text);
    setInputText('');
    setIsTyping(false);

    try {
      await chatService.sendMessage(
        chatRoomId,
        currentUserId,
        currentUserName,
        sanitizedText
      );
    } catch (error) {
      console.error('Failed to send message:', error);
      // Restore message if failed
      setInputText(text);
    }
  }, [inputText, chatRoomId, currentUserId, currentUserName]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const formatTime = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  // Group messages by date - memoized for performance
  const groupedMessages = useMemo(() => {
    return messages.reduce((groups, message) => {
      const date = formatDate(message.timestamp);
      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(message);
      return groups;
    }, {} as { [key: string]: Message[] });
  }, [messages]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]" role="status" aria-live="polite">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" aria-hidden="true"></div>
        <span className="sr-only">Loading chat...</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col bg-white ${isModal ? 'h-full rounded-lg overflow-hidden' : 'h-[600px] rounded-2xl shadow-lg border'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-primary-600 to-blue-600 text-white">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="p-1 hover:bg-white/20 rounded-full" aria-label="Go back">
              <ChevronLeft className="w-6 h-6" aria-hidden="true" />
            </button>
          )}
          
          <div className="relative">
            {otherUserAvatar ? (
              <img src={otherUserAvatar} alt={otherUserName} className="w-10 h-10 rounded-full object-cover" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-white/30 flex items-center justify-center text-lg font-semibold">
                {otherUserName?.charAt(0).toUpperCase() || '?'}
              </div>
            )}
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 rounded-full border-2 border-primary-600"></div>
          </div>
          
          <div>
            <h3 className="font-semibold text-lg">{otherUserName || 'Chat'}</h3>
            <p className="text-sm text-primary-100">Online</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="p-2 hover:bg-white/20 rounded-full transition-colors" aria-label="Start voice call">
            <Phone className="w-5 h-5" aria-hidden="true" />
          </button>
          <button className="p-2 hover:bg-white/20 rounded-full transition-colors" aria-label="Start video call">
            <Video className="w-5 h-5" aria-hidden="true" />
          </button>
          <button className="p-2 hover:bg-white/20 rounded-full transition-colors" aria-label="More options">
            <MoreVertical className="w-5 h-5" aria-hidden="true" />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-2 hover:bg-white/20 rounded-full transition-colors ml-2" aria-label="Close chat">
              <X className="w-6 h-6" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div 
        className="flex-1 overflow-y-auto p-4 bg-slate-50" 
        role="log" 
        aria-live="polite" 
        aria-label="Chat messages"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mb-4" aria-hidden="true">
              <Send className="w-8 h-8" />
            </div>
            <p className="text-lg font-medium">Start a conversation</p>
            <p className="text-sm">Send a message to begin chatting</p>
          </div>
        ) : (
          Object.entries(groupedMessages).map(([date, dateMessages]) => (
            <div key={date}>
              {/* Date separator */}
              <div className="flex items-center justify-center my-4" role="separator" aria-label={`Messages from ${date}`}>
                <div className="bg-slate-200 text-slate-600 text-xs px-3 py-1 rounded-full">
                  {date}
                </div>
              </div>

              {/* Messages for this date */}
              {dateMessages.map((message, index) => {
                const isCurrentUser = message.senderId === currentUserId;
                const isSystem = message.type === 'system';
                const showAvatar = !isCurrentUser && !isSystem && 
                  (index === 0 || dateMessages[index - 1].senderId !== message.senderId);

                if (isSystem) {
                  return (
                    <div key={message.id} className="flex justify-center my-3" role="status" aria-live="polite">
                      <div className="bg-slate-200 text-slate-600 text-sm px-4 py-2 rounded-full max-w-[80%] text-center">
                        {message.text}
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={message.id}
                    className={`flex gap-2 mb-3 ${isCurrentUser ? 'justify-end' : 'justify-start'}`}
                  >
                    {/* Avatar (for other user) */}
                    {!isCurrentUser && showAvatar && (
                      <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-semibold text-sm flex-shrink-0">
                        {message.senderName?.charAt(0).toUpperCase() || '?'}
                      </div>
                    )}
                    {!isCurrentUser && !showAvatar && <div className="w-8 flex-shrink-0" />}

                    {/* Message bubble */}
                    <div
                      className={`max-w-[70%] px-4 py-2 rounded-2xl ${
                        isCurrentUser
                          ? 'bg-gradient-to-r from-primary-600 to-blue-600 text-white rounded-br-md'
                          : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md shadow-sm'
                      }`}
                    >
                      {/* Sender name (for group chats) */}
                      {!isCurrentUser && showAvatar && (
                        <p className="text-xs font-semibold text-primary-600 mb-1">
                          {message.senderName}
                        </p>
                      )}
                      
                      <p className="text-sm leading-relaxed">{message.text}</p>
                      
                      {/* Time */}
                      <p className={`text-xs mt-1 ${isCurrentUser ? 'text-primary-100' : 'text-slate-400'}`}>
                        {formatTime(message.timestamp)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-200 p-4 bg-white">
        <div className="flex items-center gap-2">
          <button 
            className="p-2 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-full transition-colors"
            aria-label="Attach file"
          >
            <Paperclip className="w-5 h-5" aria-hidden="true" />
          </button>
          
          <button 
            className="p-2 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-full transition-colors"
            aria-label="Attach image"
          >
            <ImageIcon className="w-5 h-5" aria-hidden="true" />
          </button>

          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="Type a message..."
            aria-label="Message input"
            className="flex-1 px-4 py-2 bg-slate-100 border-0 rounded-full focus:outline-none focus:ring-2 focus:ring-primary-500"
          />

          <button
            onClick={handleSend}
            disabled={!inputText.trim()}
            aria-label="Send message"
            className={`p-3 rounded-full transition-colors ${
              inputText.trim()
                ? 'bg-gradient-to-r from-primary-600 to-blue-600 text-white hover:opacity-90'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            <Send className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        
        {isTyping && (
          <p className="text-xs text-slate-400 mt-2 ml-2">
            Typing...
          </p>
        )}
      </div>
    </div>
  );
};
