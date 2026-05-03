import React from 'react';
import { CaregiverTopNav } from './CaregiverTopNav';
import { useCareConnex } from '../../context/CareConnexContext';
import { CaregiverPayments } from './CaregiverPayments';

export const CaregiverTransactionsPage: React.FC = () => {
  const { currentUser } = useCareConnex();

  if (!currentUser) return null;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <CaregiverTopNav />
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-6">
        <CaregiverPayments
          caregiverId={currentUser.uid}
          caregiverName={currentUser.displayName || currentUser.email?.split('@')[0] || 'Caregiver'}
        />
      </div>
    </div>
  );
};
