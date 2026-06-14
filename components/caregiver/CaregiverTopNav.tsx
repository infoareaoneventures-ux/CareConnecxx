import React, { useState, useRef, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, MessageSquare, Home, Calendar, Briefcase,
  BookOpen, Settings, X, MoreHorizontal, LogOut, User,
  Users, Wallet, ChevronDown, HelpCircle, Mail,
} from 'lucide-react';
import { useCareConnex } from '../../context/CareConnexContext';
import { authService } from '../../services/api';
import { CaregiverUserMenu } from './CaregiverUserMenu';
import type { Caregiver } from '../../types';

const BOOKINGS_ROUTES = ['/caregiver/bookings', '/caregiver/families'];

const AUTH_PATHS = [
  '/caregiver/login',
  '/caregiver/signup',
  '/caregiver/forgot-password',
];

export const CaregiverTopNav: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { caregiverProfile: profile } = useCareConnex();
  const [moreOpen, setMoreOpen] = useState(false);

  const path = location.pathname;

  const isActive = (p: string) => {
    if (p === '/caregiver/dashboard') {
      return path === '/caregiver/dashboard' || path === '/caregiver';
    }
    return path.startsWith(p);
  };

  const handleLogout = async () => {
    try { await authService.logout(); } catch {}
    navigate('/');
  };

  // Don't show mobile bottom nav on auth pages
  if (AUTH_PATHS.includes(path)) {
    return (
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
        <DesktopNav profile={profile} isActive={isActive} navigate={navigate} />
      </header>
    );
  }

  return (
    <>
      {/* Top nav — logo always visible, desktop links hidden on mobile */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
        <DesktopNav profile={profile} isActive={isActive} navigate={navigate} />
      </header>

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-slate-200 bg-white safe-area-pb">
        <div className="flex justify-around py-1">
          {[
            { icon: <Home className="w-5 h-5" />, label: 'Home', path: '/caregiver/dashboard' },
            { icon: <Calendar className="w-5 h-5" />, label: 'Calendar', path: '/caregiver/calendar' },
            { icon: <Briefcase className="w-5 h-5" />, label: 'Jobs', path: '/caregiver/jobs' },
            { icon: <MessageSquare className="w-5 h-5" />, label: 'Chat', path: '/caregiver/inbox' },
          ].map(item => (
            <button
              key={item.path}
              onClick={() => { setMoreOpen(false); navigate(item.path); }}
              className={`flex flex-col items-center gap-0.5 px-3 py-2 text-xs font-medium transition-colors ${
                isActive(item.path) ? 'text-primary-600' : 'text-slate-500'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
          <button
            onClick={() => setMoreOpen(o => !o)}
            className={`flex flex-col items-center gap-0.5 px-3 py-2 text-xs font-medium transition-colors ${
              moreOpen || isActive('/caregiver/bookings') || isActive('/caregiver/profile') || isActive('/caregiver/settings') || isActive('/caregiver/families') || isActive('/caregiver/payments')
                ? 'text-primary-600'
                : 'text-slate-500'
            }`}
          >
            <MoreHorizontal className="w-5 h-5" />
            <span>More</span>
          </button>
        </div>
      </div>

      {/* Mobile More drawer */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-[60]" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </div>
            <div className="flex items-center justify-between px-4 pb-2 pt-1 flex-shrink-0">
              <span className="text-base font-semibold text-slate-900">More</span>
              <button onClick={() => setMoreOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              <div className="px-4 pb-3 space-y-1">
                {[
                  { icon: <BookOpen className="w-4 h-4" />, label: 'Bookings', path: '/caregiver/bookings' },
                  { icon: <User className="w-4 h-4" />, label: 'Profile', path: '/caregiver/profile' },
                  { icon: <Settings className="w-4 h-4" />, label: 'Settings', path: '/caregiver/settings' },
                  { icon: <Users className="w-4 h-4" />, label: 'My Families', path: '/caregiver/families' },
                  { icon: <Wallet className="w-4 h-4" />, label: 'Payments', path: '/caregiver/payments' },
                  { icon: <HelpCircle className="w-4 h-4" />, label: 'Help & Support', path: 'mailto:support@careconnex.com' },
                ].map(item => (
                  <button
                    key={item.path}
                    onClick={() => { setMoreOpen(false); item.path.startsWith('mailto:') ? (window.location.href = item.path) : navigate(item.path); }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                      isActive(item.path) ? 'text-primary-600 bg-primary-50' : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {item.icon}<span>{item.label}</span>
                  </button>
                ))}
              </div>

              <div className="border-t border-slate-100 mx-4" />

              <div className="px-4 pt-2 pb-8">
                <button
                  onClick={async () => { setMoreOpen(false); await handleLogout(); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
                >
                  <LogOut className="w-4 h-4" /><span>Sign Out</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const DesktopNav: React.FC<{
  profile: Caregiver | null;
  isActive: (p: string) => boolean;
  navigate: (path: string) => void;
}> = ({ profile, isActive, navigate }) => {
  const [bookingsOpen, setBookingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const bookingsRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const isBookingsActive = BOOKINGS_ROUTES.some(r => isActive(r));

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('touchstart', handler); };
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (bookingsRef.current && !bookingsRef.current.contains(e.target as Node)) setBookingsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('touchstart', handler); };
  }, []);

  const navBtn = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      active ? 'text-primary-600 bg-primary-50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
    }`;

  return (
    <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
      <Link to="/caregiver/dashboard" className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">C</div>
        <span className="font-bold text-slate-900 tracking-tight">CareConnex</span>
      </Link>

      <nav className="hidden md:flex items-center gap-1">
        {/* Job Board */}
        <Link to="/caregiver/jobs" className={navBtn(isActive('/caregiver/jobs'))}>Job Board</Link>

        {/* Bookings dropdown */}
        <div className="relative" ref={bookingsRef}>
          <button onClick={() => setBookingsOpen(o => !o)} className={navBtn(isBookingsActive || bookingsOpen)}>
            <span>Bookings</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${bookingsOpen ? 'rotate-180' : ''}`} />
          </button>
          {bookingsOpen && (
            <div className="absolute left-0 mt-2 w-48 bg-white rounded-xl shadow-lg border border-slate-200 py-1 z-50">
              {[
                { icon: <BookOpen className="w-4 h-4" />, label: 'My Bookings', path: '/caregiver/bookings' },
                { icon: <Users className="w-4 h-4" />, label: 'My Families', path: '/caregiver/families' },
              ].map(item => (
                <button key={item.path} onClick={() => { navigate(item.path); setBookingsOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                    isActive(item.path) ? 'text-primary-600 bg-primary-50' : 'text-slate-700 hover:bg-slate-50'
                  }`}>
                  {item.icon}<span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Calendar */}
        <Link to="/caregiver/calendar" className={navBtn(isActive('/caregiver/calendar'))}>Calendar</Link>
      </nav>

      {/* Right side: Messages + Bell + Help + Avatar */}
      <div className="hidden md:flex items-center gap-1">
        <button onClick={() => navigate('/caregiver/inbox')} aria-label="Messages"
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${isActive('/caregiver/inbox') ? 'text-primary-600 bg-primary-50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`}>
          <MessageSquare className="w-4 h-4" />
        </button>
        <button aria-label="Notifications"
          className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors">
          <Bell className="w-4 h-4" />
        </button>
        <div className="relative" ref={helpRef}>
          <button onClick={() => setHelpOpen(o => !o)} aria-label="Help"
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${helpOpen ? 'text-primary-600 bg-primary-50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`}>
            <HelpCircle className="w-4 h-4" />
          </button>
          {helpOpen && (
            <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-slate-200 p-4 z-50">
              <p className="text-xs font-semibold text-slate-700 mb-3">Need Help?</p>
              <a href="mailto:support@careconnex.com"
                className="flex items-center gap-2 text-xs text-slate-600 hover:text-primary-600 mb-3">
                <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                support@careconnex.com
              </a>
              <button
                onClick={() => { setHelpOpen(false); navigate('/caregiver/inbox'); }}
                className="w-full flex items-center justify-center gap-1.5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-lg transition-colors">
                <MessageSquare className="w-3.5 h-3.5" />Chat with Us
              </button>
            </div>
          )}
        </div>
        <CaregiverUserMenu profile={profile} />
      </div>
    </div>
  );
};
