import React from 'react';
import { CreditCard } from 'lucide-react';

interface CreditCardBadgeProps {
  show: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export const CreditCardBadge: React.FC<CreditCardBadgeProps> = ({ show, size = 'sm', className = '' }) => {
  if (!show) return null;
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm';
  const icon = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 font-medium ${padding} ${className}`}
      title="Accepts credit cards"
    >
      <CreditCard className={icon} />
      Accepts credit cards
    </span>
  );
};
