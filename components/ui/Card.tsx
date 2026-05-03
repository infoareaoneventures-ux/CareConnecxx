import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export const Card: React.FC<CardProps> = ({ children, className = '', onClick }) => {
  return (
    <div className={`bg-white rounded-2xl shadow-lg border border-slate-100 ${className}`} onClick={onClick}>
      {children}
    </div>
  );
};

export default Card;
