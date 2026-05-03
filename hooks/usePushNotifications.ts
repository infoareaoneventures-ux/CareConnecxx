import { useEffect, useState, useCallback } from 'react';
import { pushNotificationService } from '../services/pushNotificationService';

/**
 * Hook for managing push notifications
 * 
 * Usage:
 * const { 
 *   permission, 
 *   initialize, 
 *   showPrompt,
 *   dismissPrompt 
 * } = usePushNotifications(userId);
 */
export function usePushNotifications(userId?: string, addToast?: (message: string, type: 'success' | 'error' | 'info') => void) {
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [showPrompt, setShowPrompt] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Check permission on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setPermission(pushNotificationService.getPermissionStatus());
    }
  }, []);

  // Initialize push notifications
  const initialize = useCallback(async (): Promise<boolean> => {
    if (!userId) {
      console.warn('Cannot initialize push notifications: no userId');
      return false;
    }

    try {
      const success = await pushNotificationService.initialize(userId);
      
      if (success) {
        setPermission('granted');
        setIsInitialized(true);
        addToast?.('Push notifications enabled!', 'success');
      } else {
        setPermission(pushNotificationService.getPermissionStatus());
      }
      
      return success;
    } catch (error) {
      console.error('Error initializing push notifications:', error);
      addToast?.('Failed to enable notifications', 'error');
      return false;
    }
  }, [userId, addToast]);

  // Request permission and show prompt if needed
  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!pushNotificationService.isSupported()) {
      addToast?.('Notifications not supported in this browser', 'error');
      return false;
    }

    const result = await pushNotificationService.requestPermission();
    setPermission(result);

    if (result === 'granted' && userId) {
      return await initialize();
    }

    return result === 'granted';
  }, [userId, initialize, addToast]);

  // Show notification prompt
  const promptForPermission = useCallback(() => {
    if (permission === 'default') {
      setShowPrompt(true);
    }
  }, [permission]);

  // Dismiss prompt
  const dismissPrompt = useCallback(() => {
    setShowPrompt(false);
    localStorage.setItem('pushNotificationPromptDismissed', 'true');
  }, []);

  // Remove token (on logout)
  const removeToken = useCallback(async () => {
    if (userId) {
      await pushNotificationService.removeToken(userId);
      setIsInitialized(false);
      setPermission('default');
    }
  }, [userId]);

  // Send test notification
  const sendTest = useCallback(async () => {
    const success = await pushNotificationService.sendTestNotification();
    if (success) {
      addToast?.('Test notification sent', 'success');
    } else {
      addToast?.('Failed to send test', 'error');
    }
  }, [addToast]);

  // Subscribe to topic
  const subscribeToTopic = useCallback(async (topic: string) => {
    const success = await pushNotificationService.subscribeToTopic(topic);
    if (success) {
      addToast?.(`Subscribed to ${topic}`, 'success');
    } else {
      addToast?.(`Failed to subscribe to ${topic}`, 'error');
    }
    return success;
  }, [addToast]);

  // Set message handler
  const onMessage = useCallback((callback: (payload: any) => void) => {
    pushNotificationService.onMessage(callback);
  }, []);

  return {
    permission,
    isInitialized,
    showPrompt,
    isSupported: pushNotificationService.isSupported(),
    initialize,
    requestPermission,
    promptForPermission,
    dismissPrompt,
    removeToken,
    sendTest,
    subscribeToTopic,
    onMessage
  };
}
