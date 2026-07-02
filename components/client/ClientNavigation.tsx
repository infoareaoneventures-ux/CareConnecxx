import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search, Calendar, MessageSquare, Heart,
  ChevronDown, LogOut, Settings, CreditCard, Crown,
  Users, FileText, CalendarCheck,
  Briefcase, X, MoreHorizontal, HelpCircle, Mail,
  MessageCircle,
} from 'lucide-react';
import { NotificationDropdown } from '../ui/NotificationDropdown';

const FIND_CARE_ROUTES = ['/client/find-caregivers', '/client/browse-caregivers', '/client/posts', '/client/post-job'];
import { authService, dbService } from '../../services/api';
import { db } from '../../lib/firebase';
import { useCaraUnread } from '../../hooks/useCaraUnread';

const MY_CARE_ROUTES = [
  '/client/care-plan',
  '/client/my-care-team',
  '/client/bookings',
];

const ACCOUNT_ROUTES = ['/client/account', '/client/payments', '/client/membership'];

export const ClientNavigation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const [avatarOpen, setAvatarOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [currentUser, setCurrentUser] = React.useState<any>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = React.useState<string | null>(null);
  const caraUnread = useCaraUnread();

  const avatarRef = React.useRef<HTMLDivElement>(null);
  const helpRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const user = authService.getCurrentUser();
    setCurrentUser(user);
    // Immediate fallback: Firebase Auth photoURL (set by AccountSettings upload)
    if ((user as any)?.photoURL) setProfilePhotoUrl((user as any).photoURL);
    if (user?.uid) {
      // Also check users doc and senior_profiles for photo
      Promise.all([
        db?.collection('users').doc(user.uid).get().catch(() => null),
        dbService.getSeniorProfile(user.uid).catch(() => null),
      ]).then(([userDoc, profile]) => {
        const url = userDoc?.data()?.photoURL || profile?.imageUrl || (user as any)?.photoURL;
        if (url) setProfilePhotoUrl(url);
      }).catch(() => {});
    }
  }, []);

  // Close dropdowns on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (avatarRef.current && !avatarRef.current.contains(t)) setAvatarOpen(false);
      if (helpRef.current && !helpRef.current.contains(t)) setHelpOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, []);

  const isActive = (path: string) => location.pathname === path;
  const isFindCareActive = FIND_CARE_ROUTES.some(r => location.pathname.startsWith(r));
  const isMyCareActive = MY_CARE_ROUTES.some(r => location.pathname.startsWith(r));
  const isAccountActive = ACCOUNT_ROUTES.some(r => location.pathname === r);

  // Tomo-style flat tab: pill highlight on the active family
  const tabBtn = (active: boolean) =>
    `relative flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
      active ? 'text-primary-700 bg-primary-50' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
    }`;

  const handleLogout = async () => {
    try { await authService.logout(); } catch {}
    navigate('/');
  };

  const go = (path: string) => {
    navigate(path);
    setAvatarOpen(false);
  };

  // Flat centered tabs — each navigates to its family's primary page; the
  // family's sub-pages stay reachable from the dashboard hub and More drawer.
  const DESKTOP_TABS: Array<{ label: string; icon: React.ReactNode; path: string; routes: string[]; badge?: number }> = [
    { label: 'Chat', icon: <MessageCircle className="w-4 h-4" />, path: '/client/chat', routes: ['/client/chat'], badge: caraUnread },
    { label: 'Find Care', icon: <Search className="w-4 h-4" />, path: '/client/find-caregivers', routes: FIND_CARE_ROUTES },
    { label: 'My Care', icon: <Heart className="w-4 h-4" />, path: '/client/care-plan', routes: MY_CARE_ROUTES },
    { label: 'Calendar', icon: <Calendar className="w-4 h-4" />, path: '/client/calendar', routes: ['/client/calendar'] },
  ];

  const displayName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Account';
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <div className="flex items-center cursor-pointer flex-shrink-0" onClick={() => navigate('/client/dashboard')}>
            <div className="w-8 h-8 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center mr-2">
              <Heart className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold text-gray-900">Care<span className="text-primary-600">Connex</span></span>
          </div>

          {/* Desktop nav — flat centered tabs (tomo-style) */}
          <div className="hidden md:flex flex-1 items-center justify-center gap-1">
            {DESKTOP_TABS.map(tab => (
              <button
                key={tab.path}
                onClick={() => navigate(tab.path)}
                className={tabBtn(tab.routes.some(r => location.pathname.startsWith(r)))}
              >
                {tab.icon}<span>{tab.label}</span>
                {(tab.badge ?? 0) > 0 && (
                  <span className="ml-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {tab.badge! > 9 ? '9+' : tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Right side: Messages + Bell + Avatar grouped together */}
          <div className="hidden md:flex items-center gap-1 ml-4">
            <button onClick={() => navigate('/client/inbox')} className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${isActive('/client/inbox') ? 'text-primary-600 bg-primary-50' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'}`}>
              <MessageSquare className="w-5 h-5" />
            </button>
            <NotificationDropdown />

            {/* Help */}
            <div className="relative" ref={helpRef}>
              <button onClick={() => setHelpOpen(o => !o)} aria-label="Help"
                className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${helpOpen ? 'text-primary-600 bg-primary-50' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'}`}>
                <HelpCircle className="w-5 h-5" />
              </button>
              {helpOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-200 p-4 z-50">
                  <p className="text-xs font-semibold text-slate-700 mb-3">Need Help?</p>
                  <a href="mailto:support@careconnex.com"
                    className="flex items-center gap-2 text-xs text-slate-600 hover:text-primary-600 mb-3">
                    <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    support@careconnex.com
                  </a>
                  <button
                    onClick={async () => {
                      setHelpOpen(false);
                      const user = authService.getCurrentUser();
                      if (!user) { navigate('/client/inbox'); return; }
                      try {
                        const { chatService } = await import('../../services/chatService');
                        const roomId = await chatService.createOrGetSupportRoom(user.uid, user.displayName || user.email?.split('@')[0] || 'Client');
                        navigate(`/client/inbox?room=${roomId}`);
                      } catch { navigate('/client/inbox'); }
                    }}
                    className="w-full flex items-center justify-center gap-1.5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-lg transition-colors">
                    <MessageSquare className="w-3.5 h-3.5" />Chat with Us
                  </button>
                </div>
              )}
            </div>

          {/* Avatar dropdown */}
          <div className="relative" ref={avatarRef}>
            <button
              onClick={() => setAvatarOpen(o => !o)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                isAccountActive || avatarOpen ? 'text-primary-600 bg-primary-50' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white text-sm font-bold">
                {profilePhotoUrl
                  ? <img src={profilePhotoUrl} alt="Profile" className="w-full h-full object-cover" />
                  : initials
                }
              </div>
              <ChevronDown className={`w-3.5 h-3.5 text-gray-500 transition-transform ${avatarOpen ? 'rotate-180' : ''}`} />
            </button>

            {avatarOpen && (
              <div className="absolute right-0 mt-2 w-52 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50">
                {[
                  { icon: <CreditCard className="w-4 h-4" />, label: 'Payments', path: '/client/payments' },
                  { icon: <Crown className="w-4 h-4" />, label: 'Membership', path: '/client/membership' },
                  { icon: <Settings className="w-4 h-4" />, label: 'Account Settings', path: '/client/account' },
                ].map(item => (
                  <button key={item.path} onClick={() => go(item.path)}
                    className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                      isActive(item.path) ? 'text-primary-600 bg-primary-50' : 'text-gray-700 hover:bg-gray-50'
                    }`}>
                    {item.icon}<span>{item.label}</span>
                  </button>
                ))}
                <div className="border-t border-gray-100 mt-1">
                  <button onClick={handleLogout}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                    <LogOut className="w-4 h-4" /><span>Sign Out</span>
                  </button>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white safe-area-pb">
        <div className="flex justify-around py-1">
          {([
            { icon: <MessageCircle className="w-5 h-5" />, label: 'Chat', path: '/client/chat', exact: false, badge: caraUnread },
            { icon: <Search className="w-5 h-5" />, label: 'Find Care', path: '/client/find-caregivers', exact: false },
            { icon: <Heart className="w-5 h-5" />, label: 'My Care', path: '/client/care-plan', exact: false },
            { icon: <Calendar className="w-5 h-5" />, label: 'Calendar', path: '/client/calendar', exact: false },
          ] as Array<{ icon: React.ReactNode; label: string; path: string; exact: boolean; badge?: number }>).map(item => (
            <button key={item.path} onClick={() => { setMoreOpen(false); navigate(item.path); }}
              className={`relative flex flex-col items-center gap-0.5 px-3 py-2 text-xs font-medium transition-colors ${
                (item.exact ? location.pathname === item.path : location.pathname.startsWith(item.path))
                  ? 'text-primary-600'
                  : 'text-gray-500'
              }`}>
              {item.icon}
              <span>{item.label}</span>
              {(item.badge ?? 0) > 0 && (
                <span className="absolute top-1 right-2 min-w-[16px] h-[16px] px-0.5 rounded-full bg-primary-600 text-white text-[9px] font-bold flex items-center justify-center">
                  {item.badge! > 9 ? '9+' : item.badge}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => setMoreOpen(o => !o)}
            className={`flex flex-col items-center gap-0.5 px-3 py-2 text-xs font-medium transition-colors ${
              moreOpen || isActive('/client/posts') || isMyCareActive || isAccountActive
                ? 'text-primary-600'
                : 'text-gray-500'
            }`}>
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
              <div className="w-10 h-1 rounded-full bg-gray-300" />
            </div>
            <div className="flex items-center justify-between px-4 pb-2 pt-1">
              <span className="text-base font-semibold text-gray-900">Menu</span>
              <button onClick={() => setMoreOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100">
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            {/* Care Requests CTA */}
            <div className="px-4 pb-3">
              <button
                onClick={() => { setMoreOpen(false); navigate('/client/posts'); }}
                className="w-full flex items-center justify-center gap-2 bg-primary-600 text-white text-sm font-semibold py-3 rounded-xl shadow-sm"
              >
                <Briefcase className="w-4 h-4" />
                Care Requests
              </button>
            </div>

            <div className="border-t border-gray-100 mx-4" />


            {/* My Care section */}
            <div className="px-4 pt-1 pb-1">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-3 py-1.5">My Care</p>
              {[
                { icon: <MessageSquare className="w-4 h-4" />, label: 'Messages', path: '/client/inbox' },
                { icon: <FileText className="w-4 h-4" />, label: 'Care Plan', path: '/client/care-plan' },
                { icon: <Users className="w-4 h-4" />, label: 'Care Team', path: '/client/my-care-team' },
                { icon: <CalendarCheck className="w-4 h-4" />, label: 'Bookings', path: '/client/bookings' },
              ].map(item => (
                <button key={item.path}
                  onClick={() => { setMoreOpen(false); navigate(item.path); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    isActive(item.path) ? 'text-primary-600 bg-primary-50' : 'text-gray-700 hover:bg-gray-50'
                  }`}>
                  {item.icon}<span>{item.label}</span>
                </button>
              ))}
            </div>

            <div className="border-t border-gray-100 mx-4 mt-1" />

            {/* Account section */}
            <div className="px-4 pt-2 pb-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-3 py-1.5">Account</p>
              {[
                { icon: <Settings className="w-4 h-4" />, label: 'Account Settings', path: '/client/account' },
                { icon: <CreditCard className="w-4 h-4" />, label: 'Payments', path: '/client/payments' },
                { icon: <Crown className="w-4 h-4" />, label: 'Membership', path: '/client/membership' },
                { icon: <HelpCircle className="w-4 h-4" />, label: 'Help & Support', path: 'mailto:support@careconnex.com' },
              ].map(item => (
                <button key={item.path}
                  onClick={() => { setMoreOpen(false); item.path.startsWith('mailto:') ? (window.location.href = item.path) : navigate(item.path); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    isActive(item.path) ? 'text-primary-600 bg-primary-50' : 'text-gray-700 hover:bg-gray-50'
                  }`}>
                  {item.icon}<span>{item.label}</span>
                </button>
              ))}
            </div>

            <div className="border-t border-gray-100 mx-4" />

            <div className="px-4 pt-2 pb-6">
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
    </nav>
  );
};
