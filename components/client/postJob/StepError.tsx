import React from 'react';

/** A step's validation message, shown right above its Continue button (2026-11-11: these were toasts at the top of the
 *  screen that lingered on the next step). Nothing renders when there is no message. */
export const StepError: React.FC<{ message: string | null }> = ({ message }) =>
  message ? <p role="alert" data-testid="step-error" className="mt-6 -mb-4 text-sm text-red-600">{message}</p> : null;
