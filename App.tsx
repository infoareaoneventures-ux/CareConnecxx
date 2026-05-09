import React, { useState, useEffect, Suspense, lazy } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { ViewType } from './types';

// Eager load critical landing page for faster first paint
import { LandingView as LandingViewComponent } from './components/LandingView';

// Lazy Load Pages with prefetching
const ClientDashboard = lazy(() => import('./components/client/ClientDashboard').then(module => ({ default: module.ClientDashboard })));
const AccountSettings = lazy(() => import('./components/client/AccountSettings').then(module => ({ default: module.AccountSettings })));
const Payments = lazy(() => import('./components/client/Payments').then(module => ({ default: module.Payments })));
const MyCareTeam = lazy(() => import('./components/client/MyCareTeam').then(module => ({ default: module.MyCareTeam })));
const BrowseCaregivers = lazy(() => import('./components/client/BrowseCaregivers').then(module => ({ default: module.BrowseCaregivers })));
const FindCaregivers = lazy(() => import('./components/FindCaregivers'));
const Membership = lazy(() => import('./components/Membership'));
const Schedule = lazy(() => import('./components/Schedule'));
const Interviews = lazy(() => import('./components/Interviews'));
const HireDecision = lazy(() => import('./components/HireDecision'));
const ClientCaregiverProfile = lazy(() => import('./components/ClientCaregiverProfile'));
const IdentityCallback = lazy(() => import('./components/client/IdentityCallback'));
const BookingFlow = lazy(() => import('./components/client/booking/BookingFlow'));
const ReviewSystem = lazy(() => import('./components/ReviewSystem'));
const WeeklySummary = lazy(() => import('./components/WeeklySummary'));
const InterviewOutcome = lazy(() => import('./components/InterviewOutcome'));
const CaregiverDashboard = lazy(() => import('./components/CaregiverDashboard').then(module => ({ default: module.CaregiverDashboard })));
const ClientSignup = lazy(() => import('./components/ClientSignup').then(module => ({ default: module.ClientSignup })));
const ClientLogin = lazy(() => import('./components/ClientLogin').then(module => ({ default: module.ClientLogin })));
const CaregiverSignup = lazy(() => import('./components/caregiver/signup/CaregiverSignupFlow').then(module => ({ default: module.CaregiverSignupFlow })));
const CaregiverLogin = lazy(() => import('./components/CaregiverLogin').then(module => ({ default: module.CaregiverLogin })));
const ForgotPassword = lazy(() => import('./components/ForgotPassword').then(module => ({ default: module.ForgotPassword })));
const AdminView = lazy(() => import('./components/AdminView').then(module => ({ default: module.AdminView })));
const ClientProfile = lazy(() => import('./components/ClientProfile').then(module => ({ default: module.ClientProfile })));
const ClientProfileDashboard = lazy(() => import('./components/ClientProfileDashboard'));
const CaregiverProfile = lazy(() => import('./components/CaregiverProfile').then(module => ({ default: module.CaregiverProfile })));
const InboxView = lazy(() => import('./components/InboxView').then(module => ({ default: module.InboxView })));
const StripeCallback = lazy(() => import('./components/StripeCallback').then(module => ({ default: module.StripeCallback })));
const PaymentSuccess = lazy(() => import('./components/PaymentSuccess').then(module => ({ default: module.PaymentSuccess })));
const PaymentCancel = lazy(() => import('./components/PaymentCancel').then(module => ({ default: module.PaymentCancel })));
const CarePlan = lazy(() => import('./components/CarePlan').then(module => ({ default: module.CarePlan })));
const CareJournalFeed = lazy(() => import('./components/client/CareJournalFeed').then(module => ({ default: module.CareJournalFeed })));
const HowItWorks = lazy(() => import('./components/HowItWorks').then(module => ({ default: module.HowItWorks })));
const LoginPage = lazy(() => import('./components/LoginPage').then(module => ({ default: module.LoginPage })));
const Subscription = lazy(() => import('./components/Subscription').then(module => ({ default: module.Subscription })));
const NotFound = lazy(() => import('./components/NotFound').then(module => ({ default: module.NotFound })));
const CaregiverCalendarPage = lazy(() => import('./components/caregiver/CaregiverCalendarPage').then(module => ({ default: module.CaregiverCalendarPage })));
const CaregiverMembership = lazy(() => import('./components/caregiver/CaregiverMembership').then(module => ({ default: module.CaregiverMembership })));
const CaregiverBookingsPage = lazy(() => import('./components/caregiver/CaregiverBookingsPage').then(module => ({ default: module.CaregiverBookingsPage })));
const CaregiverJobBoardPage = lazy(() => import('./components/caregiver/CaregiverJobBoardPage').then(module => ({ default: module.CaregiverJobBoardPage })));
const CaregiverIntroVideo = lazy(() => import('./components/caregiver/CaregiverIntroVideo').then(module => ({ default: module.CaregiverIntroVideo })));
const CaregiverFamiliesPage = lazy(() => import('./components/caregiver/CaregiverFamiliesPage').then(module => ({ default: module.CaregiverFamiliesPage })));
const CaregiverAccountSettings = lazy(() => import('./components/caregiver/CaregiverAccountSettings').then(module => ({ default: module.CaregiverAccountSettings })));
const CaregiverTransactionsPage = lazy(() => import('./components/caregiver/CaregiverTransactionsPage').then(module => ({ default: module.CaregiverTransactionsPage })));
const CaregiverPayoutPage = lazy(() => import('./components/caregiver/CaregiverPayoutPage').then(module => ({ default: module.CaregiverPayoutPage })));
const PublicCaregiverProfile = lazy(() => import('./components/caregiver/PublicCaregiverProfile').then(module => ({ default: module.PublicCaregiverProfile })));
const PostJobFlow = lazy(() => import('./components/client/postJob/PostJobFlow').then(module => ({ default: module.PostJobFlow })));
const PostsPage = lazy(() => import('./components/client/PostsPage').then(module => ({ default: module.PostsPage })));
const TrustAndSafetyPage = lazy(() => import('./components/TrustAndSafetyPage').then(module => ({ default: module.TrustAndSafetyPage })));
const FamilyFAQ = lazy(() => import('./components/FamilyFAQ').then(module => ({ default: module.FamilyFAQ })));
const HelpCenter = lazy(() => import('./components/HelpCenter').then(module => ({ default: module.HelpCenter })));
const HelpPage = lazy(() => import('./components/HelpPage').then(module => ({ default: module.HelpPage })));
const BlogPage        = lazy(() => import('./components/pages/BlogPage').then(module => ({ default: module.BlogPage })));
const CityPage        = lazy(() => import('./components/pages/CityPage').then(module => ({ default: module.CityPage })));
const QuickConfirmPage = lazy(() => import('./components/pages/QuickConfirmPage'));
const HealthSummaryPage = lazy(() => import('./components/pages/HealthSummaryPage'));



