import React, { createContext, useContext, useMemo, useState, ReactNode } from 'react';
import type { ToastMessage, ToastType } from '../types';

// Toasts live in their OWN provider (2026-11-11, fix plan Wave 4: "one central piece causes about 40 screens to redraw
// whenever a small notification pops up"). The toast LIST changes on every toast; the ACTIONS (add / remove) never do.
// Only the toast container reads the list, so a toast now re-renders it alone. useCareConnex().addToast still works —
// it is the same stable function.
interface ToastActions {
  addToast: (message: string, type: ToastType) => void;
  removeToast: (id: string) => void;
}

const noop: ToastActions = { addToast: () => {}, removeToast: () => {} };
const ToastListContext = createContext<ToastMessage[]>([]);
const ToastActionsContext = createContext<ToastActions>(noop);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const actions = useMemo<ToastActions>(() => ({
    addToast: (message, type) => {
      const id = Math.random().toString(36).slice(2, 11);
      setToasts((prev) => [...prev, { id, message, type }]);
    },
    removeToast: (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
  }), []);
  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastListContext.Provider value={toasts}>{children}</ToastListContext.Provider>
    </ToastActionsContext.Provider>
  );
};

/** Stable add/remove functions — reading these never causes a re-render when a toast appears. */
export const useToastActions = (): ToastActions => useContext(ToastActionsContext);
/** The current toasts — for the toast container (and anything that must react to them). Re-renders on every toast. */
export const useToasts = (): ToastMessage[] => useContext(ToastListContext);
