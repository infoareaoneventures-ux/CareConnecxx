
import React, { useState } from 'react';
import { X, Shield, Lock, CheckCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { dbService } from '../services/api';
import { AddToastFunction } from '../types';

interface BackgroundCheckModalProps {
  onClose: () => void;
  onShowToast: AddToastFunction;
  onSuccess?: () => void;
}

export const BackgroundCheckModal: React.FC<BackgroundCheckModalProps> = ({ onClose, onShowToast, onSuccess }) => {
  const [formData, setFormData] = useState({
    legalFirstName: '',
    legalLastName: '',
    zipCode: '',
    state: '',
    consentGiven: false,
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.consentGiven) {
      onShowToast('Please authorize the background check to continue.', 'error');
      return;
    }
    setLoading(true);

    try {
      await dbService.initiateBackgroundCheck({
        legalFirstName: formData.legalFirstName.trim(),
        legalLastName: formData.legalLastName.trim(),
        zipCode: formData.zipCode.trim(),
        state: formData.state.trim(),
        consentGiven: true,
      });

      setSuccess(true);
      if (onSuccess) onSuccess();

      setTimeout(() => {
        onClose();
      }, 3500);
    } catch (error) {
      console.error(error);
      onShowToast("Verification request failed. Please check your internet.", 'error');
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />
        <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-8 animate-slide-in text-center">
           <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
             <CheckCircle className="w-10 h-10 text-green-600" />
           </div>
           <h2 className="text-2xl font-bold text-slate-900 mb-2">Check Your Email</h2>
           <p className="text-slate-500">
             Checkr just emailed you a secure link to complete verification. Reports typically come back within 24-48 hours once you finish.
           </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden animate-slide-in">
        <div className="bg-slate-900 p-6 text-white text-center relative">
           <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-white">
             <X size={24} />
           </button>
           <div className="flex justify-center mb-4">
              <Shield className="w-10 h-10 text-green-400" />
           </div>
           <h2 className="text-xl font-bold">Identity Verification</h2>
           <p className="text-sm text-slate-400 mt-1">Powered by Checkr • 256-bit SSL Encrypted</p>
        </div>

        <div className="p-6">
           <div className="bg-blue-50 border border-blue-100 p-3 rounded-xl flex items-start gap-3 mb-6">
              <Lock className="w-5 h-5 text-blue-500 mt-0.5" />
              <p className="text-xs text-blue-700 leading-relaxed">
                 We'll send your name, email, and ZIP to Checkr. Checkr will then email you a secure link to enter your SSN and date of birth on their site — <strong>your SSN never touches CareConnecxx</strong>.
              </p>
           </div>

           <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                 <Input
                   label="Legal First Name"
                   required
                   value={formData.legalFirstName}
                   onChange={(e) => setFormData({...formData, legalFirstName: e.target.value})}
                 />
                 <Input
                   label="Legal Last Name"
                   required
                   value={formData.legalLastName}
                   onChange={(e) => setFormData({...formData, legalLastName: e.target.value})}
                 />
              </div>

              <div className="grid grid-cols-2 gap-4">
                 <Input
                   label="Current Zip Code"
                   required
                   value={formData.zipCode}
                   onChange={(e) => setFormData({...formData, zipCode: e.target.value})}
                 />
                 <div>
                   <label className="block text-sm font-medium text-slate-700 mb-1">State <span className="text-red-500">*</span></label>
                   <select
                     required
                     value={formData.state}
                     onChange={(e) => setFormData({...formData, state: e.target.value})}
                     className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none bg-white"
                   >
                     <option value="">Select state</option>
                     {["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"].map(s => (
                       <option key={s} value={s}>{s}</option>
                     ))}
                   </select>
                 </div>
              </div>

              <label className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer">
                 <input
                   type="checkbox"
                   className="mt-1 h-4 w-4 text-green-600 rounded border-slate-300 focus:ring-green-500"
                   checked={formData.consentGiven}
                   onChange={(e) => setFormData({...formData, consentGiven: e.target.checked})}
                 />
                 <span className="text-xs text-slate-600 leading-relaxed">
                   I authorize CareConnecxx and Checkr to run a background check using the information I provide, and I agree to Checkr's Terms of Service.
                 </span>
              </label>

              <div className="pt-2">
                 <Button
                   fullWidth
                   type="submit"
                   disabled={loading || !formData.consentGiven || !formData.state}
                   className="bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
                 >
                    {loading ? 'Submitting securely...' : 'Submit for Verification'}
                 </Button>
              </div>
           </form>
        </div>
      </div>
    </div>
  );
};