// Video Interview & Profile Modals
const ScheduleInterviewModal = lazy(() => import('./components/ScheduleInterviewModal').then(module => ({ default: module.ScheduleInterviewModal })));
const CaregiverProfileModal = lazy(() => import('./components/CaregiverProfileModal').then(module => ({ default: module.CaregiverProfileModal })));
const VideoInterviewRoom = lazy(() => import('./components/VideoInterviewRoom').then(module => ({ default: module.VideoInterviewRoom })));

// Wrapper for landing view
const LandingView = (props: any) => <LandingViewComponent {...props} />;

import { ToastContainer } from './components/ui/Toast';
import { PageLoader } from './components/ui/PageLoader';
import { Home, Settings, MessageSquare, ClipboardList, Loader2 } from 'lucide-react';

import { ErrorBoundary } from './components/ErrorBoundary';
import { CareConnexProvider, useCareConnex } from './context/CareConnexContext';

// Push Notifications
import { PushNotificationPrompt } from './components/PushNotificationPrompt';
import { FloatingOnboardingHelper } from './components/shared/FloatingOnboardingHelper';
import { pushNotificationService } from './services/pushNotificationService';

// PWA Components
import { PWAInstallPrompt, registerServiceWorker } from './utils/pwa';
import { preloadCriticalResources } from './utils/performance';

