import React, { useState } from 'react';
import { Activity } from 'lucide-react';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { ViewType, AddToastFunction } from '../types';
import { authService, dbService } from '../services/api';
import { Footer } from './landing/Footer';
import { SEO } from './SEO';

interface CaregiverLoginProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

export const CaregiverLogin: React.FC<CaregiverLoginProps> = ({ onNavigate, onShowToast }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [lastAttempt, setLastAttempt] = useState(0);
  const RATE_LIMIT_MS = 2000;

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    try {
      const { actualUserType } = await authService.signInWithGoogle('caregiver');
      if (actualUserType === 'client') {
        onShowToast("Redirecting to Family Dashboard...", 'info');
        onNavigate('client');
      } else {
        onShowToast("Welcome back! Dashboard updated.", 'success');
        onNavigate('caregiver');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Google sign-in failed";
      onShowToast(message, 'error');
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastAttempt < RATE_LIMIT_MS) {
      onShowToast('Please wait before trying again', 'error');
      return;
    }
    setLastAttempt(now);
    setIsLoading(true);
    
    try {
      const user = await authService.login(email, password, 'caregiver');
      if (user && 'uid' in user && user.uid) {
          const userDoc = await dbService.getUser(user.uid);
          if (userDoc && userDoc.userType === 'client') {
              await authService.logout();
              onShowToast("This account is registered as a family. Please use the Family login.", 'error');
          } else {
              onShowToast("Welcome back! Dashboard updated.", 'success');
              onNavigate('caregiver');
          }
      } else {
          onNavigate('caregiver');
      }
    } catch (error: unknown) {
        console.error(error);
        let message = error instanceof Error ? error.message : "Invalid email or password";
        if (message.includes('Invalid email or password')) {
          message = "Invalid email or password. Try again or click 'Forgot password?' below.";
        }
        onShowToast(message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <SEO title="Caregiver Login | CareConnex" description="Log in to your CareConnex caregiver account." />
      
      {/* Header */}
      <header className="absolute top-0 w-full z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20">
            <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
              <div className="bg-primary-600 p-2 rounded-xl shadow-lg shadow-primary-200/50">
                <Activity className="text-white w-6 h-6" />
              </div>
              <span className="text-2xl font-bold text-slate-900 tracking-tight">CareConnex</span>
            </div>
            <div className="flex items-center gap-4">
               <button onClick={() => onNavigate('help-center')} className="text-slate-600 hover:text-primary-600 font-medium">Help</button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow pt-20 flex flex-col">
        {/* Hero Section with Form Overlap */}
        <div className="relative w-full h-[50vh] min-h-[400px]">
          {/* Background Image */}
          <div className="absolute inset-0">
             <img 
               src="/assets/caregiver-senior-porch.png" 
               alt="Friendly in-home caregiver with senior" 
               className="w-full h-full object-cover"
             />
             <div className="absolute inset-0 bg-slate-900/40"></div>
          </div>

          {/* Form Card Container */}
          <div className="absolute inset-x-0 -bottom-32 flex justify-center px-4">
             <div className="bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row w-full max-w-4xl min-h-[360px]">
                
                {/* Left Side (Welcome & Sign up) */}
                <div className="md:w-5/12 bg-slate-50 p-8 md:p-12 flex flex-col justify-center border-r border-slate-100">
                   <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-6">Welcome Back!</h1>
                   <div className="flex items-center gap-3">
                      <span className="text-slate-600 font-medium">New to CareConnex?</span>
                      <button 
                        onClick={() => onNavigate('caregiver-signup')}
                        className="px-4 py-1.5 border border-slate-300 rounded-full text-sm font-semibold text-slate-700 hover:border-accent-500 hover:text-accent-600 transition-colors"
                      >
                        Sign up
                      </button>
                   </div>
                </div>

                {/* Right Side (Form) */}
                <div className="md:w-7/12 p-8 md:p-12 bg-white">
                   <div className="space-y-5 max-w-sm mx-auto md:mx-0 md:ml-auto">
                      <button
                        type="button"
                        onClick={handleGoogleSignIn}
                        disabled={isGoogleLoading || isLoading}
                        className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-slate-300 bg-white text-slate-700 font-semibold text-sm hover:bg-slate-50 hover:border-slate-400 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24">
                          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                        </svg>
                        {isGoogleLoading ? "Signing in..." : "Continue with Google"}
                      </button>

                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-px bg-slate-200" />
                        <span className="text-xs text-slate-400 font-medium">or</span>
                        <div className="flex-1 h-px bg-slate-200" />
                      </div>

                      <form onSubmit={handleSubmit} className="space-y-5">
                        <Input
                          label="Email"
                          type="email"
                          placeholder="Email"
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="bg-white focus:ring-accent-500"
                        />
                        <Input
                          label="Password"
                          type="password"
                          placeholder="Password"
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="bg-white focus:ring-accent-500"
                        />
                        <Button fullWidth variant="accent" type="submit" disabled={isLoading || isGoogleLoading} size="lg">
                          {isLoading ? "Logging in..." : "Login with Email"}
                        </Button>
                        <div className="text-right pt-2">
                          <button
                            type="button"
                            onClick={() => onNavigate('forgot-password-caregiver')}
                            className="text-sm font-medium text-accent-600 hover:text-accent-700 transition-colors"
                          >
                            Forgot your password?
                          </button>
                        </div>
                      </form>
                   </div>
                </div>

             </div>
          </div>
        </div>

        {/* Spacer for overlapping card */}
        <div className="h-48 md:h-40 bg-slate-50"></div>
      </main>

      <Footer onNavigate={onNavigate} />
    </div>
  );
};
