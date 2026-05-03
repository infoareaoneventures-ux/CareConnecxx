import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'accent' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

/**
 * Accessible Button component with variants and sizes
 * 
 * @example
 * <Button variant="primary" size="lg" onClick={handleClick}>
 *   Click Me
 * </Button>
 */
export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className = '',
  disabled = false,
  ...props
}) => {
  const baseStyles = "inline-flex items-center justify-center font-semibold transition-all duration-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2";

  const variants = {
    primary: "bg-gradient-to-r from-[var(--color-primary-600)] to-[var(--color-primary-500)] text-white hover:from-[var(--color-primary-700)] hover:to-[var(--color-primary-600)] focus:ring-[var(--color-primary-500)] shadow-lg shadow-[var(--color-primary-500)]/30 hover:shadow-[var(--color-primary-500)]/40 hover:-translate-y-0.5 active:translate-y-0",
    secondary: "bg-white text-[var(--color-neutral-700)] border border-[var(--color-neutral-200)] hover:bg-[var(--color-neutral-50)] focus:ring-[var(--color-neutral-300)] shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0",
    accent: "bg-gradient-to-r from-[var(--color-accent-500)] to-[var(--color-accent-400)] text-white hover:from-[var(--color-accent-600)] hover:to-[var(--color-accent-500)] focus:ring-[var(--color-accent-400)] shadow-lg shadow-[var(--color-accent-500)]/30 hover:shadow-[var(--color-accent-500)]/40 hover:-translate-y-0.5 active:translate-y-0",
    outline: "border-2 border-[var(--color-primary-600)] text-[var(--color-primary-600)] hover:bg-[var(--color-primary-50)] hover:shadow-lg hover:shadow-[var(--color-primary-500)]/10 hover:-translate-y-0.5 active:translate-y-0"
  };

  const sizes = {
    sm: "px-4 py-2 text-base min-h-[44px]",
    md: "px-6 py-3 text-lg min-h-[52px]",
    lg: "px-8 py-4 text-xl min-h-[60px]"
  };

  return (
    <button
      className={`
        ${baseStyles} 
        ${variants[variant]} 
        ${sizes[size]} 
        ${fullWidth ? 'w-full' : ''} 
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}
      `}
      disabled={disabled}
      aria-disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
};