import React, { useState } from 'react';
import { KeyRound, ArrowLeft, Mail } from 'lucide-react';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { ViewType, AddToastFunction } from '../types';
import { authService } from '../services/api';

interface ForgotPasswordProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
  userType: 'client' | 'caregiver';
}

export const ForgotPassword: React.FC<ForgotPasswordProps> = ({ onNavigate, onShowToast, userType }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [email, setEmail] = useState('');

  const isClient = userType === 'client';
  const themeColor = isClient ? 'text-primary-600' : 'text-accent-500';
  const themeBg = isClient ? 'bg-primary-600' : 'bg-accent-500';
  const themeShadow = isClient ? 'shadow-primary-200' : 'shadow-accent-200';
  const hoverText = isClient ? 'hover:text-primary-600' : 'hover:text-accent-600';
  const backTarget: ViewType = isClient ? 'client-login' : 'caregiver-login';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      await authService.sendPasswordResetEmail(email);
      setIsSent(true);
      onShowToast(`Reset link sent to ${email}`, 'success');
    } catch (error: any) {
      console.error('Password reset error:', error);
      const message = error instanceof Error ? error.message : "Failed to send reset email";
      onShowToast(message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center mb-6">
          <div className={`${themeBg} p-3 rounded-xl shadow-lg ${themeShadow}`}>
            <KeyRound className="text-white w-8 h-8" />
          </div>
        </div>
        <h2 className="mt-2 text-center text-3xl font-extrabold text-slate-900">
          Reset Password
        </h2>
        <p className="mt-2 text-center text-sm text-slate-600">
          We'll send you instructions to reset your password.
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-xl rounded-2xl sm:px-10 border border-slate-100 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-5">
            <Mail size={100} className={themeColor} />
          </div>

          {!isSent ? (
            <form className="space-y-4 relative z-10" onSubmit={handleSubmit}>
              <Input 
                label="Email Address" 
                type="email" 
                placeholder={isClient ? "jane@example.com" : "sarah@example.com"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required 
              />

              <div className="pt-2">
                <Button 
                  fullWidth 
                  variant={isClient ? 'primary' : 'accent'} 
                  type="submit" 
                  disabled={isLoading}
                >
                  {isLoading ? "Sending..." : "Send Reset Link"}
                </Button>
              </div>
            </form>
          ) : (
            <div className="text-center py-4 relative z-10">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 mb-4">
                <Mail className="h-6 w-6 text-green-600" />
              </div>
              <h3 className="text-lg leading-6 font-medium text-slate-900">Check your email</h3>
              <p className="mt-2 text-sm text-slate-500">
                We've sent a password reset link to <span className="font-medium text-slate-900">{email}</span>.
              </p>
              <div className="mt-6 space-y-3">
                <Button 
                  fullWidth 
                  variant={isClient ? 'primary' : 'accent'}
                  onClick={() => onNavigate(backTarget)}
                >
                  Back to Login
                </Button>
                <Button 
                  fullWidth 
                  variant="secondary" 
                  onClick={() => setIsSent(false)}
                >
                  Try another email
                </Button>
              </div>
            </div>
          )}

          {!isSent && (
            <div className="mt-6">
               <button 
                 onClick={() => onNavigate(backTarget)} 
                 className={`flex items-center justify-center mx-auto text-slate-400 ${hoverText} transition-colors`}
               >
                 <ArrowLeft className="w-4 h-4 mr-1" /> Back to Login
               </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
