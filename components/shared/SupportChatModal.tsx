import React, { useState } from 'react';
import { MessageSquare, Send, X, CheckCircle } from 'lucide-react';
import { chatService } from '../../services/chatService';
import { authService } from '../../services/api';
import { sanitizeMessage } from '../../utils/sanitize';

interface SupportChatModalProps {
  onClose: () => void;
  userName?: string;
}

export const SupportChatModal: React.FC<SupportChatModalProps> = ({ onClose, userName }) => {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const currentUser = authService.getCurrentUser();

  const handleSend = async () => {
    if (!message.trim() || sending || !currentUser) return;
    setSending(true);
    setError('');
    try {
      const displayName =
        userName ||
        currentUser.displayName ||
        currentUser.email?.split('@')[0] ||
        'User';
      const roomId = await chatService.createOrGetSupportRoom(currentUser.uid, displayName);
      await chatService.sendMessage(roomId, currentUser.uid, displayName, sanitizeMessage(message.trim()));
      setSent(true);
    } catch {
      setError('Could not send message. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSend();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-primary-600 to-primary-500 px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-white/20 rounded-full flex items-center justify-center">
              <MessageSquare className="w-4 h-4 text-white" />
            </div>
            <div>
              <h3 className="font-bold text-white">Chat with Support</h3>
              <p className="text-xs text-primary-100">We typically respond within a few hours</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-white/20 rounded-full transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        <div className="p-5">
          {sent ? (
            <div className="text-center py-6">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h4 className="font-bold text-slate-900 mb-2">Message Sent!</h4>
              <p className="text-sm text-slate-500 mb-5">
                Our support team will reply in your inbox. You'll be notified when they respond.
              </p>
              <button
                onClick={onClose}
                className="px-6 py-2.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-600 mb-4">
                Send us a message and our care team will reply directly in your inbox.
              </p>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="How can we help you today?"
                rows={5}
                className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 resize-none"
                autoFocus
              />
              <p className="text-xs text-slate-400 mt-1 mb-3">Press Ctrl+Enter to send</p>
              {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
              <button
                onClick={handleSend}
                disabled={!message.trim() || sending}
                className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  message.trim() && !sending
                    ? 'bg-primary-600 hover:bg-primary-700 text-white'
                    : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                }`}
              >
                <Send className="w-4 h-4" />
                {sending ? 'Sending…' : 'Send Message'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
