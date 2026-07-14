import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

/**
 * Accessible Input component with label and error handling
 * 
 * @example
 * <Input label="Email" type="email" error="Invalid email" />
 */
export const Input: React.FC<InputProps> = ({ label, error, className = '', id, ...props }) => {
  // Generate unique ID if not provided for label association. useId() MUST be
  // called unconditionally (Rules of Hooks) — the previous `id || ...useId()`
  // short-circuited the hook when `id` was passed, so a caller that sometimes
  // passed id and sometimes didn't would crash the subtree with a hook-count
  // mismatch.
  const generatedId = React.useId();
  const inputId = id || `input-${generatedId}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className="w-full mb-4">
      <label
        htmlFor={inputId}
        className="block text-sm font-medium text-ink-900 mb-2"
      >
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={errorId}
        className={`
          w-full px-4 py-3.5 rounded-2xl border bg-white text-base text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 transition-all duration-200
          ${error
            ? 'border-red-400 focus:border-red-500 focus:ring-red-200'
            : 'border-[rgba(26,31,43,0.15)] focus:border-ink-900 focus:ring-[rgba(26,31,43,0.10)] hover:border-[rgba(26,31,43,0.30)]'
          }
          ${className}
        `}
        {...props}
      />
      {error && (
        <p id={errorId} className="mt-2 text-sm text-red-600 font-medium" role="alert">{error}</p>
      )}
    </div>
  );
};