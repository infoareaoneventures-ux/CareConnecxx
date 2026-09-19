import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing, Info, Calendar, MessageSquare, AlertTriangle, Trash2, CheckCheck } from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import { authService } from '../../services/api';
import { AppNotification } from '../../types';
import { routeForNotification } from '../../utils/notificationRoutes';

interface NotificationDropdownProps {
  /** Which nav mounted this dropdown — decides where a notification click navigates. */
  role?: 'client' | 'caregiver';
}

// Notification click → destination: utils/notificationRoutes.ts (one map, mirrored for Evia).

/**
 * Accessible notification dropdown with keyboard navigation
 */
export const NotificationDropdown: React.FC<NotificationDropdownProps> = ({ role = 'client' }) => {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const currentUser = authService.getCurrentUser();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  
  const {
    notifications,
    unreadCount,
    loading,
    error,
    markAsRead,
    markAllAsRead,
    deleteNotification
  } = useNotifications(currentUser?.uid || null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Handle escape key to close dropdown
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const handleMarkAllRead = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    markAllAsRead();
  }, [markAllAsRead]);

  const handleDelete = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNotification(id);
  }, [deleteNotification]);

  const handleNotificationClick = useCallback((notif: AppNotification) => {
    if (!notif.isRead) markAsRead(notif.id);
    setIsOpen(false);
    navigate(routeForNotification(notif, role));
  }, [markAsRead, navigate, role]);

  const getIcon = (type: string) => {
    switch (type) {
      case 'booking': return <Calendar className="w-4 h-4 text-blue-500" aria-hidden="true" />;
      case 'message': return <MessageSquare className="w-4 h-4 text-green-500" aria-hidden="true" />;
      case 'alert': return <AlertTriangle className="w-4 h-4 text-red-500" aria-hidden="true" />;
      default: return <Info className="w-4 h-4 text-slate-500" aria-hidden="true" />;
    }
  };

  const getBgColor = (type: string, isRead: boolean) => {
    if (isRead) return 'bg-white';
    switch (type) {
      case 'booking': return 'bg-blue-50/50';
      case 'message': return 'bg-green-50/50';
      case 'alert': return 'bg-red-50/50';
      default: return 'bg-slate-50';
    }
  };

  const dropdownId = React.useId();

  return (
    <div className="relative" ref={dropdownRef}>
      <button 
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={`p-2 rounded-full border transition-colors relative ${
          isOpen ? 'bg-primary-50 border-primary-200 text-primary-600' : 'bg-white border-slate-200 text-slate-400'
        }`}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-controls={isOpen ? `${dropdownId}-menu` : undefined}
        aria-label={`Notifications ${unreadCount > 0 ? `(${unreadCount} unread)` : ''}`}
      >
        {unreadCount > 0 ? (
          <BellRing className="w-6 h-6 animate-pulse text-accent-500" aria-hidden="true" />
        ) : (
          <Bell className="w-6 h-6" aria-hidden="true" />
        )}
        {unreadCount > 0 && (
          <span 
            className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] w-5 h-5 rounded-full flex items-center justify-center font-bold"
            aria-hidden="true"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} aria-hidden="true" />
          <div 
            id={`${dropdownId}-menu`}
            className="absolute right-0 mt-3 w-96 bg-white rounded-2xl shadow-xl border border-slate-100 z-50 overflow-hidden animate-slide-in"
            role="menu"
            aria-labelledby={`${dropdownId}-title`}
          >
            {/* Header */}
            <div className="p-4 border-b border-slate-50 flex justify-between items-center bg-slate-50">
              <div>
                <h3 id={`${dropdownId}-title`} className="font-bold text-slate-800">Notifications</h3>
                {unreadCount > 0 && (
                  <span className="text-xs text-slate-500">
                    {unreadCount} unread
                  </span>
                )}
              </div>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1 px-2 py-1 rounded hover:bg-primary-50 transition-colors"
                  aria-label="Mark all notifications as read"
                >
                  <CheckCheck className="w-3 h-3" aria-hidden="true" /> Mark all read
                </button>
              )}
            </div>
            
            {/* Notifications List */}
            <div className="max-h-[400px] overflow-y-auto" role="menu">
              {error ? (
                <div className="p-8 text-center text-slate-400" role="alert">
                  <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-red-400" aria-hidden="true" />
                  <p className="text-sm">Failed to load notifications</p>
                  <p className="text-xs mt-1 opacity-60">Please try again later</p>
                </div>
              ) : loading ? (
                <div className="p-8 text-center">
                  <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" aria-hidden="true" />
                  <p className="text-slate-400 text-sm">Loading...</p>
                </div>
              ) : notifications.length > 0 ? (
                notifications.map((notif) => (
                  <div 
                    key={notif.id} 
                    role="menuitem"
                    tabIndex={0}
                    className={`p-4 border-b border-slate-50 hover:bg-slate-50 transition-colors group cursor-pointer ${getBgColor(notif.type, notif.isRead)}`}
                    onClick={() => handleNotificationClick(notif)}
                    onKeyDown={(e) => e.key === 'Enter' && handleNotificationClick(notif)}
                    aria-label={`${notif.title}. ${notif.body}. ${notif.isRead ? 'Read' : 'Unread'}`}
                  >
                    <div className="flex gap-3">
                      <div className="mt-1" aria-hidden="true">{getIcon(notif.type)}</div>
                      <div className="flex-grow min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <h4 className={`text-sm ${!notif.isRead ? 'font-bold text-slate-900' : 'font-medium text-slate-700'}`}>
                            {notif.title}
                          </h4>
                          <button
                            onClick={(e) => handleDelete(notif.id, e)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-100 rounded"
                            title="Delete"
                            aria-label={`Delete "${notif.title}"`}
                          >
                            <Trash2 className="w-3 h-3 text-red-400" aria-hidden="true" />
                          </button>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5 leading-snug">{notif.body}</p>
                        <span className="text-[10px] text-slate-400 mt-2 block">
                          {notif.createdAt && (() => {
                            const raw = notif.createdAt as any;
                            const d = raw?.toDate ? raw.toDate() : new Date(raw);
                            return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                          })()}
                        </span>
                      </div>
                      {!notif.isRead && (
                        <div className="w-2 h-2 bg-accent-500 rounded-full mt-2 flex-shrink-0" aria-hidden="true"></div>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-8 text-center text-slate-400">
                  <Bell className="w-12 h-12 mx-auto mb-3 opacity-20" aria-hidden="true" />
                  <p className="text-sm">No notifications yet</p>
                  <p className="text-xs mt-1 opacity-60">We'll notify you when something happens</p>
                </div>
              )}
            </div>

          </div>
        </>
      )}
    </div>
  );
};
