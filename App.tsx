import React, { useState, useEffect, Suspense, lazy } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { ViewType } from './types';

// Eager load critical landing page for faster first paint
import { LandingView as LandingViewComponent } from './components/LandingView';
import { LegacyCaregiverRedirect, LegacyClientCaregiverRedirect } from './components/LegacyCaregiverRedirect';

// Lazy Load Pages with prefetching
const ClientDashboard = lazy(() => import('./components/client/ClientDashboard').then(module => ({ default: module.ClientDashboard })));
const AccountSettings = lazy(() => import('./components/client/AccountSettings').then(module => ({ default: module.AccountSettings })));
const Payments = lazy(() => import('./components/client/Payments').then(module => ({ default: module.Payments })));
const MyCareTeam = lazy(() => import('./components/client/MyCareTeam').then(module => ({ default: module.MyCareTeam })));
const FindCaregivers = lazy(() => import('./components/FindCaregivers'));
const Membership = lazy(() => import('./components/Membership'));
const Schedule = lazy(() => import('./components/Schedule'));
const ClientVisitsPage = lazy(() => import('./components/client/ClientVisitsPage').then(m => ({ default: m.ClientVisitsPage })));
const ClientCaregiverProfile = lazy(() => import('./components/ClientCaregiverProfile'));
const IdentityCallback = lazy(() => import('./components/client/IdentityCallback'));
const CaregiverDashboard = lazy(() => import('./components/CaregiverDashboard').then(module => ({ default: module.CaregiverDashboard })));
const AdminView = lazy(() => import('./components/AdminView').then(module => ({ default: module.AdminView })));
const AuditDashboard = lazy(() => import('./components/admin/AuditDashboard').then(module => ({ default: module.AuditDashboard })));
const ClientConnectPage = lazy(() => import('./components/client/ClientConnectPage').then(m => ({ default: m.ClientConnectPage })));
const CaregiverConnectPage = lazy(() => import('./components/caregiver/CaregiverConnectPage').then(m => ({ default: m.CaregiverConnectPage })));
const CaregiverProfile = lazy(() => import('./components/CaregiverProfile').then(module => ({ default: module.CaregiverProfile })));
const InboxView = lazy(() => import('./components/InboxView').then(module => ({ default: module.InboxView })));
const StripeCallback = lazy(() => import('./components/StripeCallback').then(module => ({ default: module.StripeCallback })));
const PaymentSuccess = lazy(() => import('./components/PaymentSuccess').then(module => ({ default: module.PaymentSuccess })));
const PaymentCancel = lazy(() => import('./components/PaymentCancel').then(module => ({ default: module.PaymentCancel })));
const CarePlan = lazy(() => import('./components/CarePlan').then(module => ({ default: module.CarePlan })));
const NotFound = lazy(() => import('./components/NotFound').then(module => ({ default: module.NotFound })));
const CaregiverCalendarPage = lazy(() => import('./components/caregiver/CaregiverCalendarPage').then(module => ({ default: module.CaregiverCalendarPage })));
const CaregiverMembership = lazy(() => import('./components/caregiver/CaregiverMembership').then(module => ({ default: module.CaregiverMembership })));
const CaregiverBookingsPage = lazy(() => import('./components/caregiver/CaregiverBookingsPage').then(module => ({ default: module.CaregiverBookingsPage })));
const CaregiverJobBoardPage = lazy(() => import('./components/caregiver/CaregiverJobBoardPage').then(module => ({ default: module.CaregiverJobBoardPage })));
const CaregiverFamiliesPage = lazy(() => import('./components/caregiver/CaregiverFamiliesPage').then(module => ({ default: module.CaregiverFamiliesPage })));
const CaregiverAccountSettings = lazy(() => import('./components/caregiver/CaregiverAccountSettings').then(module => ({ default: module.CaregiverAccountSettings })));
const CaregiverPaymentsPage = lazy(() => import('./components/caregiver/CaregiverPaymentsPage').then(module => ({ default: module.CaregiverPaymentsPage })));
const PublicCaregiverProfile = lazy(() => import('./components/caregiver/PublicCaregiverProfile').then(module => ({ default: module.PublicCaregiverProfile })));
const PostJobFlow = lazy(() => import('./components/client/postJob/PostJobFlow').then(module => ({ default: module.PostJobFlow })));
const CaregiverOnboardingWizard = lazy(() => import('./components/caregiver/CaregiverOnboardingWizard').then(m => ({ default: m.CaregiverOnboardingWizard })));
const ClientJobPostingWizard = lazy(() => import('./components/client/ClientJobPostingWizard').then(m => ({ default: m.ClientJobPostingWizard })));
const PostsPage = lazy(() => import('./components/client/PostsPage').then(module => ({ default: module.PostsPage })));
const PhoneSignupPage     = lazy(() => import('./components/auth/PhoneSignupPage'));
const AuthLoginPage       = lazy(() => import('./components/auth/LoginPage'));
const UploadPage          = lazy(() => import('./components/pages/UploadPage'));
const BgcheckConsentPage  = lazy(() => import('./components/pages/BgcheckConsentPage'));
const GenericSuccessPage  = lazy(() => import('./components/pages/GenericSuccessPage'));
const TermsOfServicePage  = lazy(() => import('./components/pages/TermsOfServicePage'));
const PrivacyPolicyPage   = lazy(() => import('./components/pages/PrivacyPolicyPage'));
const RequestAccountRecoveryPage = lazy(() => import('./components/pages/RequestAccountRecoveryPage'));
const VerifyPhoneChangePage      = lazy(() => import('./components/pages/VerifyPhoneChangePage'));
const VerifyEmailChangePage      = lazy(() => import('./components/pages/VerifyEmailChangePage'));
const ApproveEmailChangePage     = lazy(() => import('./components/pages/ApproveEmailChangePage'));




