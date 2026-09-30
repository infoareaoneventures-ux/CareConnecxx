import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'accent' | 'outline' | 'brand';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

/**
 * Accessible Button component with variants and sizes.
 * Visual language matches the landing design system: one dark tactile pill
 * for primary actions, quiet paper-toned secondaries. See context/ui-context.md.
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
  const baseStyles = "inline-flex items-center justify-center font-semibold transition-all duration-200 rounded-full focus:outline-none focus:ring-2 focus:ring-offset-2";

  const variants = {
    primary: "btn-depth-primary focus:ring-[var(--color-ink-600)]",
    secondary: "bg-white text-[var(--color-ink-600)] border hairline hover:text-[var(--color-ink-900)] hover:bg-[var(--color-paper-100)] focus:ring-[var(--color-ink-400)] shadow-sm",
    accent: "btn-depth-primary focus:ring-[var(--color-ink-600)]",
    outline: "border border-[var(--color-ink-900)] text-[var(--color-ink-900)] hover:bg-[var(--color-paper-100)] focus:ring-[var(--color-ink-400)]",
    // The caregiver pages' blue CTA (the dashboard's Nearby Jobs "Apply Now") — founder 2026-09-30: the Jobs page matches the dashboard, not the other way round.
    brand: "bg-primary-600 hover:bg-primary-700 text-white focus:ring-primary-300"
  };

  const sizes = {
    sm: "px-5 py-2 text-sm min-h-[44px]",
    md: "px-6 py-3 text-[15px] min-h-[48px]",
    lg: "px-8 py-3.5 text-base min-h-[52px]"
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
