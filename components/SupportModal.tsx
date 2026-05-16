
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { dbService, authService } from '../services/api';
import { AddToastFunction } from '../types';

interface SupportModalProps {
  onClose: () => void;
  onShowToast: AddToastFunction;
  userType: 'client' | 'caregiver';
}

export const SupportModal: React.FC<SupportModalProps> = ({ onClose, onShowToast, userType }) => {
  const [type, setType] = useState('dispute');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const user = authService.getCurrentUser();
    
    try {
      await dbService.createSupportTicket({
        userId: user?.uid || 'anonymous',
        userName: user?.displayName || 'Anonymous User',
        userType,
        type: type as any,
        subject,
        description
      });
      
      onShowToast("Ticket submitted. A support agent will review it shortly.", 'success');
      onClose();
    } catch (error) {
      onShowToast("Failed to submit ticket. Please try again.", 'error');
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 animate-slide-in">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
          <X size={24} />
        </button>

        <div className="flex items-center gap-3 mb-6">
           <div className="bg-red-100 p-2 rounded-full">
             <AlertCircle className="w-6 h-6 text-red-600" />
           </div>
           <h2 className="text-2xl font-bold text-slate-900">Report an Issue</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
           <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Issue Type</label>
              <select 
                className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-primary-100"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                 <option value="dispute">Dispute / Conflict</option>
                 <option value="refund">Request Refund</option>
                 <option value="safety">Safety Concern</option>
                 <option value="other">Other / General Help</option>
              </select>
           </div>
           
           <Input 
             label="Subject" 
             placeholder="e.g. Caregiver didn't show up" 
             required
             value={subject}
             onChange={(e) => setSubject(e.target.value)}
           />
           
           <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
              <textarea 
                 className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-100 min-h-[100px] resize-none"
                 placeholder="Please describe the issue in detail..."
                 required
                 value={description}
                 onChange={(e) => setDescription(e.target.value)}
              />
           </div>

           <Button fullWidth type="submit" disabled={loading} className="bg-slate-900 text-white hover:bg-slate-800">
             {loading ? 'Submitting...' : 'Submit Ticket'}
           </Button>
        </form>
      </div>
    </div>
  , document.body);
};
