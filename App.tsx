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
const ClientVisitsPage = lazy(() => import('./components/client/ClientVisitsPage').then(m => ({ default: m.ClientVisitsPage })));
const ClientCaregiverProfile = lazy(() => import('./components/ClientCaregiverProfile'));
const IdentityCallback = lazy(() => import('./components/client/IdentityCallback'));
const BookingFlow = lazy(() => import('./components/client/booking/BookingFlow'));
const ReviewSystem = lazy(() => import('./components/ReviewSystem'));
const WeeklySummary = lazy(() => import('./components/WeeklySummary'));
const InterviewOutcome = lazy(() => import('./components/InterviewOutcome'));
const CaregiverDashboard = lazy(() => import('./components/CaregiverDashboard').then(module => ({ default: module.CaregiverDashboard })));
const ClientLogin = lazy(() => import('./components/ClientLogin').then(module => ({ default: module.ClientLogin })));
const CaregiverLogin = lazy(() => import('./components/CaregiverLogin').then(module => ({ default: module.CaregiverLogin })));
const ForgotPassword = lazy(() => import('./components/ForgotPassword').then(module => ({ default: module.ForgotPassword })));
const AdminView = lazy(() => import('./components/AdminView').then(module => ({ default: module.AdminView })));
const AuditDashboard = lazy(() => import('./components/admin/AuditDashboard').then(module => ({ default: module.AuditDashboard })));
const JoinFamilyPage = lazy(() => import('./components/pages/JoinFamilyPage'));
const ClientProfile = lazy(() => import('./components/ClientProfile').then(module => ({ default: module.ClientProfile })));
const ClientProfileDashboard = lazy(() => import('./components/ClientProfileDashboard'));
const CaregiverProfile = lazy(() => import('./components/CaregiverProfile').then(module => ({ default: module.CaregiverProfile })));
const InboxView = lazy(() => import('./components/InboxView').then(module => ({ default: module.InboxView })));
const StripeCallback = lazy(() => import('./components/StripeCallback').then(module => ({ default: module.StripeCallback })));
const PaymentSuccess = lazy(() => import('./components/PaymentSuccess').then(module => ({ default: module.PaymentSuccess })));
const PaymentCancel = lazy(() => import('./components/PaymentCancel').then(module => ({ default: module.PaymentCancel })));
const CarePlan = lazy(() => import('./components/CarePlan').then(module => ({ default: module.CarePlan })));
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
const CaregiverPaymentsPage = lazy(() => import('./components/caregiver/CaregiverPaymentsPage').then(module => ({ default: module.CaregiverPaymentsPage })));
const PublicCaregiverProfile = lazy(() => import('./components/caregiver/PublicCaregiverProfile').then(module => ({ default: module.PublicCaregiverProfile })));
const PostJobFlow = lazy(() => import('./components/client/postJob/PostJobFlow').then(module => ({ default: module.PostJobFlow })));
const PostsPage = lazy(() => import('./components/client/PostsPage').then(module => ({ default: module.PostsPage })));
const TrustAndSafetyPage = lazy(() => import('./components/TrustAndSafetyPage').then(module => ({ default: module.TrustAndSafetyPage })));
const FamilyFAQ = lazy(() => import('./components/FamilyFAQ').then(module => ({ default: module.FamilyFAQ })));
const HelpCenter = lazy(() => import('./components/HelpCenter').then(module => ({ default: module.HelpCenter })));
const HelpPage = lazy(() => import('./components/HelpPage').then(module => ({ default: module.HelpPage })));
const BlogPage        = lazy(() => import('./components/pages/BlogPage').then(module => ({ default: module.BlogPage })));
const CityPage        = lazy(() => import('./components/pages/CityPage').then(module => ({ default: module.CityPage })));
const QuickConfirmPage    = lazy(() => import('./components/pages/QuickConfirmPage'));
const HealthSummaryPage   = lazy(() => import('./components/pages/HealthSummaryPage'));
const IMessageSignupPage  = lazy(() => import('./components/landing/IMessageSignupPage'));
const PhoneSignupPage     = lazy(() => import('./components/auth/PhoneSignupPage'));
const AuthLoginPage       = lazy(() => import('./components/auth/LoginPage'));
const UploadPage          = lazy(() => import('./components/pages/UploadPage'));
const GenericSuccessPage  = lazy(() => import('./components/pages/GenericSuccessPage'));
const ClientSignup = lazy(() => import('./components/ClientSignup').then(m => ({ default: m.ClientSignup })));
const TermsOfServicePage  = lazy(() => import('./components/pages/TermsOfServicePage'));
const PrivacyPolicyPage   = lazy(() => import('./components/pages/PrivacyPolicyPage'));



