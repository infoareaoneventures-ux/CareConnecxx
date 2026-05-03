import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bell, MessageSquare } from 'lucide-react';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import { CaregiverUserMenu } from './CaregiverUserMenu';
import type { Caregiver } from '../../types';

const NAV_LINKS = [
  { label: 'Dashboard', path: '/caregiver/dashboard' },
  { label: 'Calendar', path: '/caregiver/calendar' },
  { label: 'Profile', path: '/caregiver/profile' },
  { label: 'Job Board', path: '/caregiver/jobs' },
  { label: 'Bookings', path: '/caregiver/bookings' },
];

export const CaregiverTopNav: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser } = useCareConnex();
  const [profile, setProfile] = useState<Caregiver | null>(null);

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

  const isActive = (path: string) => {
    if (path === '/caregiver/dashboard') {
      return location.pathname === '/caregiver/dashboard' || location.pathname === '/caregiver';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <header className="hidden md:block sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/caregiver/dashboard" className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
            C
          </div>
          <span className="font-bold text-slate-900 tracking-tight">CareConnex</span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV_LINKS.map(link => (
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
    </header>
  );
};
