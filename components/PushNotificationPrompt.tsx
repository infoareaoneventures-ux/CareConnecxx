import React, { useState, useEffect } from 'react';
import { Bell } from 'lucide-react';
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

  // A compact banner at the bottom edge (it used to be a large card that covered the dashboard).
  return (
    <div className="fixed bottom-4 right-4 left-4 md:left-auto md:w-96 z-50 animate-slide-up" role="region" aria-label="Turn on notifications">
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 px-4 py-3 flex items-center gap-3">
        <Bell className="w-5 h-5 text-ink-600 flex-shrink-0" aria-hidden="true" />
        <p className="flex-1 text-sm text-slate-700">Get a notification when a care provider messages you or a visit is close.</p>
        <Button onClick={handleEnable} disabled={isLoading} size="sm">
          {isLoading ? 'Enabling…' : 'Turn on'}
        </Button>
        <button
          onClick={handleDismiss}
          className="text-sm text-slate-500 hover:text-slate-700 font-medium px-1"
        >
          Not now
        </button>
      </div>
    </div>
  );
};
