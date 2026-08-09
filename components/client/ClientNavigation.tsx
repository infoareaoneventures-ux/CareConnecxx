import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search, Calendar, MessageSquare, Heart,
  ChevronDown, LogOut, Settings, CreditCard, Crown,
  Users, FileText, CalendarCheck,
  Briefcase, X, MoreHorizontal, HelpCircle, Mail,
} from 'lucide-react';
import { NotificationDropdown } from '../ui/NotificationDropdown';
import { BloomMark } from '../ui/BloomMark';

const FIND_CARE_ROUTES = ['/client/find-caregivers', '/client/browse-caregivers', '/client/posts', '/client/post-job'];
import { authService, dbService } from '../../services/api';
import { db } from '../../lib/firebase';

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
  const [findCareOpen, setFindCareOpen] = React.useState(false);
  const [mobileFindCareOpen, setMobileFindCareOpen] = React.useState(false);
  const [myCareOpen, setMyCareOpen] = React.useState(false);
  const [currentUser, setCurrentUser] = React.useState<any>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = React.useState<string | null>(null);

  const avatarRef = React.useRef<HTMLDivElement>(null);
  const helpRef = React.useRef<HTMLDivElement>(null);
  const findCareRef = React.useRef<HTMLDivElement>(null);
  const myCareRef = React.useRef<HTMLDivElement>(null);

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
      if (findCareRef.current && !findCareRef.current.contains(t)) setFindCareOpen(false);
      if (myCareRef.current && !myCareRef.current.contains(t)) setMyCareOpen(false);
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
    `relative flex items-center gap-1.5 px-4 py-2 rounded-full text-sm transition-colors ${
      active ? 'text-ink-900 font-semibold bg-paper-100' : 'font-medium text-ink-600 hover:text-ink-900 hover:bg-paper-100'
    }`;

  const handleLogout = async () => {
    try { await authService.logout(); } catch {}
    navigate('/');
  };

  const go = (path: string) => {
    navigate(path);
    setAvatarOpen(false);
  };

  const displayName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Account';
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <nav className="bg-paper-50 border-b hairline sticky top-0 z-50 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">

          {/* Logo */}
          <div className="flex items-center cursor-pointer flex-shrink-0" onClick={() => navigate('/client/dashboard')}>
            <div className="w-8 h-8 bg-ink-900 rounded-lg flex items-center justify-center mr-2">
              <BloomMark className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-display font-bold text-ink-900">Evia</span>
          </div>

          {/* Desktop nav */}
          <div className="hidden md:flex flex-1 items-center justify-center gap-1">
            {/* Find Care — dropdown */}
            <div className="relative" ref={findCareRef}>
              <button onClick={() => setFindCareOpen(o => !o)} className={tabBtn(isFindCareActive)}>
                <Search className="w-4 h-4" /><span>Find Care</span><ChevronDown className="w-3 h-3 ml-0.5" />
              </button>
              {findCareOpen && (
                <div className="absolute top-full left-0 mt-1 w-48 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50">
                  {[
                    { icon: <Search className="w-4 h-4" />, label: 'Browse Caregivers', path: '/client/find-caregivers' },
                    { icon: <Briefcase className="w-4 h-4" />, label: 'Care Requests', path: '/client/posts' },
                  ].map(item => (
                    <button key={item.path} onClick={() => { navigate(item.path); setFindCareOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${location.pathname.startsWith(item.path) ? 'text-primary-600 bg-primary-50' : 'text-gray-700 hover:bg-gray-50'}`}>
                      {item.icon}<span>{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* My Care — dropdown */}
            <div className="relative" ref={myCareRef}>
              <button onClick={() => setMyCareOpen(o => !o)} className={tabBtn(isMyCareActive)}>
                <Heart className="w-4 h-4" /><span>My Care</span><ChevronDown className="w-3 h-3 ml-0.5" />
              </button>
              {myCareOpen && (
                <div className="absolute top-full left-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50">
                  {[
                    { icon: <FileText className="w-4 h-4" />, label: 'Care Plan', path: '/client/care-plan' },
                    { icon: <Users className="w-4 h-4" />, label: 'Care Team', path: '/client/my-care-team' },
                    { icon: <CalendarCheck className="w-4 h-4" />, label: 'Bookings', path: '/client/bookings' },
                  ].map(item => (
                    <button key={item.path} onClick={() => { navigate(item.path); setMyCareOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${location.pathname.startsWith(item.path) ? 'text-primary-600 bg-primary-50' : 'text-gray-700 hover:bg-gray-50'}`}>
                      {item.icon}<span>{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Calendar */}
            <button onClick={() => navigate('/client/calendar')} className={tabBtn(location.pathname.startsWith('/client/calendar'))}>
              <Calendar className="w-4 h-4" /><span>Calendar</span>
            </button>
          </div>

          {/* Right side: Messages + Bell + Avatar grouped together */}
          <div className="hidden md:flex items-center gap-1 ml-4">
            <button onClick={() => navigate('/client/inbox')} className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${isActive('/client/inbox') ? 'text-ink-900 bg-paper-100' : 'text-ink-600 hover:text-ink-900 hover:bg-paper-100'}`}>
              <MessageSquare className="w-5 h-5" />
            </button>
            <NotificationDropdown role="client" />

            {/* Help */}
            <div className="relative" ref={helpRef}>
              <button onClick={() => setHelpOpen(o => !o)} aria-label="Help"
                className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${helpOpen ? 'text-ink-900 bg-paper-100' : 'text-ink-600 hover:text-ink-900 hover:bg-paper-100'}`}>
                <HelpCircle className="w-5 h-5" />
              </button>
              {helpOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-gray-200 p-4 z-50">
                  <p className="text-xs font-semibold text-slate-700 mb-3">Need Help?</p>
                  <a href="mailto:support@eviacares.com"
                    className="flex items-center gap-2 text-xs text-slate-600 hover:text-primary-600 mb-3">
                    <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    support@eviacares.com
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
                isAccountActive || avatarOpen ? 'text-ink-900 bg-paper-100' : 'text-ink-600 hover:bg-paper-100'
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

      {/* Mobile Find Care mini-sheet — only when More drawer is closed */}
      {mobileFindCareOpen && !moreOpen && (
        <div className="md:hidden fixed inset-0 z-50" onClick={() => setMobileFindCareOpen(false)}>
          <div className="absolute inset-0 bg-black/20" />
          <div className="absolute bottom-[57px] left-4 right-4 bg-white rounded-2xl shadow-xl overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <button
              onClick={() => { setMobileFindCareOpen(false); navigate('/client/find-caregivers'); }}
              className="w-full flex items-center gap-3 px-4 py-4 text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors border-b border-gray-100"
            >
              <Search className="w-4 h-4 text-primary-600" /><span>Browse Caregivers</span>
            </button>
            <button
              onClick={() => { setMobileFindCareOpen(false); navigate('/client/posts'); }}
              className="w-full flex items-center gap-3 px-4 py-4 text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors"
            >
              <Briefcase className="w-4 h-4 text-primary-600" /><span>Care Requests</span>
            </button>
          </div>
        </div>
      )}

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t hairline bg-paper-50 safe-area-pb">
        <div className="flex justify-around py-1">
          {/* Find Care — opens mini-sheet */}
          <button
            onClick={() => { setMoreOpen(false); setMobileFindCareOpen(o => !o); }}
            className={`relative flex flex-col items-center gap-0.5 px-3 py-2 text-xs transition-colors ${
              isFindCareActive || mobileFindCareOpen ? 'text-ink-900 font-semibold' : 'text-ink-600 font-medium'
            }`}>
            <Search className="w-5 h-5" />
            <span>Find Care</span>
          </button>
          {([
            { icon: <Heart className="w-5 h-5" />, label: 'My Care', path: '/client/care-plan', exact: false },
            { icon: <Calendar className="w-5 h-5" />, label: 'Calendar', path: '/client/calendar', exact: false },
          ] as Array<{ icon: React.ReactNode; label: string; path: string; exact: boolean; badge?: number }>).map(item => (
            <button key={item.path} onClick={() => { setMoreOpen(false); setMobileFindCareOpen(false); navigate(item.path); }}
              className={`relative flex flex-col items-center gap-0.5 px-3 py-2 text-xs transition-colors ${
                (item.exact ? location.pathname === item.path : location.pathname.startsWith(item.path))
                  ? 'text-ink-900 font-semibold'
                  : 'text-ink-600 font-medium'
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
            className={`flex flex-col items-center gap-0.5 px-3 py-2 text-xs transition-colors ${
              moreOpen || isActive('/client/posts') || isMyCareActive || isAccountActive
                ? 'text-ink-900 font-semibold'
                : 'text-ink-600 font-medium'
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
            className="absolute bottom-[57px] left-0 right-0 bg-white rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Handle + header — fixed */}
            <div className="flex-shrink-0">
              <div className="flex justify-center pt-3 pb-1">
                <div className="w-10 h-1 rounded-full bg-gray-300" />
              </div>
              <div className="flex items-center justify-between px-4 pb-2 pt-1">
                <span className="text-base font-semibold text-gray-900">Menu</span>
                <button onClick={() => setMoreOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100">
                  <X className="w-4 h-4 text-gray-500" />
                </button>
              </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto">
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
              <div className="px-4 pt-2 pb-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-3 py-1.5">Account</p>
                {[
                  { icon: <Settings className="w-4 h-4" />, label: 'Account Settings', path: '/client/account' },
                  { icon: <CreditCard className="w-4 h-4" />, label: 'Payments', path: '/client/payments' },
                  { icon: <Crown className="w-4 h-4" />, label: 'Membership', path: '/client/membership' },
                  { icon: <HelpCircle className="w-4 h-4" />, label: 'Help & Support', path: 'mailto:support@eviacares.com' },
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
            </div>

            {/* Sign Out — sticky footer, always visible */}
            <div className="flex-shrink-0 border-t border-gray-100 px-4 pt-2 pb-safe pb-4">
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
