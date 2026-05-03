
import React from 'react';
import { XCircle, Search } from 'lucide-react';
import { Button } from './ui/Button';
import { ViewType } from '../types';

interface PaymentCancelProps {
  onNavigate: (view: ViewType) => void;
}

export const PaymentCancel: React.FC<PaymentCancelProps> = ({ onNavigate }) => {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-3xl shadow-xl max-w-sm w-full text-center animate-slide-in">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <XCircle className="w-8 h-8 text-red-500" />
        </div>

        <h1 className="text-2xl font-bold text-slate-900 mb-2">Payment Canceled</h1>
        <p className="text-slate-500 mb-8">
          The transaction was not completed. No charges were made to your account.
        </p>

        <Button 
          fullWidth 
          variant="secondary"
          onClick={() => onNavigate('client')}
        >
          <Search className="w-4 h-4 mr-2" />
          Return to Search
        </Button>
      </div>
    </div>
  );
};