// Wrapper for landing view
const LandingView = (props: any) => <LandingViewComponent {...props} />;

import { ToastContainer } from './components/ui/Toast';
import { PageLoader } from './components/ui/PageLoader';
import { Home, Settings, MessageSquare, ClipboardList, Loader2, RefreshCw, LogOut, AlertTriangle } from 'lucide-react';

import { ErrorBoundary } from './components/ErrorBoundary';
import { CareConnexProvider, useCareConnex } from './context/CareConnexContext';
import { PasswordGate } from './components/auth/PasswordGate';


// Push Notifications
import { PushNotificationPrompt } from './components/PushNotificationPrompt';
import { pushNotificationService } from './services/pushNotificationService';

// PWA Components
import { PWAInstallPrompt, registerServiceWorker } from './utils/pwa';
import { ActingBanner } from './components/admin/ActingBanner';
import { preloadCriticalResources } from './utils/performance';


// We create an inner component to consume the context for 'isLoading' and 'toasts' which are global
// But wait, ToastContainer needs 'toasts' and 'removeToast'.
// If App is wrapped by Provider, we can use hooks inside AppContent.
// But App itself returns the Provider. So we need a split.

const PublicOnlyRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { authResolved, currentUser } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (currentUser?.userType === 'client') return <Navigate to="/client/dashboard" replace />;
  if (currentUser?.userType === 'caregiver') return <Navigate to="/care-provider/dashboard" replace />;
  if (currentUser?.userType === 'admin') return <Navigate to="/admin" replace />;
  return element;
};

const ClientRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { currentUser, authResolved, actingFor } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!currentUser) return <Navigate to="/login" replace />;
  if (currentUser.userType === 'caregiver') return <Navigate to="/care-provider/dashboard" replace />;
  // An admin acting for the family (2026-10-22) is not sent to the Evia-connect QR page.
  if (!currentUser.eviaConnected && !actingFor) return <Navigate to="/client/connect" replace />;
  return (
    <>
      {element}
      {currentUser.jobPostingCompleted !== true && (
        <Suspense fallback={null}>
          <ClientJobPostingWizard uid={currentUser.uid} onComplete={() => {}} />
        </Suspense>
      )}
    </>
  );
};

