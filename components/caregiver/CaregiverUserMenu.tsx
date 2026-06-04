import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { User, Settings, Wallet, BookOpen, MessageCircle, LogOut, ChevronDown } from 'lucide-react';
import { authService } from '../../services/api';
import { useCareConnex } from '../../context/CareConnexContext';
import type { Caregiver } from '../../types';

interface CaregiverUserMenuProps {
  profile?: Caregiver | null;
}

export const CaregiverUserMenu: React.FC<CaregiverUserMenuProps> = ({ profile }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const ACCOUNT_PATHS = ['/caregiver/profile', '/caregiver/settings', '/caregiver/payments'];
  const isAccountActive = ACCOUNT_PATHS.some(p => location.pathname.startsWith(p));
  const { currentUser, addToast } = useCareConnex();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const handleLogout = async () => {
    setOpen(false);
    try {
      await authService.logout();
      addToast('Signed out', 'info');
      navigate('/');
    } catch (e) {
      addToast('Sign out failed', 'error');
    }
  };

  const scrollToSuccessGuide = () => {
    setOpen(false);
    navigate('/caregiver/dashboard');
    requestAnimationFrame(() => {
      const el = document.getElementById('success-guide');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const initials = (profile?.name || currentUser?.displayName || 'C')
    .split(' ')
    .map(s => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const avatar = profile?.photo || profile?.imageUrl || (currentUser as any)?.photoURL;

  const items: Array<{ label: string; onClick: () => void; icon: React.ReactNode; divider?: boolean }> = [
    { label: 'Profile', onClick: () => go('/caregiver/profile'), icon: <User className="w-4 h-4" /> },
    { label: 'Payments', onClick: () => go('/caregiver/payments'), icon: <Wallet className="w-4 h-4" /> },
    { label: 'Settings', onClick: () => go('/caregiver/settings'), icon: <Settings className="w-4 h-4" />, divider: true },
    { label: 'Success guide', onClick: scrollToSuccessGuide, icon: <BookOpen className="w-4 h-4" /> },
    { label: 'Give feedback', onClick: () => { window.location.href = 'mailto:support@careconnex.app?subject=Caregiver%20feedback'; setOpen(false); }, icon: <MessageCircle className="w-4 h-4" />, divider: true },
  ];

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 px-1.5 py-1 rounded-lg transition-colors ${isAccountActive || open ? 'bg-primary-50' : 'hover:bg-slate-100'}`}
      >
        <div className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-transparent hover:ring-primary-200 flex items-center justify-center bg-primary-100 text-primary-700 font-semibold">
          {avatar ? (
            <img src={avatar} alt="Profile" className="w-full h-full object-cover" />
          ) : (
            <span className="text-sm">{initials}</span>
          )}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-64 bg-white rounded-2xl shadow-2xl border border-slate-200 py-2 z-50 animate-fade-in"
        >
          {items.map((item) => (
            <React.Fragment key={item.label}>
              <button
                role="menuitem"
                onClick={item.onClick}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 text-left"
              >
                <span className="text-slate-500">{item.icon}</span>
                <span className="font-medium">{item.label}</span>
              </button>
              {item.divider && <div className="border-t border-slate-100 my-1" />}
            </React.Fragment>
          ))}
          <button
            role="menuitem"
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-primary-600 hover:bg-primary-50 font-semibold text-left"
          >
            <LogOut className="w-4 h-4" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
};
