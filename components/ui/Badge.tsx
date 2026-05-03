import React from 'react';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'success' | 'warning' | 'info' | 'neutral' | 'secondary' | 'danger';
  className?: string;
}

/**
 * Accessible Badge component with WCAG AA compliant colors
 * 
 * @example
 * <Badge variant="success">Verified</Badge>
 */
export const Badge: React.FC<BadgeProps> = ({ children, variant = 'neutral', className = '' }) => {
  const baseStyles = "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium";
  
  // WCAG AA compliant color combinations using CSS variables
  const variants = {
    success: "bg-[var(--color-success-100)] text-[var(--color-success-800)] border border-[var(--color-success-100)]",
    warning: "bg-[var(--color-warning-100)] text-[var(--color-warning-700)] border border-[var(--color-warning-100)]",
    info: "bg-[var(--color-primary-100)] text-[var(--color-primary-800)] border border-[var(--color-primary-200)]",
    neutral: "bg-[var(--color-neutral-100)] text-[var(--color-neutral-800)] border border-[var(--color-neutral-200)]",
    secondary: "bg-slate-100 text-slate-700 border border-slate-200",
    danger: "bg-red-100 text-red-700 border border-red-200"
  };

  return (
    <span 
      className={`${baseStyles} ${variants[variant]} ${className}`}
      role="status"
    >
      {children}
    </span>
  );
};