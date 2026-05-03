import React, { useState, useEffect } from 'react';
import { Bell, BellOff, Check, X } from 'lucide-react';
import { Button } from './ui/Button';
import { pushNotificationService } from '../services/pushNotificationService';

interface PushNotificationPromptProps {
  userId: string;
  onClose?: () => void;
}

/**
 * Push Notification Permission Prompt
 * 
 * Shows a friendly prompt asking user to enable push notifications
 * Only shows if:
 * - Browser supports notifications
 * - Permission hasn't been denied permanently
 * - User hasn't already granted permission
 */
export const PushNotificationPrompt: React.FC<PushNotificationPromptProps> = ({
  userId,
  onClose
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [isLoading, setIsLoading] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    checkPermission();
  }, []);

  const checkPermission = () => {
    // Check if supported
    if (!pushNotificationService.isSupported()) {
      return;
    }

    const currentPermission = pushNotificationService.getPermissionStatus();
    setPermission(currentPermission);

    // Show prompt if permission is default (not decided yet)
    if (currentPermission === 'default') {
      // Check if user previously dismissed the prompt
      const dismissed = localStorage.getItem('pushNotificationPromptDismissed');
      if (!dismissed) {
        // Show after a short delay (don't be too aggressive)
        setTimeout(() => {
          setIsVisible(true);
        }, 3000);
      }
    }
  };

  const handleEnable = async () => {
    setIsLoading(true);
    
    try {
      const success = await pushNotificationService.initialize(userId);
      
      if (success) {
        setPermission('granted');
        // Clear dismissed flag
        localStorage.removeItem('pushNotificationPromptDismissed');
        
        // Show success feedback briefly before closing
        setTimeout(() => {
          setIsVisible(false);
          onClose?.();
        }, 1500);
      } else {
        // Permission denied or failed
        checkPermission();
      }
    } catch (error) {
      console.error('Error enabling notifications:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDismiss = () => {
    setIsDismissed(true);
    setIsVisible(false);
    
    // Remember dismissal (but still allow future prompts)
    localStorage.setItem('pushNotificationPromptDismissed', 'true');
    
    onClose?.();
  };

  const handleClose = () => {
    setIsVisible(false);
    onClose?.();
  };

  // Don't render if not visible or already decided
  if (!isVisible || permission === 'granted' || permission === 'denied') {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 left-4 md:left-auto md:w-96 z-50 animate-slide-up">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className="bg-primary-100 p-2 rounded-full">
              <Bell className="w-6 h-6 text-primary-600" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">Stay Updated</h3>
              <p className="text-sm text-slate-500">Get instant notifications</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="mb-6">
          <p className="text-slate-600 text-sm leading-relaxed">
            Enable push notifications to receive instant alerts when:
          </p>
          <ul className="mt-3 space-y-2">
            <li className="flex items-center text-sm text-slate-600">
              <Check className="w-4 h-4 text-primary-500 mr-2 flex-shrink-0" />
              Caregivers send you messages
            </li>
            <li className="flex items-center text-sm text-slate-600">
              <Check className="w-4 h-4 text-primary-500 mr-2 flex-shrink-0" />
              Appointments are approaching
            </li>
            <li className="flex items-center text-sm text-slate-600">
              <Check className="w-4 h-4 text-primary-500 mr-2 flex-shrink-0" />
              Caregivers check in/out
            </li>
          </ul>
        </div>

        {/* Actions */}
        <div className="flex space-x-3">
          <Button
            onClick={handleEnable}
            disabled={isLoading}
            className="flex-1"
          >
            {isLoading ? (
              <span className="flex items-center">
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Enabling...
              </span>
            ) : (
              <span className="flex items-center">
                <Bell className="w-4 h-4 mr-2" />
                Enable Notifications
              </span>
            )}
          </Button>
          <Button
            variant="secondary"
            onClick={handleDismiss}
            className="px-4"
          >
            <BellOff className="w-4 h-4" />
          </Button>
        </div>

        {/* Trust note */}
        <p className="mt-4 text-xs text-slate-400 text-center">
          You can change this anytime in your browser settings
        </p>
      </div>
    </div>
  );
};

/**
 * Push Notification Settings Panel
 * For use in profile/settings page
 */
export const PushNotificationSettings: React.FC<{ userId: string }> = ({ userId }) => {
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setPermission(pushNotificationService.getPermissionStatus());
  }, []);

  const handleToggle = async () => {
    setIsLoading(true);
    
    if (permission === 'granted') {
      // User wants to disable
      await pushNotificationService.removeToken(userId);
      setPermission('default');
    } else {
      // User wants to enable
      const success = await pushNotificationService.initialize(userId);
      if (success) {
        setPermission('granted');
      }
    }
    
    setIsLoading(false);
  };

  if (!pushNotificationService.isSupported()) {
    return (
      <div className="bg-slate-50 rounded-lg p-4">
        <p className="text-sm text-slate-500">
          Push notifications are not supported in this browser.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {permission === 'granted' ? (
            <div className="bg-primary-100 p-2 rounded-full">
              <Bell className="w-5 h-5 text-primary-600" />
            </div>
          ) : (
            <div className="bg-slate-100 p-2 rounded-full">
              <BellOff className="w-5 h-5 text-slate-400" />
            </div>
          )}
          <div>
            <h4 className="font-medium text-slate-900">Push Notifications</h4>
            <p className="text-sm text-slate-500">
              {permission === 'granted' 
                ? 'Notifications are enabled' 
                : permission === 'denied'
                ? 'Notifications are blocked in browser settings'
                : 'Enable to receive alerts'}
            </p>
          </div>
        </div>
        
        {permission !== 'denied' && (
          <button
            onClick={handleToggle}
            disabled={isLoading}
            className={`
              relative inline-flex h-6 w-11 items-center rounded-full transition-colors
              ${permission === 'granted' ? 'bg-primary-600' : 'bg-slate-200'}
              ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            <span
              className={`
                inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                ${permission === 'granted' ? 'translate-x-6' : 'translate-x-1'}
              `}
            />
          </button>
        )}
      </div>

      {permission === 'denied' && (
        <div className="mt-3 p-3 bg-accent-50 rounded-lg">
          <p className="text-sm text-accent-700">
            Notifications are blocked. To enable, update your browser settings and refresh the page.
          </p>
        </div>
      )}
    </div>
  );
};
