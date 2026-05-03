import React, { useEffect } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { ToastMessage } from '../../types';

interface ToastProps {
  toasts: ToastMessage[];
  removeToast: (id: string) => void;
}

/**
 * Accessible toast notification container
 * Uses aria-live region for screen reader announcements
 */
export const ToastContainer: React.FC<ToastProps> = ({ toasts, removeToast }) => {
  return (
    <div 
      className="fixed top-4 left-1/2 transform -translate-x-1/2 z-[500] flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-atomic="true"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
      ))}
    </div>
  );
};

interface ToastItemProps {
  toast: ToastMessage;
  onRemove: () => void;
}

const ToastItem: React.FC<ToastItemProps> = ({ toast, onRemove }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onRemove();
    }, 4000);
    return () => clearTimeout(timer);
  }, [onRemove]);

  const styles = {
    success: "bg-slate-900 text-white border border-slate-800",
    error: "bg-red-50 text-red-900 border border-red-200",
    info: "bg-blue-50 text-blue-900 border border-blue-200",
  };

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-green-400" aria-hidden="true" />,
    error: <AlertCircle className="w-5 h-5 text-red-500" aria-hidden="true" />,
    info: <Info className="w-5 h-5 text-blue-500" aria-hidden="true" />,
  };

  const ariaLabels = {
    success: "Success notification",
    error: "Error notification",
    info: "Information notification",
  };

  return (
    <div 
      role="alert"
      aria-label={ariaLabels[toast.type]}
      className={`pointer-events-auto ${styles[toast.type]} shadow-xl rounded-xl p-4 flex items-center justify-between transform transition-all duration-500 animate-slide-in`}
    >
      <div className="flex items-center gap-3">
        {icons[toast.type]}
        <span className="font-medium text-sm">{toast.message}</span>
      </div>
      <button 
        onClick={onRemove} 
        className="opacity-50 hover:opacity-100 transition-opacity"
        aria-label="Dismiss notification"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
};