// Caregiver Callout
import { useCaregiverCallout } from './hooks/useCaregiverCallout';
import { CaregiverCalloutModal } from './components/CaregiverCalloutModal';
import { useAppointmentForCallout } from './hooks/useCaregiverCallout';

// We create an inner component to consume the context for 'isLoading' and 'toasts' which are global
// But wait, ToastContainer needs 'toasts' and 'removeToast'.
// If App is wrapped by Provider, we can use hooks inside AppContent.
// But App itself returns the Provider. So we need a split.

const PublicOnlyRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { authResolved, currentUser } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (currentUser?.userType === 'client') return <Navigate to="/client/dashboard" replace />;
  if (currentUser?.userType === 'caregiver') return <Navigate to="/caregiver/dashboard" replace />;
  return element;
};

const ClientRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { currentUser, authResolved } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!currentUser) return <Navigate to="/client/login" replace />;
  if (currentUser.userType === 'caregiver') return <Navigate to="/caregiver/dashboard" replace />;
  return element;
};

const CaregiverRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { currentUser, authResolved } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!currentUser) return <Navigate to="/caregiver/login" replace />;
  if (currentUser.userType === 'client') return <Navigate to="/client/dashboard" replace />;
  return element;
};

const AppContent: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { isLoading, authResolved, toasts, removeToast, addToast, currentUser } = useCareConnex();

  // Caregiver Callout Handling
  const { activeCallout, dismissCallout } = useCaregiverCallout(currentUser?.uid || null);
  const { appointment: calloutAppointment } = useAppointmentForCallout(
    activeCallout?.data?.appointmentId || null
  );

  // Video Interview State
  const [scheduleInterviewCaregiver, setScheduleInterviewCaregiver] = useState<any>(null);
  const [viewingCaregiver, setViewingCaregiver] = useState<any>(null);
  const [activeInterview, setActiveInterview] = useState<any>(null);

  // Handle caregiver selection from callout modal
  const handleBackupCaregiverSelected = (caregiverId: string, caregiverName: string) => {
    addToast(`Backup caregiver ${caregiverName} confirmed!`, 'success');
    dismissCallout();
    // Refresh the page or navigate to appointments to see the update
    navigate('/client/dashboard');
  };

  // Handle refund request
  const handleRefundRequested = () => {
    addToast('Refund request submitted. You will receive confirmation shortly.', 'info');
    dismissCallout();
  };

  // State for holding the target client ID when a caregiver views a care plan
  const [viewingClientId, setViewingClientId] = useState<string | null>(null);

  // Check URL for external redirects (Stripe) or legacy params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');

    if (viewParam === 'stripe-callback') {
      navigate('/stripe/callback', { replace: true });
    } else if (viewParam === 'payment-success') {
      navigate('/payment/success', { replace: true });
    } else if (viewParam === 'payment-cancel') {
      navigate('/payment/cancel', { replace: true });
    }
  }, [navigate]);

  // Initialize PWA features
  useEffect(() => {
    registerServiceWorker();
    preloadCriticalResources();
  }, []);


  const handleNavigation = (view: ViewType, data?: any) => {
    if (view === 'care-plan' && typeof data === 'string') {
      setViewingClientId(data);
    } else if (view !== 'care-plan') {
      setViewingClientId(null);
    }

    switch (view) {
      case 'landing': navigate('/'); break;
      case 'how-it-works': navigate('/how-it-works'); break;
      case 'trust': navigate('/trust'); break;
      case 'family-faq': navigate('/family-faq'); break;
      case 'help-center': navigate('/help'); break;
      case 'help-families': navigate('/help/families'); break;
      case 'help-caregivers': navigate('/help/caregivers'); break;
      case 'help-general': navigate('/help/general'); break;
      case 'subscription': navigate('/pricing'); break;
      case 'client-signup': navigate('/client/signup'); break;
      case 'client-login': navigate('/client/login'); break;
      case 'client-intake': navigate('/client/dashboard'); break;
      case 'forgot-password-client': navigate('/client/forgot-password'); break;
      case 'forgot-password-caregiver': navigate('/caregiver/forgot-password'); break;
      case 'caregiver-signup': navigate('/caregiver/signup'); break;
      case 'caregiver-login': navigate('/caregiver/login'); break;
      case 'client': navigate('/client/dashboard'); break;
      case 'client-profile': navigate('/client/profile'); break;
      case 'client-inbox': navigate('/client/inbox'); break;
      case 'care-plan': navigate('/client/care-plan'); break;
        case 'care-journal': navigate('/client/care-journal'); break;
      case 'caregiver': navigate('/caregiver/dashboard'); break;
      case 'caregiver-profile': navigate('/caregiver/profile'); break;
      case 'caregiver-inbox': navigate('/caregiver/inbox'); break;
      case 'caregiver-calendar': navigate('/caregiver/calendar'); break;
      case 'caregiver-membership': navigate('/caregiver/membership'); break;
      case 'caregiver-jobs': navigate('/caregiver/jobs'); break;
      case 'caregiver-bookings': navigate('/caregiver/bookings'); break;
      case 'caregiver-video': navigate('/caregiver/video'); break;
      case 'caregiver-families': navigate('/caregiver/families'); break;
      case 'caregiver-settings': navigate('/caregiver/settings'); break;
      case 'caregiver-transactions': navigate('/caregiver/transactions'); break;
      case 'caregiver-payout': navigate('/caregiver/payout'); break;
      case 'admin': navigate('/admin'); break;
      case 'stripe-callback': navigate('/stripe/callback'); break;
      case 'payment-success': navigate('/payment/success'); break;
      case 'payment-cancel': navigate('/payment/cancel'); break;
      default: navigate('/');
    }
  };

  // Determine if we are in Client Flow or Caregiver Flow for Bottom Nav Styling
  const isCaregiverContext = viewingClientId !== null;
  const path = location.pathname;

  const isClientFlow = (
    path.startsWith('/client') ||
    (path.includes('care-plan') && !isCaregiverContext) ||
    path.includes('payment')
  );

  const isCaregiverFlow = (
    path.startsWith('/caregiver') ||
    (path.includes('care-plan') && isCaregiverContext)
  );

  const authPaths = [
    '/client/login',
    '/client/signup',
    '/client/forgot-password',
    '/caregiver/login',
    '/caregiver/signup',
    '/caregiver/forgot-password'
  ];

  const showBottomNav = isCaregiverFlow && !authPaths.includes(path);
  const activeColor = isClientFlow ? 'text-teal-600' : 'text-orange-500';

  if (!authResolved) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[var(--color-neutral-50)]">
        <Loader2 className="w-10 h-10 text-[var(--color-primary-600)] animate-spin mb-4" />
        <p className="text-[var(--color-neutral-500)] font-medium">Connecting to secure server...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-neutral-50)] font-sans relative">
      <ToastContainer toasts={toasts} removeToast={removeToast} />

      <Suspense fallback={<PageLoader fullScreen message="Loading page..." />}>
        <Routes>
          <Route path="/" element={<PublicOnlyRoute element={<LandingView onNavigate={handleNavigation} />} />} />
          <Route path="/login" element={<PublicOnlyRoute element={<LoginPage onNavigate={handleNavigation} />} />} />
          <Route path="/auth/login" element={<Navigate to="/login" replace />} />
          <Route path="/how-it-works" element={<HowItWorks onNavigate={handleNavigation} />} />
          <Route path="/trust" element={<TrustAndSafetyPage onNavigate={handleNavigation} />} />
          <Route path="/blog" element={<BlogPage onNavigate={handleNavigation} />} />
          <Route path="/blog/:slug" element={<BlogPage onNavigate={handleNavigation} />} />
          <Route path="/care/:city" element={<CityPage onNavigate={handleNavigation} />} />
          <Route path="/confirm/:token" element={<QuickConfirmPage />} />
          <Route path="/health-summary/:token" element={<HealthSummaryPage />} />
          <Route path="/family-faq" element={<FamilyFAQ onNavigate={handleNavigation} />} />
          <Route path="/help" element={<HelpCenter onNavigate={handleNavigation} />} />
          <Route path="/help/families" element={<HelpPage section="families" onNavigate={handleNavigation} />} />
          <Route path="/help/caregivers" element={<HelpPage section="caregivers" onNavigate={handleNavigation} />} />
          <Route path="/help/general" element={<HelpPage section="general" onNavigate={handleNavigation} />} />
          <Route path="/pricing" element={<Subscription onNavigate={handleNavigation} />} />
          <Route path="/client/signup" element={<ClientSignup onNavigate={handleNavigation} onShowToast={addToast} />} />
          <Route path="/client/login" element={<PublicOnlyRoute element={<ClientLogin onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/client/intake" element={<Navigate to="/client/dashboard" replace />} />
          <Route path="/client/profile" element={<ClientProfileDashboard />} />
          <Route path="/client/forgot-password" element={<ForgotPassword userType="client" onNavigate={handleNavigation} onShowToast={addToast} />} />

          <Route path="/caregiver/signup" element={<CaregiverSignup onNavigate={handleNavigation} onShowToast={addToast} />} />
          <Route path="/caregiver/login" element={<PublicOnlyRoute element={<CaregiverLogin onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/caregiver/forgot-password" element={<ForgotPassword userType="caregiver" onNavigate={handleNavigation} onShowToast={addToast} />} />

          <Route path="/client/dashboard" element={<ClientRoute element={<ClientDashboard onNavigate={handleNavigation} />} />} />
          <Route path="/client/account" element={<ClientRoute element={<AccountSettings />} />} />
          <Route path="/client/payments" element={<ClientRoute element={<Payments />} />} />
          <Route path="/client/my-care-team" element={<ClientRoute element={<MyCareTeam />} />} />
          <Route path="/client/browse-caregivers" element={<ClientRoute element={<BrowseCaregivers />} />} />
          <Route path="/client/find-caregivers" element={<ClientRoute element={<FindCaregivers />} />} />
          <Route path="/client/post-job" element={<ClientRoute element={<PostJobFlow />} />} />
          <Route path="/client/posts" element={<ClientRoute element={<PostsPage />} />} />
          <Route path="/client/membership" element={<ClientRoute element={<Membership />} />} />
          <Route path="/client/schedule" element={<ClientRoute element={<Schedule />} />} />
          <Route path="/client/interviews" element={<ClientRoute element={<Interviews />} />} />
          <Route path="/client/hire/:caregiverId" element={<ClientRoute element={<HireDecision />} />} />
          <Route path="/client/caregiver/:caregiverId" element={<ClientRoute element={<ClientCaregiverProfile />} />} />
          <Route path="/client/identity-callback" element={<ClientRoute element={<IdentityCallback />} />} />
          <Route path="/client/book/:caregiverId" element={<ClientRoute element={<BookingFlow />} />} />
          <Route path="/client/review/:visitId" element={<ClientRoute element={<ReviewSystem />} />} />
          <Route path="/client/weekly-summary" element={<ClientRoute element={<WeeklySummary />} />} />
          <Route path="/client/interview-outcome/:interviewId" element={<ClientRoute element={<InterviewOutcome />} />} />
          <Route path="/client/profile-old" element={<ClientRoute element={<ClientProfile onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/client/inbox" element={<ClientRoute element={<InboxView
            userType="client"
            onNavigate={handleNavigation}
            onShowToast={addToast}
            onScheduleVideoCall={(caregiverId, caregiverName) => {
              setScheduleInterviewCaregiver({
                id: caregiverId,
                uid: caregiverId,
                name: caregiverName,
                hourlyRate: 25,
                imageUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(caregiverName)}&background=random`
              });
            }}
            onViewProfile={(caregiverId) => {
              navigate(`/client/caregiver/${caregiverId}`);
            }}
          />} />} />

          <Route path="/caregiver/dashboard" element={<CaregiverRoute element={<CaregiverDashboard onNavigate={handleNavigation} />} />} />
          <Route path="/caregiver/profile" element={<CaregiverProfile onNavigate={handleNavigation} onShowToast={addToast} />} />
          <Route path="/caregiver/inbox" element={<InboxView userType="caregiver" onNavigate={handleNavigation} onShowToast={addToast} />} />
          <Route path="/caregiver/calendar" element={<CaregiverRoute element={<CaregiverCalendarPage onNavigate={handleNavigation} />} />} />
          <Route path="/caregiver/membership" element={<CaregiverRoute element={<CaregiverMembership onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/caregiver/bookings" element={<CaregiverRoute element={<CaregiverBookingsPage />} />} />
          <Route path="/caregiver/jobs" element={<CaregiverRoute element={<CaregiverJobBoardPage />} />} />
          <Route path="/caregiver/video" element={<CaregiverRoute element={<CaregiverIntroVideo />} />} />
          <Route path="/caregiver/families" element={<CaregiverRoute element={<CaregiverFamiliesPage />} />} />
          <Route path="/caregiver/settings" element={<CaregiverRoute element={<CaregiverAccountSettings />} />} />
          <Route path="/caregiver/transactions" element={<CaregiverRoute element={<CaregiverTransactionsPage />} />} />
          <Route path="/caregiver/payout" element={<CaregiverRoute element={<CaregiverPayoutPage />} />} />
          {/* Public shareable caregiver profile */}
          <Route path="/caregiver/:id" element={<PublicCaregiverProfile />} />

          <Route path="/client/care-plan" element={
            <CarePlan
              onNavigate={(view) => {
                // Smart back navigation
                if (viewingClientId) {
                  setViewingClientId(null);
                  navigate('/caregiver/dashboard');
                } else {
                  handleNavigation(view);
                }
              }}
              onShowToast={addToast}
              targetUserId={viewingClientId}
            />
          } />
        <Route path="/client/care-journal" element={
          <CareJournalFeed
            onNavigate={handleNavigation}
          />
        } />

          <Route path="/admin" element={<AdminView onBack={() => navigate('/')} />} />
          <Route path="/stripe/callback" element={<StripeCallback onNavigate={handleNavigation} />} />
          <Route path="/payment/success" element={<PaymentSuccess onNavigate={handleNavigation} onPaymentComplete={(id) => { /* handled in context now but PaymentSuccess might need update */ }} />} />
          <Route path="/payment/cancel" element={<PaymentCancel onNavigate={handleNavigation} />} />

          {/* 404 Page */}
          <Route path="*" element={<NotFound onNavigate={handleNavigation} />} />
        </Routes>
      </Suspense>

      {/* Push Notification Permission Prompt */}
      {currentUser?.uid && (
        <PushNotificationPrompt
          userId={currentUser.uid}
        />
      )}

      {/* Floating onboarding helper — visible on all authenticated pages */}
      {currentUser && currentUser.userType !== 'admin' && (
        <FloatingOnboardingHelper />
      )}

      {showBottomNav && (
        <div className="fixed bottom-4 sm:bottom-6 left-1/2 transform -translate-x-1/2 bg-white/95 backdrop-blur-md border border-[var(--color-neutral-200)] rounded-full shadow-2xl px-3 sm:px-6 py-2 sm:py-3 flex space-x-2 sm:space-x-6 z-50 safe-area-bottom md:hidden">
          <button
            onClick={() => handleNavigation(isClientFlow ? 'client' : 'caregiver')}
            className={`flex flex-col items-center justify-center transition-colors min-w-[48px] min-h-[48px] rounded-lg active:scale-95 ${path.endsWith('dashboard') || path === '/client' || path === '/caregiver' ? activeColor : 'text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)]'
              }`}
          >
            <Home className="w-5 sm:w-6 h-5 sm:h-6" />
            <span className="text-[10px] font-medium mt-0.5">Home</span>
          </button>

          <div className="w-px bg-[var(--color-neutral-200)] h-8 self-center hidden sm:block"></div>

          {/* Care Plan Tab (Client Only) */}
          {isClientFlow && (
            <>
              <button
                onClick={() => handleNavigation('care-plan')}
                className={`flex flex-col items-center justify-center transition-colors min-w-[48px] min-h-[48px] rounded-lg active:scale-95 ${path.includes('care-plan') ? activeColor : 'text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)]'
                  }`}
              >
                <ClipboardList className="w-5 sm:w-6 h-5 sm:h-6" />
                <span className="text-[10px] font-medium mt-0.5">Binder</span>
              </button>
              <div className="w-px bg-[var(--color-neutral-200)] h-8 self-center hidden sm:block"></div>
            </>
          )}

          <button
            onClick={() => handleNavigation(isClientFlow ? 'client-inbox' : 'caregiver-inbox')}
            className={`flex flex-col items-center justify-center transition-colors min-w-[48px] min-h-[48px] rounded-lg active:scale-95 ${path.includes('inbox') ? activeColor : 'text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)]'
              }`}
          >
            <div className="relative">
              <MessageSquare className="w-5 sm:w-6 h-5 sm:h-6" />
              {/* Badge could be dynamic */}
            </div>
            <span className="text-[var(--color-neutral-400)] text-[10px] font-medium mt-0.5">Chat</span>
          </button>

          <div className="w-px bg-[var(--color-neutral-200)] h-8 self-center hidden sm:block"></div>

          <button
            onClick={() => handleNavigation(isClientFlow ? 'client-profile' : 'caregiver-profile')}
            className={`flex flex-col items-center justify-center transition-colors min-w-[48px] min-h-[48px] rounded-lg active:scale-95 ${path.includes('profile')
              ? activeColor
              : 'text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-600)]'
              }`}
          >
            <Settings className="w-5 sm:w-6 h-5 sm:h-6" />
            <span className="text-[10px] font-medium mt-0.5">Profile</span>
          </button>
        </div>
      )}

      {/* PWA Install Prompt */}
      <PWAInstallPrompt />

      {/* Caregiver Callout Modal */}
      {activeCallout && calloutAppointment && (
        <CaregiverCalloutModal
          appointmentId={activeCallout.data?.appointmentId || ''}
          originalCaregiverName={calloutAppointment.caregiverName || 'Your caregiver'}
          date={calloutAppointment.date}
          time={calloutAppointment.time}
          onClose={dismissCallout}
          onCaregiverSelected={handleBackupCaregiverSelected}
          onRefundRequested={handleRefundRequested}
        />
      )}

      {/* Video Interview Modals */}
      <Suspense fallback={null}>
        {scheduleInterviewCaregiver && (
          <ScheduleInterviewModal
            caregiver={scheduleInterviewCaregiver}
            onClose={() => setScheduleInterviewCaregiver(null)}
            onSuccess={(message) => {
              addToast(message, 'success');
              setScheduleInterviewCaregiver(null);
            }}
            onShowToast={addToast}
          />
        )}
      </Suspense>

      <Suspense fallback={null}>
        {activeInterview && (
          <VideoInterviewRoom
            interview={activeInterview}
            userId={currentUser?.uid || ''}
            userName={currentUser?.displayName || 'User'}
            onEnd={() => {
              setActiveInterview(null);
              addToast('Interview ended', 'info');
            }}
            onShowToast={addToast}
          />
        )}
      </Suspense>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <CareConnexProvider>
        <AppContent />
      </CareConnexProvider>
    </ErrorBoundary>
  );
};

export default App;