// Auth-only wrapper for /client/connect — checks login but NOT eviaConnected (avoids redirect loop)
const ClientAuthRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { currentUser, authResolved } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!currentUser) return <Navigate to="/login" replace />;
  if (currentUser.userType === 'caregiver') return <Navigate to="/care-provider/dashboard" replace />;
  if (currentUser.eviaConnected) return <Navigate to="/client/dashboard" replace />;
  return element;
};

const CaregiverRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { currentUser, authResolved, caregiverProfile, addToast, actingFor } = useCareConnex();
  const navigate = useNavigate();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!currentUser) return <Navigate to="/login" replace />;
  if (currentUser.userType === 'client') return <Navigate to="/client/dashboard" replace />;
  // An admin acting for the care provider (2026-10-22) is not sent to the Evia-connect QR page.
  if (!currentUser.eviaConnected && !actingFor) return <Navigate to="/care-provider/connect" replace />;
  // Same default as ClientRoute's jobPostingCompleted check: treat "no record
  // yet" as "still needs the wizard", not as "wait until one shows up". A
  // caregiver's record is now created the moment they connect (webhooks.ts
  // handlePendingConsentReply / onboardingConversation.ts handleAskRole), but
  // this stays defensive against the listener not having caught up yet — the
  // wizard does its own independent fetch on mount, so showing it immediately
  // is safe even if `caregiverProfile` is still null here (2026-09-23, site
  // signup parity with the client side).
  const showWizard = caregiverProfile === null || caregiverProfile.onboardingStatus !== 'profile_complete';
  return (
    <>
      {element}
      {showWizard && (
        <Suspense fallback={null}>
          <CaregiverOnboardingWizard
            uid={currentUser.uid}
            firstName={(caregiverProfile as any)?.firstName || currentUser.displayName?.split(' ')[0] || ''}
            onComplete={() => navigate('/care-provider/dashboard', { replace: true })}
            onShowToast={addToast}
          />
        </Suspense>
      )}
    </>
  );
};

// Auth-only wrapper for /care-provider/connect — no eviaConnected check (avoids redirect loop)
const CaregiverAuthRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { currentUser, authResolved } = useCareConnex();
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!currentUser) return <Navigate to="/login" replace />;
  if (currentUser.userType === 'client') return <Navigate to="/client/dashboard" replace />;
  if (currentUser.eviaConnected) return <Navigate to="/care-provider/dashboard" replace />;
  return element;
};

const AdminRoute: React.FC<{ element: React.ReactElement }> = ({ element }) => {
  const { authResolved, currentUser, adminUser, actingFor, stopActing } = useCareConnex();
  // While acting for a person, currentUser is that person; the admin is adminUser. Admin pages are
  // never shown in the acting view: landing here ends it (the person's consent window stays open,
  // so "Open their pages" on their strip picks it back up).
  useEffect(() => { if (actingFor) stopActing(); }, [actingFor, stopActing]);
  const me = adminUser ?? currentUser;
  if (!authResolved) return <PageLoader fullScreen message="Loading..." />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.userType !== 'admin') return <Navigate to="/" replace />;
  return element;
};

