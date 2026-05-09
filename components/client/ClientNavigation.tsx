import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Home, Search, Calendar, MessageSquare, Heart,
  ChevronDown, LogOut, Settings, CreditCard, Crown,
  Users, FileText, Clock, BookOpen, Bell,
  Briefcase, X, MoreHorizontal,
} from 'lucide-react';
import { authService, dbService } from '../../services/api';

const MY_CARE_ROUTES = [
  '/client/care-plan',
  '/client/care-journal',
  '/client/my-care-team',
  '/client/interviews',
];

const ACCOUNT_ROUTES = ['/client/account', '/client/payments', '/client/membership'];

export const ClientNavigation: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const [myCareOpen, setMyCareOpen] = React.useState(false);
  const [avatarOpen, setAvatarOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [currentUser, setCurrentUser] = React.useState<any>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = React.useState<string | null>(null);

  const myCareRef = React.useRef<HTMLDivElement>(null);
  const avatarRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const user = authService.getCurrentUser();
    setCurrentUser(user);
    if (user?.uid) {
      dbService.getSeniorProfile(user.uid).then(profile => {
        if (profile?.imageUrl) setProfilePhotoUrl(profile.imageUrl);
      }).catch(() => {});
    }
  }, []);

  // Close dropdowns on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (myCareRef.current && !myCareRef.current.contains(t)) setMyCareOpen(false);
      if (avatarRef.current && !avatarRef.current.contains(t)) setAvatarOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, []);

  const isActive = (path: string) => location.pathname === path;
  const isMyCareActive = MY_CARE_ROUTES.some(r => location.pathname.startsWith(r));
  const isAccountActive = ACCOUNT_ROUTES.some(r => location.pathname === r);

  const navBtn = (active: boolean) =>
    `flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      active ? 'text-primary-600 bg-primary-50' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
    }`;

  const handleLogout = async () => {
    try { await authService.logout(); } catch {}
    navigate('/');
  };

  const go = (path: string) => {
    navigate(path);
    setMyCareOpen(false);
    setAvatarOpen(false);
  };

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

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-1">

            {/* Home */}
            <button onClick={() => navigate('/client/dashboard')} className={navBtn(isActive('/client/dashboard'))}>
              <Home className="w-4 h-4" /><span>Home</span>
            </button>

            {/* Find Care */}
            <button onClick={() => navigate('/client/find-caregivers')} className={navBtn(isActive('/client/find-caregivers') || isActive('/client/browse-caregivers'))}>
              <Search className="w-4 h-4" /><span>Find Care</span>
            </button>

            {/* Care Requests */}
            <button onClick={() => navigate('/client/posts')} className={navBtn(isActive('/client/posts') || isActive('/client/post-job'))}>
              <Briefcase className="w-4 h-4" /><span>Care Requests</span>
            </button>

            {/* Schedule */}
            <button onClick={() => navigate('/client/schedule')} className={navBtn(isActive('/client/schedule'))}>
              <Calendar className="w-4 h-4" /><span>Schedule</span>
            </button>

            {/* Messages */}
            <button onClick={() => navigate('/client/inbox')} className={navBtn(isActive('/client/inbox'))}>
              <MessageSquare className="w-4 h-4" /><span>Messages</span>
            </button>

            {/* My Care dropdown */}
            <div className="relative" ref={myCareRef}>
              <button
                onClick={() => setMyCareOpen(o => !o)}
                className={navBtn(isMyCareActive || myCareOpen)}
              >
                <Heart className="w-4 h-4" /><span>My Care</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${myCareOpen ? 'rotate-180' : ''}`} />
              </button>
              {myCareOpen && (
                <div className="absolute left-0 mt-2 w-52 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50">
                  {[
                    { icon: <FileText className="w-4 h-4" />, label: 'Care Plan', path: '/client/care-plan' },
                    { icon: <BookOpen className="w-4 h-4" />, label: 'Visits', path: '/client/care-journal' },
                    { icon: <Users className="w-4 h-4" />, label: 'Care Team', path: '/client/my-care-team' },
                    { icon: <Clock className="w-4 h-4" />, label: 'Interviews', path: '/client/interviews' },
                  ].map(item => (
                    <button key={item.path} onClick={() => go(item.path)}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                        isActive(item.path) ? 'text-primary-600 bg-primary-50' : 'text-gray-700 hover:bg-gray-50'
                      }`}>
                      {item.icon}<span>{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Notifications bell */}
          <button className="hidden md:flex items-center justify-center w-9 h-9 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors ml-2 relative">
            <Bell className="w-5 h-5" />
          </button>

          {/* Avatar dropdown (right) */}
          <div className="relative ml-2" ref={avatarRef}>
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
              <span className="hidden sm:inline max-w-[120px] truncate">{displayName}</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${avatarOpen ? 'rotate-180' : ''}`} />
            </button>

            {avatarOpen && (
              <div className="absolute right-0 mt-2 w-52 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50">
                <div className="px-4 py-2.5 border-b border-gray-100">
                  <p className="text-sm font-semibold text-gray-900 truncate">{displayName}</p>
                  <p className="text-xs text-gray-500 truncate">{currentUser?.email || ''}</p>
                </div>
                {[
                  { icon: <Settings className="w-4 h-4" />, label: 'Account Settings', path: '/client/account' },
                  { icon: <CreditCard className="w-4 h-4" />, label: 'Payments', path: '/client/payments' },
                  { icon: <Crown className="w-4 h-4" />, label: 'Membership', path: '/client/membership' },
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

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white safe-area-pb">
        <div className="flex justify-around py-1">
          {[
            { icon: <Home className="w-5 h-5" />, label: 'Home', path: '/client/dashboard', exact: true },
            { icon: <Search className="w-5 h-5" />, label: 'Find Care', path: '/client/find-caregivers', exact: false },
            { icon: <Calendar className="w-5 h-5" />, label: 'Schedule', path: '/client/schedule', exact: false },
            { icon: <MessageSquare className="w-5 h-5" />, label: 'Messages', path: '/client/inbox', exact: false },
          ].map(item => (
            <button key={item.path} onClick={() => { setMoreOpen(false); navigate(item.path); }}
              className={`flex flex-col items-center gap-0.5 px-3 py-2 text-xs font-medium transition-colors ${
                (item.exact ? location.pathname === item.path : location.pathname.startsWith(item.path))
                  ? 'text-primary-600'
                  : 'text-gray-500'
              }`}>
              {item.icon}
              <span>{item.label}</span>
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
                { icon: <FileText className="w-4 h-4" />, label: 'Care Plan', path: '/client/care-plan' },
                { icon: <BookOpen className="w-4 h-4" />, label: 'Visits', path: '/client/care-journal' },
                { icon: <Users className="w-4 h-4" />, label: 'Care Team', path: '/client/my-care-team' },
                { icon: <Clock className="w-4 h-4" />, label: 'Interviews', path: '/client/interviews' },
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
