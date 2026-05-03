import React, { useState, useEffect } from 'react';
import { Bell, Check, X, Clock } from 'lucide-react';
import { dbService, authService } from '../services/api';

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  timestamp: string;
  read: boolean;
  entryId?: string;
}

interface NotificationBellProps {
  userId: string;
  onNotificationClick?: (notification: Notification) => void;
}

/**
 * Notification Bell Component
 * Shows unread notifications with dropdown
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({
  userId,
  onNotificationClick
}) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const unsubscribe = dbService.subscribeToUserNotifications(
      userId,
      (notifs) => {
        setNotifications(notifs as unknown as Notification[]);
        setUnreadCount(notifs.filter(n => !n.isRead).length);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  const markAsRead = async (notificationId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    await dbService.markNotificationRead(userId, notificationId);
  };

  const markAllAsRead = async () => {
    const unreadNotifications = notifications.filter(n => !n.read);
    
    // Use Promise.allSettled to handle individual failures
    const results = await Promise.allSettled(
      unreadNotifications.map(n => dbService.markNotificationRead(userId, n.id))
    );
    
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(`Failed to mark ${failures.length} notifications as read`);
      // Optionally show toast to user
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'caregiver_check_in': return '📝';
      case 'caregiver_arrived': return '✅';
      case 'caregiver_departed': return '👋';
      case 'new_booking': return '📅';
      case 'appointment_cancelled': return '❌';
      case 'new_message': return '💬';
      case 'new_review': return '⭐';
      case 'interview_request': return '🎥';
      case 'interview_accepted': return '✅';
      case 'interview_declined': return '❌';
      case 'hire_decision': return '🤝';
      case 'job_application': return '📋';
      case 'interview_outcome': return '📝';
      case 'timesheet_approved': return '✅';
      case 'timesheet_rejected': return '⚠️';
      default: return '🔔';
    }
  };

  return (
    <div className="relative">
      {/* Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-3 rounded-full hover:bg-slate-100 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-6 h-6 text-slate-600" />
        
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center animate-pulse">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setIsOpen(false)}
          />
          
          {/* Notification Panel */}
          <div className="absolute right-0 mt-2 w-80 md:w-96 bg-white rounded-2xl shadow-xl border border-slate-200 z-50 overflow-hidden animate-slide-in">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <h3 className="font-bold text-slate-900">Notifications</h3>
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  className="text-sm text-primary-600 hover:text-primary-700 font-medium"
                >
                  Mark all read
                </button>
              )}
            </div>

            {/* Notifications List */}
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  <Bell className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No notifications yet</p>
                  <p className="text-sm mt-1">You'll see updates here when caregivers check in</p>
                </div>
              ) : (
                notifications.map((notification) => (
                  <div
                    key={notification.id}
                    onClick={() => {
                      onNotificationClick?.(notification);
                      markAsRead(notification.id);
                      setIsOpen(false);
                    }}
                    className={`p-4 border-b border-slate-100 cursor-pointer hover:bg-slate-50 transition-colors ${
                      !notification.read ? 'bg-primary-50/50' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl">{getNotificationIcon(notification.type)}</span>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`font-semibold text-sm ${!notification.read ? 'text-slate-900' : 'text-slate-700'}`}>
                            {notification.title}
                          </p>
                          {!notification.read && (
                            <span className="w-2 h-2 bg-primary-500 rounded-full flex-shrink-0 mt-1.5" />
                          )}
                        </div>
                        
                        <p className="text-sm text-slate-600 mt-1 line-clamp-2">
                          {notification.message}
                        </p>
                        
                        <div className="flex items-center gap-2 mt-2">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span className="text-xs text-slate-400">
                            {formatTime(notification.timestamp)}
                          </span>
                        </div>
                      </div>

                      {!notification.read && (
                        <button
                          onClick={(e) => markAsRead(notification.id, e)}
                          className="p-1 hover:bg-white rounded-full transition-colors"
                          title="Mark as read"
                        >
                          <Check className="w-4 h-4 text-primary-600" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-slate-100 bg-slate-50">
              <button
                onClick={() => setIsOpen(false)}
                className="w-full text-center text-sm text-slate-500 hover:text-slate-700 font-medium py-2"
              >
                Close
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