const AppContent: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    isLoading, authResolved, authRecovery, retryAuth, signOutFromRecovery,
    toasts, removeToast, addToast, currentUser, membershipModalOpen, setMembershipModalOpen,
  } = useCareConnex();

  const [viewingCaregiver, setViewingCaregiver] = useState<any>(null);

  // Handle caregiver selection from callout modal
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
      case 'client-signup': navigate('/client/signup'); break;
      // Phone-OTP is the only login; legacy view names are aliases to /login.
      case 'login':
      case 'client-login':
      case 'caregiver-login':
      case 'forgot-password-client':
      case 'forgot-password-caregiver': navigate('/login'); break;
      case 'client-intake': navigate('/client/dashboard'); break;
      case 'caregiver-signup': navigate('/care-provider/signup'); break;
      case 'client-apply': navigate('/start?role=client'); break;
      case 'caregiver-apply': navigate('/start?role=care-provider'); break;
      case 'client': navigate('/client/dashboard'); break;
      case 'client-inbox': navigate('/client/inbox'); break;
      case 'care-plan': navigate('/client/care-plan'); break;
      case 'caregiver': navigate('/care-provider/dashboard'); break;
      case 'caregiver-profile': navigate('/care-provider/profile'); break;
      case 'caregiver-inbox': navigate('/care-provider/inbox'); break;
      case 'caregiver-calendar': navigate('/care-provider/calendar'); break;
      case 'caregiver-membership': setMembershipModalOpen(true); break;
      case 'caregiver-jobs': navigate('/care-provider/jobs'); break;
      case 'caregiver-bookings': navigate('/care-provider/bookings'); break;
      case 'caregiver-families': navigate('/care-provider/families'); break;
      case 'caregiver-settings': navigate('/care-provider/settings'); break;
      case 'caregiver-transactions': navigate('/care-provider/payments'); break;
      case 'caregiver-payout': navigate('/care-provider/payments?tab=payouts'); break;
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
    path.startsWith('/care-provider') ||
    (path.includes('care-plan') && isCaregiverContext)
  );

  const activeColor = isClientFlow ? 'text-teal-600' : 'text-orange-500';

  // /start and /login run their own sign-in and never need the resolved
  // profile — the signup step must stay on screen while the account record is
  // still being created (2026-09-26), so neither the connecting spinner nor
  // the recovery screen may replace them.
  const isSelfServingAuthPage = path === '/start' || path === '/login';

  if (!authResolved && !isSelfServingAuthPage) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[var(--color-neutral-50)]">
        <Loader2 className="w-10 h-10 text-[var(--color-primary-600)] animate-spin mb-4" />
        <p className="text-[var(--color-neutral-500)] font-medium">Connecting to secure server...</p>
      </div>
    );
  }

  if (authRecovery && !isSelfServingAuthPage) {
    return (
      <main className="min-h-screen bg-paper-50 flex items-center justify-center px-6">
        <section className="w-full max-w-md text-center" role="alert" aria-live="assertive">
          <AlertTriangle className="w-10 h-10 text-amber-600 mx-auto mb-4" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-ink-900">Account connection problem</h1>
          <p className="mt-2 text-sm text-ink-600">{authRecovery.message}</p>
          <div className="mt-6 flex flex-col sm:flex-row justify-center gap-3">
            <button type="button" onClick={retryAuth} className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-md bg-ink-900 text-white font-medium">
              <RefreshCw className="w-4 h-4" aria-hidden="true" /> Retry
            </button>
            <button type="button" onClick={() => void signOutFromRecovery()} className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-md border border-ink-300 text-ink-800 font-medium">
              <LogOut className="w-4 h-4" aria-hidden="true" /> Sign out
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-neutral-50)] font-sans relative">
      <ToastContainer toasts={toasts} removeToast={removeToast} />
      <ActingBanner />

      <Suspense fallback={<PageLoader fullScreen message="Loading page..." />}>
        <Routes>
          <Route path="/" element={<PublicOnlyRoute element={<LandingView onNavigate={handleNavigation} />} />} />
          <Route path="/login" element={<PublicOnlyRoute element={<AuthLoginPage />} />} />
          <Route path="/auth/login" element={<Navigate to="/login" replace />} />
          <Route path="/start"              element={<PhoneSignupPage />} />
          <Route path="/upload/:type"        element={<UploadPage />} />
          {/* SPA-served aliases: v1-uploadPageMeta redirects here if it can't
              fetch index.html (avoids re-entering the OG rewrites). */}
          <Route path="/upload-direct/:type" element={<UploadPage />} />
          <Route path="/bgcheck"            element={<BgcheckConsentPage />} />
          <Route path="/bgcheck-direct"     element={<BgcheckConsentPage />} />
          <Route path="/done"               element={<GenericSuccessPage />} />
          {/* Signup routes redirect into the unified phone-first onboarding at /start.
              The role= query param selects between the senior-friendly family mode and
              the leaner caregiver mode. See components/auth/onboarding/OnboardingFlow.tsx. */}
          <Route path="/client/signup" element={<Navigate to="/start?role=client" replace />} />
          {/* Legacy email/password auth routes — phone OTP at /login is the only login */}
          <Route path="/client/login" element={<Navigate to="/login" replace />} />
          <Route path="/client/intake" element={<Navigate to="/client/dashboard" replace />} />
          {/* "Trouble signing in?" on /login — one page for both roles, since login
              here is phone-OTP only and the recovery flow behind it checks both
              users/ and caregivers/ by email. */}
          <Route path="/client/forgot-password" element={<RequestAccountRecoveryPage />} />

          <Route path="/care-provider/signup" element={<Navigate to="/start?role=care-provider" replace />} />
          <Route path="/client/apply" element={<Navigate to="/start?role=client" replace />} />
          <Route path="/care-provider/apply-web" element={<Navigate to="/start?role=care-provider" replace />} />
          {/* Web caregiver signup retired — Evia SMS (/start) is the canonical onboarding. Redirect preserves any existing bookmarks/links. */}
          <Route path="/care-provider/apply" element={<Navigate to="/start?role=care-provider" replace />} />
          <Route path="/care-provider/login" element={<Navigate to="/login" replace />} />
          <Route path="/care-provider/forgot-password" element={<RequestAccountRecoveryPage />} />
          <Route path="/verify-phone-change" element={<VerifyPhoneChangePage />} />
          <Route path="/verify-email-change" element={<VerifyEmailChangePage />} />
          <Route path="/approve-email-change" element={<ApproveEmailChangePage />} />

          <Route path="/client/connect" element={<ClientAuthRoute element={<ClientConnectPage />} />} />
          <Route path="/care-provider/connect" element={<CaregiverAuthRoute element={<CaregiverConnectPage />} />} />
          <Route path="/client/dashboard" element={<ClientRoute element={<ClientDashboard onNavigate={handleNavigation} />} />} />
          <Route path="/client/account" element={<ClientRoute element={<AccountSettings />} />} />
          <Route path="/client/payments" element={<ClientRoute element={<Payments />} />} />
          <Route path="/client/my-care-team" element={<ClientRoute element={<MyCareTeam />} />} />
          <Route path="/client/find-care-providers" element={<ClientRoute element={<FindCaregivers />} />} />
          {/* Old /client/find-caregivers address (bells written before 2026-10-12, bookmarks) → the same page. */}
          <Route path="/client/find-caregivers" element={<LegacyClientCaregiverRedirect />} />
          <Route path="/client/post-job" element={<ClientRoute element={<PostJobFlow />} />} />
          <Route path="/client/posts" element={<ClientRoute element={<PostsPage />} />} />
          <Route path="/client/membership" element={<ClientRoute element={<Membership />} />} />
          <Route path="/client/calendar" element={<ClientRoute element={<Schedule />} />} />
          <Route path="/client/schedule" element={<Navigate to="/client/calendar" replace />} />
          <Route path="/client/bookings" element={<ClientRoute element={<ClientVisitsPage />} />} />
          <Route path="/client/visits" element={<Navigate to="/client/bookings" replace />} />
          <Route path="/client/interviews" element={<Navigate to="/client/posts" replace />} />
          <Route path="/client/hire/:caregiverId" element={<Navigate to="/client/posts" replace />} />
          <Route path="/client/care-provider/:caregiverId" element={<ClientRoute element={<ClientCaregiverProfile />} />} />
          {/* Old /client/caregiver/:id address (review_prompt bells with ?review=1, links Evia texted) → the same page, query intact. */}
          <Route path="/client/caregiver" element={<LegacyClientCaregiverRedirect />} />
          <Route path="/client/caregiver/*" element={<LegacyClientCaregiverRedirect />} />
          {/* Public on purpose: SMS-originated clients return here from Stripe Identity
              without a web session. The component already handles the no-auth case
              (waits for the webhook). Gating it behind ClientRoute bounced them to login. */}
          <Route path="/client/identity-callback" element={<IdentityCallback />} />
          <Route path="/client/inbox" element={<ClientRoute element={<InboxView
            userType="client"
            onNavigate={handleNavigation}
            onShowToast={addToast}
            onViewProfile={(caregiverId) => {
              navigate(`/client/care-provider/${caregiverId}`);
            }}
          />} />} />

          <Route path="/care-provider/dashboard" element={<CaregiverRoute element={<CaregiverDashboard onNavigate={handleNavigation} />} />} />
          <Route path="/care-provider/profile" element={<CaregiverRoute element={<CaregiverProfile onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/care-provider/inbox" element={<CaregiverRoute element={<InboxView userType="caregiver" onNavigate={handleNavigation} onShowToast={addToast} />} />} />
          <Route path="/care-provider/calendar" element={<CaregiverRoute element={<CaregiverCalendarPage onNavigate={handleNavigation} />} />} />
          <Route path="/care-provider/membership" element={<CaregiverRoute element={<Navigate to="/care-provider/dashboard" replace />} />} />
          <Route path="/care-provider/bookings" element={<CaregiverRoute element={<CaregiverBookingsPage />} />} />
          <Route path="/care-provider/jobs" element={<CaregiverRoute element={<CaregiverJobBoardPage />} />} />
          <Route path="/care-provider/families" element={<CaregiverRoute element={<CaregiverFamiliesPage />} />} />
          <Route path="/care-provider/settings" element={<CaregiverRoute element={<CaregiverAccountSettings />} />} />
          <Route path="/care-provider/payments" element={<CaregiverRoute element={<CaregiverPaymentsPage />} />} />
          {/* Legacy payout pages (2026-10-01): ONE Payouts surface — Payments › Payouts. Stripe's onboarding return
              (?stripe=success / refresh) lands here too; the query string is carried over. */}
          <Route path="/care-provider/transactions" element={<Navigate to={`/care-provider/payments?tab=payouts${window.location.search ? '&' + window.location.search.slice(1) : ''}`} replace />} />
          <Route path="/care-provider/payout" element={<Navigate to={`/care-provider/payments?tab=payouts${window.location.search ? '&' + window.location.search.slice(1) : ''}`} replace />} />
          {/* Public shareable caregiver profile. /p/:id is the canonical share
              path — hosting rewrites it through v1-caregiverProfileMeta so texted
              links get per-caregiver OG previews; /care-provider/:id (and the old /caregiver/:id,
              via the redirect below) kept for old links. */}
          <Route path="/p/:id" element={<PublicCaregiverProfile />} />
          <Route path="/care-provider/:id" element={<PublicCaregiverProfile />} />
          {/* Old /caregiver/… addresses (links Evia texted, bookmarks, bells written before
              2026-10-12) → the same page under /care-provider/, query string intact. */}
          <Route path="/caregiver" element={<LegacyCaregiverRedirect />} />
          <Route path="/caregiver/*" element={<LegacyCaregiverRedirect />} />

          <Route path="/client/care-plan" element={
            <CarePlan
              onNavigate={(view) => {
                // Smart back navigation
                if (viewingClientId) {
                  setViewingClientId(null);
                  navigate('/care-provider/dashboard');
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
          <Route path="/terms" element={<TermsOfServicePage />} />
          <Route path="/privacy" element={<PrivacyPolicyPage />} />
          <Route path="/stripe/callback" element={<StripeCallback onNavigate={handleNavigation} />} />
          <Route path="/payment/success" element={<PaymentSuccess onNavigate={handleNavigation} />} />
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

      {/* Caregiver Membership Modal */}
      {membershipModalOpen && (
        <Suspense fallback={null}>
          <CaregiverMembership
            onNavigate={handleNavigation}
            onShowToast={addToast}
            onClose={() => setMembershipModalOpen(false)}
          />
        </Suspense>
      )}


    </div>
  );
};

const App: React.FC = () => {
  return (
    <PasswordGate>
      <ErrorBoundary>
        <CareConnexProvider>
          <AppContent />
        </CareConnexProvider>
      </ErrorBoundary>
    </PasswordGate>
  );
};

export default App;