// Profile Modal
const CaregiverProfileModal = lazy(() => import('./components/CaregiverProfileModal').then(module => ({ default: module.CaregiverProfileModal })));

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
  if (currentUser?.userType === 'admin') return <Navigate to="/admin" replace />;
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

const AdminRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { authResolved, currentUser } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!currentUser) return <Navigate to="/client/login" replace />;
  if (currentUser.userType !== 'admin') return <Navigate to="/" replace />;
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

  const [viewingCaregiver, setViewingCaregiver] = useState<any>(null);

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
      case 'client-apply': navigate('/client/apply'); break;
      case 'caregiver-apply': navigate('/start?role=caregiver'); break;
      case 'caregiver-login': navigate('/caregiver/login'); break;
      case 'client': navigate('/client/dashboard'); break;
      case 'client-profile': navigate('/client/profile'); break;
      case 'client-inbox': navigate('/client/inbox'); break;
      case 'care-plan': navigate('/client/care-plan'); break;
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
      case 'caregiver-transactions': navigate('/caregiver/payments'); break;
      case 'caregiver-payout': navigate('/caregiver/payments'); break;
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
          <Route path="/login" element={<PublicOnlyRoute element={<AuthLoginPage />} />} />
          <Route path="/auth/login" element={<Navigate to="/login" replace />} />
          <Route path="/how-it-works" element={<HowItWorks onNavigate={handleNavigation} />} />
          <Route path="/trust" element={<TrustAndSafetyPage onNavigate={handleNavigation} />} />
          <Route path="/blog" element={<BlogPage onNavigate={handleNavigation} />} />
          <Route path="/blog/:slug" element={<BlogPage onNavigate={handleNavigation} />} />
          <Route path="/care/:city" element={<CityPage onNavigate={handleNavigation} />} />
          <Route path="/start"              element={<PhoneSignupPage />} />
          <Route path="/upload/:type"        element={<UploadPage />} />
          <Route path="/done"               element={<GenericSuccessPage />} />
          <Route path="/confirm/:token"     element={<QuickConfirmPage />} />
          <Route path="/health-summary/:token" element={<ErrorBoundary><HealthSummaryPage /></ErrorBoundary>} />
          <Route path="/family-faq" element={<FamilyFAQ onNavigate={handleNavigation} />} />
          <Route path="/help" element={<HelpCenter onNavigate={handleNavigation} />} />
          <Route path="/help/families" element={<HelpPage section="families" onNavigate={handleNavigation} />} />
          <Route path="/help/caregivers" element={<HelpPage section="caregivers" onNavigate={handleNavigation} />} />
          <Route path="/help/general" element={<HelpPage section="general" onNavigate={handleNavigation} />} />
          <Route path="/pricing" element={<Subscription onNavigate={handleNavigation} />} />
          {/* Signup routes redirect into the unified phone-first onboarding at /start.
              The role= query param selects between the senior-friendly family mode and
              the leaner caregiver mode. See components/auth/onboarding/OnboardingFlow.tsx. */}
          <Route path="/client/signup" element={<Navigate to="/start?role=client" replace />} />
          <Route path="/client/login" element={<PublicOnlyRoute element={<ClientLogin onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/client/intake" element={<Navigate to="/client/dashboard" replace />} />
          <Route path="/client/profile" element={<ClientRoute element={<ClientProfileDashboard />} />} />
          <Route path="/client/forgot-password" element={<ForgotPassword userType="client" onNavigate={handleNavigation} onShowToast={addToast} />} />

          <Route path="/caregiver/signup" element={<Navigate to="/start?role=caregiver" replace />} />
          <Route path="/client/apply" element={<PublicOnlyRoute element={<ClientSignup onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          {/* Web caregiver signup retired — Cara SMS (/start) is the canonical onboarding. Redirect preserves any existing bookmarks/links. */}
          <Route path="/caregiver/apply" element={<Navigate to="/start?role=caregiver" replace />} />
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
          <Route path="/client/calendar" element={<ClientRoute element={<Schedule />} />} />
          <Route path="/client/schedule" element={<Navigate to="/client/calendar" replace />} />
          <Route path="/client/bookings" element={<ClientRoute element={<ClientVisitsPage />} />} />
          <Route path="/client/visits" element={<Navigate to="/client/bookings" replace />} />
          <Route path="/client/interviews" element={<Navigate to="/client/posts" replace />} />
          <Route path="/client/hire/:caregiverId" element={<Navigate to="/client/posts" replace />} />
          <Route path="/client/caregiver/:caregiverId" element={<ClientRoute element={<ClientCaregiverProfile />} />} />
          {/* Public on purpose: SMS-originated clients return here from Stripe Identity
              without a web session. The component already handles the no-auth case
              (waits for the webhook). Gating it behind ClientRoute bounced them to login. */}
          <Route path="/client/identity-callback" element={<IdentityCallback />} />
          <Route path="/client/book/:caregiverId" element={<ClientRoute element={<BookingFlow />} />} />
          <Route path="/client/review/:visitId" element={<ClientRoute element={<ReviewSystem />} />} />
          <Route path="/client/weekly-summary" element={<ClientRoute element={<WeeklySummary />} />} />
          <Route path="/client/interview-outcome/:interviewId" element={<ClientRoute element={<InterviewOutcome />} />} />
          <Route path="/client/profile-old" element={<ClientRoute element={<ClientProfile onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/client/inbox" element={<ClientRoute element={<InboxView
            userType="client"
            onNavigate={handleNavigation}
            onShowToast={addToast}
            onViewProfile={(caregiverId) => {
              navigate(`/client/caregiver/${caregiverId}`);
            }}
          />} />} />

          <Route path="/caregiver/dashboard" element={<CaregiverRoute element={<CaregiverDashboard onNavigate={handleNavigation} />} />} />
          <Route path="/caregiver/profile" element={<CaregiverRoute element={<CaregiverProfile onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/caregiver/inbox" element={<CaregiverRoute element={<InboxView userType="caregiver" onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/caregiver/calendar" element={<CaregiverRoute element={<CaregiverCalendarPage onNavigate={handleNavigation} />} />} />
          <Route path="/caregiver/membership" element={<CaregiverRoute element={<CaregiverMembership onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/caregiver/bookings" element={<CaregiverRoute element={<CaregiverBookingsPage />} />} />
          <Route path="/caregiver/jobs" element={<CaregiverRoute element={<CaregiverJobBoardPage />} />} />
          <Route path="/caregiver/video" element={<CaregiverRoute element={<CaregiverIntroVideo />} />} />
          <Route path="/caregiver/families" element={<CaregiverRoute element={<CaregiverFamiliesPage />} />} />
          <Route path="/caregiver/settings" element={<CaregiverRoute element={<CaregiverAccountSettings />} />} />
          <Route path="/caregiver/payments" element={<CaregiverRoute element={<CaregiverPaymentsPage />} />} />
          {/* Legacy routes — redirect to unified payments page */}
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

          <Route path="/admin" element={<AdminRoute element={<AdminView onBack={() => navigate('/')} />} />} />
          <Route path="/admin/audit" element={<AdminRoute element={<AuditDashboard />} />} />
          <Route path="/join" element={<JoinFamilyPage />} />
          <Route path="/terms" element={<TermsOfServicePage />} />
          <Route path="/privacy" element={<PrivacyPolicyPage />} />
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
