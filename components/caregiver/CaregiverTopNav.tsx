import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, MessageSquare, Home, Calendar, Briefcase,
  BookOpen, Settings, X, MoreHorizontal, LogOut, User,
  Users, CreditCard, Receipt,
} from 'lucide-react';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService, authService } from '../../services/api';
import { CaregiverUserMenu } from './CaregiverUserMenu';
import type { Caregiver } from '../../types';

const NAV_LINKS = [
  { label: 'Dashboard', path: '/caregiver/dashboard' },
  { label: 'Calendar', path: '/caregiver/calendar' },
  { label: 'Profile', path: '/caregiver/profile' },
  { label: 'Job Board', path: '/caregiver/jobs' },
  { label: 'Bookings', path: '/caregiver/bookings' },
];

const AUTH_PATHS = [
  '/caregiver/login',
  '/caregiver/signup',
  '/caregiver/forgot-password',
];

export const CaregiverTopNav: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser } = useCareConnex();
  const [profile, setProfile] = useState<Caregiver | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!currentUser?.uid) return;
      try {
        const user = await dbService.getUser(currentUser.uid);
        if (active && user) setProfile(user as any);
      } catch {
        /* non-fatal */
      }
    })();
    return () => { active = false; };
  }, [currentUser?.uid]);

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
      <header className="hidden md:block sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
        <DesktopNav profile={profile} isActive={isActive} navigate={navigate} />
      </header>
    );
  }

  return (
    <>
      {/* Desktop top nav */}
      <header className="hidden md:block sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
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
              moreOpen || isActive('/caregiver/bookings') || isActive('/caregiver/profile') || isActive('/caregiver/settings') || isActive('/caregiver/families') || isActive('/caregiver/payout') || isActive('/caregiver/transactions')
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
        <div className="md:hidden fixed inset-0 z-40" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-xl pb-safe"
            onClick={e => e.stopPropagation()}
          >
            {/* Handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-slate-300" />
            </div>
            <div className="flex items-center justify-between px-4 pb-2 pt-1">
              <span className="text-base font-semibold text-slate-900">More</span>
              <button onClick={() => setMoreOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <div className="px-4 pb-3 space-y-1">
              {[
                { icon: <BookOpen className="w-4 h-4" />, label: 'Bookings', path: '/caregiver/bookings' },
                { icon: <User className="w-4 h-4" />, label: 'Profile', path: '/caregiver/profile' },
                { icon: <Settings className="w-4 h-4" />, label: 'Settings', path: '/caregiver/settings' },
                { icon: <Users className="w-4 h-4" />, label: 'Your families', path: '/caregiver/families' },
                { icon: <CreditCard className="w-4 h-4" />, label: 'Payout and payment', path: '/caregiver/payout' },
                { icon: <Receipt className="w-4 h-4" />, label: 'Transactions', path: '/caregiver/transactions' },
              ].map(item => (
                <button
                  key={item.path}
                  onClick={() => { setMoreOpen(false); navigate(item.path); }}
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
      )}
    </>
  );
};

const DesktopNav: React.FC<{
  profile: Caregiver | null;
  isActive: (p: string) => boolean;
  navigate: (path: string) => void;
}> = ({ profile, isActive, navigate }) => (
  <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
    <Link to="/caregiver/dashboard" className="flex items-center gap-2">
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
        C
      </div>
      <span className="font-bold text-slate-900 tracking-tight">CareConnex</span>
    </Link>

    <nav className="flex items-center gap-1">
      {[
        { label: 'Dashboard', path: '/caregiver/dashboard' },
        { label: 'Calendar', path: '/caregiver/calendar' },
        { label: 'Profile', path: '/caregiver/profile' },
        { label: 'Job Board', path: '/caregiver/jobs' },
        { label: 'Bookings', path: '/caregiver/bookings' },
      ].map(link => (
        <Link
          key={link.path}
          to={link.path}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            isActive(link.path)
              ? 'text-primary-600 bg-primary-50'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
          }`}
        >
          {link.label}
        </Link>
      ))}
    </nav>

    <div className="flex items-center gap-2">
      <button
        onClick={() => navigate('/caregiver/inbox')}
        aria-label="Messages"
        className="w-10 h-10 rounded-full flex items-center justify-center bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
      >
        <MessageSquare className="w-4 h-4" />
      </button>
      <button
        onClick={() => navigate('/caregiver/inbox')}
        aria-label="Notifications"
        className="w-10 h-10 rounded-full flex items-center justify-center bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
      >
        <Bell className="w-4 h-4" />
      </button>
      <CaregiverUserMenu profile={profile} />
    </div>
  </div>
);
