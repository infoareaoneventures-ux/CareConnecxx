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
  // Generate unique ID if not provided for label association
  const inputId = id || `input-${React.useId()}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className="w-full mb-4">
      <label
        htmlFor={inputId}
        className="block text-base font-semibold text-slate-800 mb-2"
      >
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={errorId}
        className={`
          w-full px-4 py-4 rounded-xl border-2 bg-white text-lg text-slate-900 focus:outline-none focus:ring-2 transition-all duration-200
          ${error
            ? 'border-red-400 focus:border-red-500 focus:ring-red-200'
            : 'border-slate-300 focus:border-primary-500 focus:ring-primary-100 hover:border-slate-400'
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