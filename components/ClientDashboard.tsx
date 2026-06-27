
import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, Star, User, MessageSquare, Loader2, CheckCircle, MapPin, CreditCard, HelpCircle, Sparkles, Check, XCircle, Shield, Clock, Heart, TrendingUp } from 'lucide-react';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { BookingModal } from './BookingModal';
import { AiSearchAgent } from './AiSearchAgent';
import { SimpleSearchWizard } from './SimpleSearchWizard';
import { ReviewModal } from './ReviewModal';
import { SupportModal } from './SupportModal';
import { CancellationModal } from './CancellationModal';
import { AddToastFunction, Appointment, Caregiver, ViewType, VideoInterview } from '../types';
import { useSmartMatch } from '../hooks/useSmartMatch';
import { dbService, authService } from '../services/api';
import { useCareConnex } from '../context/CareConnexContext';
import { useAccessGates } from '../hooks/useAccessGates';
import { CreditCardBadge } from './shared/CreditCardBadge';

// New Components
import { DashboardHeader } from './dashboard/DashboardHeader';
import { AiCommandCenter } from './dashboard/AiCommandCenter';
import { CareCalendar } from './dashboard/CareCalendar';
import { ClientMatchingView } from './client/ClientMatchingView';
import { CaregiverSearch } from './client/CaregiverSearch';
import { StaggerContainer, MotionItem } from './ui/Motion';
import { CardSkeleton } from './ui/Skeleton';

// Video Interview Components
import { ScheduleInterviewModal } from './ScheduleInterviewModal';
import { VideoInterviewRoom } from './VideoInterviewRoom';
import { InterviewHistory } from './dashboard/InterviewHistory';
import { CallSupportButton, CallSupportCard } from './CallSupport';
import { CaregiverProfileModal } from './CaregiverProfileModal';

// Family Command Center Components
import { MatchScore } from '../types';

// Phase 1 Components
import { LiveCareUpdates } from './LiveCareUpdates';

// Phase 2 Components
import { CareTeam } from './family/CareTeam';
import { MediaGallery } from './family/MediaGallery';
import { SmartCarePlan } from './family/SmartCarePlan';

// Referral Program
import { ReferralProgram } from './referral/ReferralProgram';

// Job Posting Wizard (shown once after signup)
import { ClientJobPostingWizard } from './client/ClientJobPostingWizard';

// AI Matching
import { MatchScoreBadge, MatchIndicator } from './ai/MatchScoreBadge';
import { calculateMLMatchScore, sortByMLMatchScore } from '../services/mlMatchScoring';

// Notifications
import { NotificationBell } from './NotificationBell';

interface ClientDashboardProps {
   onNavigate: (view: ViewType, data?: any) => void;
}

export const ClientDashboard: React.FC<ClientDashboardProps> = ({ onNavigate }) => {
   const {
      currentUser: contextUser,
      appointments,
      caregivers,
      bookAppointment: onBook,
      submitReview: onReview,
      addToast: onShowToast
   } = useCareConnex();
   const [selectedCaregiver, setSelectedCaregiver] = useState<Caregiver | null>(null);
   const [viewingCaregiver, setViewingCaregiver] = useState<Caregiver | null>(null);
   const [isAiAgentOpen, setIsAiAgentOpen] = useState(false);
   const [isSimpleSearchOpen, setIsSimpleSearchOpen] = useState(false);
   const [initialQuery, setInitialQuery] = useState('');



   // Chat Loading State
   const [creatingThreadId, setCreatingThreadId] = useState<number | null>(null);

   // Modals State
   const [reviewModalOpen, setReviewModalOpen] = useState(false);
   const [reviewTarget, setReviewTarget] = useState<{ id: string, name: string, caregiverId: string } | null>(null);
   const [supportModalOpen, setSupportModalOpen] = useState(false);
   const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);
   const [viewingAppointment, setViewingAppointment] = useState<Appointment | null>(null);

   // Video Interview State
   const [scheduleInterviewCaregiver, setScheduleInterviewCaregiver] = useState<Caregiver | null>(null);
   const [activeInterview, setActiveInterview] = useState<VideoInterview | null>(null);

   // Referral Program State
   const [isReferralOpen, setIsReferralOpen] = useState(false);

   // Job Posting Wizard – show once after signup
   const [showWizard, setShowWizard] = useState(false);

   useEffect(() => {
      // Synchronous check first: new signups set this flag before navigating here
      const fromSignup = sessionStorage.getItem('careconnex_show_wizard') === 'true';
      if (fromSignup) {
         sessionStorage.removeItem('careconnex_show_wizard');
         setShowWizard(true);
         return;
      }
      // Fallback: returning users who never finished the wizard
      if (!contextUser?.uid) return;
      dbService.getUser(contextUser.uid)
         .then(userData => {
            if (!(userData as any)?.jobPostingCompleted) setShowWizard(true);
         })
         .catch(() => {});
   }, [contextUser?.uid]);

   // Smart Match Hook
   const { matches: matchedCaregivers, loading: matchLoading, seniorProfile } = useSmartMatch();

   // Access gates (identity + membership checks)
   const { gate, Modals: GateModals } = useAccessGates();

   // Scalable "Browse All" State
   const [browseList, setBrowseList] = useState<Caregiver[]>([]);
   const [lastDoc, setLastDoc] = useState<any>(null);
   const [browseLoading, setBrowseLoading] = useState(false);
   const [hasMore, setHasMore] = useState(true);

   // Senior-friendly: Show/hide advanced features
   const [showAdvancedFeatures, setShowAdvancedFeatures] = useState(false);

   // AI Matching - Match Scores (calculated via useMemo below)

   // Calculate match scores with useMemo - expensive calculation
   const matchScores = useMemo(() => {
      if (!seniorProfile || caregivers.length === 0) return {};

      const scores: Record<string, MatchScore> = {};
      for (const caregiver of caregivers) {
         const score = calculateMLMatchScore(caregiver, seniorProfile, appointments);
         scores[caregiver.id] = score;
      }
      return scores;
   }, [caregivers, seniorProfile, appointments]);

   // Initial Load for Browse List
   useEffect(() => {
      let isMounted = true;
      
      const loadInitial = async () => {
         try {
            if (browseLoading || !isMounted) return;
            setBrowseLoading(true);
            const { caregivers: newBatch, lastDoc: newLast } = await dbService.getCaregivers(4, null);
            
            if (!isMounted) return;
            
            if (newBatch.length < 4) setHasMore(false);
            if (newBatch.length > 0) {
               setBrowseList(newBatch);
               setLastDoc(newLast);
            } else {
               setHasMore(false);
            }
         } catch (e: any) {
            console.error("Browse load failed", e);
            if (isMounted) {
               onShowToast?.(e.message || "Failed to load caregivers. Please try again.", 'error');
            }
         } finally {
            if (isMounted) setBrowseLoading(false);
         }
      };
      
      loadInitial();
      
      return () => { isMounted = false; };
   }, []);

   const loadMoreCaregivers = useCallback(async () => {
      if (browseLoading) return;
      setBrowseLoading(true);
      try {
         const { caregivers: newBatch, lastDoc: newLast } = await dbService.getCaregivers(4, lastDoc);

         if (newBatch.length < 4) setHasMore(false);
         if (newBatch.length > 0) {
            // Filter duplicates just in case
            setBrowseList(prev => {
               const ids = new Set(prev.map(c => c.id));
               const uniqueNew = newBatch.filter(c => !ids.has(c.id));
               return [...prev, ...uniqueNew];
            });
            setLastDoc(newLast);
         } else {
            setHasMore(false);
         }
      } catch (e: any) {
         console.error("Browse load failed", e);
         onShowToast?.(e.message || "Failed to load caregivers. Please try again.", 'error');
      } finally {
         setBrowseLoading(false);
      }
   }, [browseLoading, lastDoc, onShowToast]);

   // Memoized derived state
   const unpaidAppointments = useMemo(() => 
      appointments.filter(a => a.paymentStatus === 'pending' && a.status !== 'cancelled'),
   [appointments]);

   const handleBookingConfirm = useCallback(async (appt: Appointment) => {
      // If this is a recurring booking, create all appointments in the series
      if (appt.isRecurring && appt.recurringGroupId) {
         const appointments: Appointment[] = [];
         const startDate = new Date(appt.isoDate);
         const endDate = new Date(appt.recurringEndDate || '');
         const recurringGroupId = appt.recurringGroupId;
         
         let currentDate = new Date(startDate);
         let appointmentCount = 0;
         
         while (currentDate <= endDate && appointmentCount < 52) { // Max 1 year weekly
            const dateStr = currentDate.toISOString().split('T')[0];
            const displayDate = currentDate.toLocaleDateString('en-US', { 
               weekday: 'short', 
               month: 'short', 
               day: 'numeric' 
            });
            
            appointments.push({
               ...appt,
               id: Math.random().toString(36).substr(2, 9),
               date: displayDate,
               isoDate: dateStr,
               recurringGroupId,
               isRecurring: true
            });
            
            // Advance to next date based on frequency
            switch (appt.recurringFrequency) {
               case 'weekly':
                  currentDate.setDate(currentDate.getDate() + 7);
                  break;
               case 'biweekly':
                  currentDate.setDate(currentDate.getDate() + 14);
                  break;
               case 'monthly':
                  currentDate.setMonth(currentDate.getMonth() + 1);
                  break;
            }
            
            appointmentCount++;
         }
         
         // Create all appointments
         for (const appointment of appointments) {
            await onBook(appointment);
         }
         
         onShowToast(`${appointments.length} recurring appointments booked! You'll be billed after each service.`, 'success');
      } else {
         // Single appointment
         onBook(appt);
         onShowToast("Appointment confirmed! You'll be billed after service.", 'success');
      }
      
      setSelectedCaregiver(null);
   }, [onBook, onShowToast]);

   const stashPaymentId = useCallback((apptId: string) => {
      localStorage.setItem('payingAppointmentId', apptId);
   }, []);

   const handleReviewClick = useCallback((appt: Appointment) => {
      setReviewTarget({ id: appt.id, name: appt.caregiverName, caregiverId: appt.caregiverId });
      setReviewModalOpen(true);
   }, []);

   const submitReview = useCallback(async (rating: number, comment: string) => {
      if (!reviewTarget) return;
      try {
         // Use current logged in user name
         const user = authService.getCurrentUser();
         await dbService.submitReview({
            id: Date.now().toString(),
            caregiverId: reviewTarget.caregiverId,
            clientName: user?.displayName || "Client",
            rating,
            comment,
            date: new Date().toISOString()
         });

         await dbService.markAppointmentReviewed(reviewTarget.id);

         if (onReview) {
            onReview(reviewTarget.id);
         }

         onShowToast("Review submitted successfully!", 'success');
      } catch (e) {
         onShowToast("Failed to submit review", 'error');
      }
   }, [reviewTarget, onReview, onShowToast]);

   const handleChatClick = useCallback(async (caregiver: Caregiver) => {
      console.log('📝 [Chat] Starting chat with caregiver:', caregiver.id);
      setCreatingThreadId(Number(caregiver.id));
      try {
         const currentUser = authService.getCurrentUser();
         console.log('👤 [Chat] Current user:', currentUser?.uid);
         
         if (!currentUser) {
            console.error('❌ [Chat] User not authenticated');
            onShowToast("Please sign in to message", "error");
            return;
         }
         
         console.log('📨 [Chat] Creating thread...');
         const safeAvatar = caregiver.imageUrl || caregiver.photo || '';
         console.log('🖼️ [Chat] Using avatar:', safeAvatar ? 'Provided' : 'Default');
         const threadId = await dbService.createThread(
            caregiver.id.toString(),
            caregiver.name || 'Unknown Caregiver',
            safeAvatar
         );
         console.log('✅ [Chat] Thread created:', threadId);
         
         console.log('🧭 [Chat] Navigating to client-inbox...');
         onNavigate('client-inbox');
      } catch (e: any) {
         console.error('❌ [Chat] Failed:', e);
         console.error('Error message:', e.message);
         console.error('Error code:', e.code);
         onShowToast(`Could not start chat: ${e.message || 'Unknown error'}`, "error");
      } finally {
         setCreatingThreadId(null);
      }
   }, [onNavigate, onShowToast]);

   const handleGatedBook = useCallback((caregiver: Caregiver) => {
      gate('booking', caregiver.name, () => setSelectedCaregiver(caregiver));
   }, [gate]);

   const handleGatedMessage = useCallback((caregiver: Caregiver) => {
      gate('message', caregiver.name, () => handleChatClick(caregiver));
   }, [gate, handleChatClick]);

   const handleViewAppointment = useCallback((appt: Appointment) => {
      setViewingAppointment(appt);
   }, []);

   const handleMessageFromAppointment = useCallback(async (caregiverId: string, caregiverName: string) => {
      setCreatingThreadId(Number(caregiverId));
      try {
         // Find caregiver to get their image
         const caregiver = caregivers.find(c => c.id.toString() === caregiverId);
         await dbService.createThread(
            caregiverId,
            caregiverName,
            caregiver?.imageUrl || ''
         );
         onNavigate('client-inbox');
      } catch (e) {
         onShowToast("Could not start chat", "error");
      } finally {
         setCreatingThreadId(null);
      }
   }, [caregivers, onNavigate, onShowToast]);

   const currentUser = authService.getCurrentUser();

   const handleExpressBooking = useCallback(() => {
      onNavigate('express-booking');
   }, [onNavigate]);

   return (
      <>
      {showWizard && contextUser?.uid && (
         <ClientJobPostingWizard uid={contextUser.uid} onComplete={() => setShowWizard(false)} />
      )}
      <div className="max-w-7xl mx-auto p-4 md:p-6 pb-24 animate-slide-in relative">
         <div className="flex items-center justify-between mb-4">
            <div className="flex-1">
               <DashboardHeader
                  onShowToast={onShowToast}
                  onNavigateProfile={() => onNavigate('client-profile')}
                  onOpenReferral={() => setIsReferralOpen(true)}
                  userName={currentUser?.displayName || 'Client'}
               />
            </div>
            {currentUser?.uid && (
               <NotificationBell
                  userId={currentUser.uid}
                  onNotificationClick={(notification) => {
                     if (notification.entryId) {
                        // Scroll to daily summary or navigate to detailed view
                        onShowToast('Opening care update...', 'info');
                     }
                  }}
               />
            )}
         </div>

         <AiCommandCenter
            onSearch={(query) => {
               setIsSimpleSearchOpen(true);
            }}
            onShowToast={onShowToast}
         />

         {/* Caregiver Search */}
         <div className="mb-8">
            <CaregiverSearch
               onSelectCaregiver={(caregiver) => {
                  setViewingCaregiver(caregiver);
               }}
               onShowToast={onShowToast}
            />
         </div>


         {/* Phase 1: Live Care Updates - Real-time visibility during today's shifts only */}
         {(() => {
            const today = new Date().toLocaleDateString('en-CA');
            const todaysActiveAppointments = appointments.filter(a => 
               (a.status === 'in-progress' || a.status === 'confirmed') && 
               a.date === today
            );
            return todaysActiveAppointments.length > 0 && (
               <div className="mb-8">
                  <LiveCareUpdates 
                     appointmentId={todaysActiveAppointments[0]?.id || ''}
                     clientId={currentUser?.uid || ''}
                  />
               </div>
            );
         })()}

         {/* Phase 2: Care Team - Dedicated caregiver team for continuity */}
         {currentUser?.uid && (
            <div className="mb-8">
               <CareTeam 
                  clientId={currentUser.uid} 
                  appointments={appointments}
                  seniorName={seniorProfile?.name}
                  onBookCaregiver={setSelectedCaregiver}
                  onQuickRebook={(caregiverId, date, time) => {
                     // Find caregiver and open booking modal with pre-filled details
                     const caregiver = caregivers.find(c => c.id === caregiverId);
                     if (caregiver) {
                        // Store suggested time for BookingModal to use
                        (caregiver as any).suggestedDate = date;
                        (caregiver as any).suggestedTime = time;
                        setSelectedCaregiver(caregiver);
                     }
                  }}
               />
            </div>
         )}

         {/* Phase 2: Media Gallery - Photos and videos from caregivers - TEMPORARILY DISABLED */}
         {/* {currentUser?.uid && (
            <div className="mb-8">
               <MediaGallery
                  clientId={currentUser.uid}
                  onShowToast={onShowToast}
               />
            </div>
         )} */}

         {/* Phase 2: Smart Care Plan - Enhanced digital care plan */}
         {currentUser?.uid && (
            <div className="mb-8">
               <SmartCarePlan
                  clientId={currentUser.uid}
                  onShowToast={onShowToast}
                  editable={true}
               />
            </div>
         )}

         {/* Care Coordinator Matching View */}
         {currentUser?.uid && (
            <div className="mb-8">
               <ClientMatchingView
                  clientId={currentUser.uid}
                  seniorId={currentUser.uid}
                  onShowToast={onShowToast}
               />
            </div>
         )}

         {/* Video Interview History - Advanced Feature */}
         {showAdvancedFeatures && (
            <div className="mb-8">
               <InterviewHistory
                  userType="client"
                  onJoinInterview={setActiveInterview}
                  onShowToast={onShowToast}
               />
            </div>
         )}

         <CareCalendar
            appointments={appointments}
            onCancelAppointment={setCancelTarget}
            onReviewAppointment={handleReviewClick}
            onShowToast={onShowToast}
            onViewAppointment={handleViewAppointment}
            onMessageCaregiver={handleMessageFromAppointment}
         />

         {/* Empty State - Helpful for new users */}
         {appointments.length === 0 && browseList.length === 0 && !matchLoading && (
            <div className="mb-12">
               <CallSupportCard />
            </div>
         )}

         {/* Browse Caregivers - Always visible for easy discovery */}
         <div className="mb-8">
            <h3 className="text-2xl font-bold text-slate-900 mb-6 flex items-center">
               <User className="w-6 h-6 mr-3 text-primary-600" /> Explore All Caregivers
            </h3>

            <StaggerContainer className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
               {browseList.map((caregiver) => (
                  <MotionItem key={`browse-${caregiver.id}`} className="bg-white rounded-[1.5rem] border border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col relative">
                     {/* Favorite button */}
                     <button
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-4 right-4 p-2 bg-white/80 hover:bg-slate-50 backdrop-blur-sm rounded-full shadow-sm z-10 transition-colors"
                        aria-label="Add to favorites"
                     >
                        <Heart className="w-5 h-5 text-slate-400 hover:text-red-400 transition-colors" />
                     </button>

                     {/* Clickable profile area */}
                     <div
                        className="p-5 flex-1 flex flex-col cursor-pointer group"
                        onClick={() => setViewingCaregiver(caregiver)}
                     >
                        {/* Photo + name + badges */}
                        <div className="flex items-start gap-4 mb-5">
                           <div className="w-20 h-20 rounded-full bg-slate-200 overflow-hidden flex items-center justify-center flex-shrink-0 shadow-inner group-hover:ring-4 ring-primary-50 transition-all">
                              {caregiver.imageUrl || (caregiver as any).photo ? (
                                 <img src={caregiver.imageUrl || (caregiver as any).photo} alt={caregiver.name} className="w-full h-full object-cover" />
                              ) : (
                                 <span className="text-2xl font-bold text-slate-400">
                                    {caregiver.name.split(' ').map((p: string) => p[0]).slice(0, 2).join('').toUpperCase()}
                                 </span>
                              )}
                           </div>

                           <div className="flex-1 min-w-0 pt-1 pr-10">
                              <h3 className="text-[22px] font-bold text-slate-900 group-hover:text-primary-600 transition-colors truncate mb-1 leading-tight">{caregiver.name}</h3>

                              {/* Stars */}
                              <div className="flex items-center gap-0.5 mb-2.5">
                                 {[...Array(5)].map((_, i) => (
                                    <Star key={i} className={`w-[18px] h-[18px] ${i < Math.floor(caregiver.rating || 0) ? 'text-teal-500 fill-current' : 'text-slate-200'}`} />
                                 ))}
                                 <span className="text-sm font-medium text-slate-500 ml-1.5">({(caregiver as any).reviewCount || 0})</span>
                              </div>

                              <CreditCardBadge show={!!(caregiver as any).acceptsCreditCards} />

                              {/* BGC badge — only shown when cleared */}
                              {(caregiver as any).backgroundCheckStatus === 'clear' && (
                                <div className="flex items-center gap-2 mt-1.5">
                                  <div className="w-9 h-9 rounded-full bg-blue-500 flex flex-col items-center justify-center text-white pt-1" title="Background Check Cleared">
                                    <CheckCircle className="w-4 h-4 mb-0.5" />
                                    <span className="text-[7px] font-bold leading-none tracking-wider uppercase">BGC+</span>
                                  </div>
                                </div>
                              )}
                           </div>
                        </div>

                        {/* Experience + distance */}
                        <div className="space-y-3.5 mb-5 mt-1">
                           <div className="flex items-center gap-3.5 text-slate-700">
                              <Heart className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
                              <span className="text-[17px]">{(caregiver as any).experience || 0} years experience</span>
                           </div>
                           <div className="flex items-center gap-3.5 text-slate-700">
                              <MapPin className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
                              <span className="text-[17px]">{caregiver.distance} miles</span>
                           </div>
                        </div>

                        {/* Skills pills */}
                        {caregiver.skills && caregiver.skills.length > 0 ? (
                           <div className="flex flex-wrap gap-2 mb-6 mt-1">
                              {caregiver.skills.slice(0, 3).map((skill: string) => (
                                 <span key={skill} className="px-3.5 py-1.5 bg-slate-100 border border-slate-200 text-slate-800 text-[13px] font-medium rounded-[1rem]">
                                    {skill}
                                 </span>
                              ))}
                           </div>
                        ) : (
                           <div className="mb-6 mt-1" />
                        )}

                        {/* Stats footer */}
                        <div className="border-t border-slate-200 pt-4 pb-2 flex items-center justify-between mt-auto">
                           <div className="flex-1 text-center border-r border-slate-200 pr-2 pb-1">
                              <div className="flex items-center justify-center gap-1.5 text-slate-500 mb-1">
                                 <MessageSquare className="w-3.5 h-3.5" />
                                 <span className="text-[10px] font-bold uppercase tracking-[0.08em]">Responds in</span>
                              </div>
                              <p className="text-[16px] text-slate-900 tracking-tight">30 minutes</p>
                           </div>
                           <div className="flex-1 text-center pl-2 pb-1">
                              <div className="flex items-center justify-center gap-1.5 text-slate-500 mb-1">
                                 <Clock className="w-3.5 h-3.5" />
                                 <span className="text-[10px] font-bold uppercase tracking-[0.08em]">Last Login</span>
                              </div>
                              <p className="text-[16px] text-slate-900 tracking-tight">Online now</p>
                           </div>
                        </div>
                     </div>

                     {/* Action buttons */}
                     <div className="bg-slate-50 border-t border-slate-100 p-3 grid grid-cols-2 gap-2">
                        <button
                           onClick={(e) => { e.stopPropagation(); handleGatedMessage(caregiver); }}
                           disabled={creatingThreadId === Number(caregiver.id)}
                           className="flex-1 py-2 text-sm font-bold bg-white border-2 border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 hover:border-slate-300 transition-colors inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                        >
                           <MessageSquare className="w-4 h-4" />
                           {creatingThreadId === Number(caregiver.id) ? '...' : 'Message'}
                        </button>
                        <button
                           onClick={(e) => { e.stopPropagation(); handleGatedBook(caregiver); }}
                           className="w-full py-2 text-sm font-bold bg-primary-600 border-2 border-primary-600 text-white rounded-xl hover:bg-primary-700 hover:border-primary-700 transition-colors"
                        >
                           Book
                        </button>
                     </div>
                  </MotionItem>
               ))}


               {/* Skeletons while loading more */}
               {browseLoading && (
                  <>
                     <CardSkeleton />
                     <CardSkeleton />
                     <CardSkeleton />
                     <CardSkeleton />
                  </>
               )}
            </StaggerContainer>

            {hasMore && !browseLoading && (
               <div className="flex justify-center mt-8">
                  <button
                     onClick={loadMoreCaregivers}
                     disabled={browseLoading}
                     className="px-8 py-3.5 bg-white border-2 border-slate-100 text-primary-700 rounded-full font-bold hover:bg-slate-50 transition-all flex items-center shadow-sm disabled:opacity-50"
                  >
                     {browseLoading && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
                     {browseLoading ? 'Loading...' : 'Load More Caregivers'}
                  </button>
               </div>
            )}
         </div>

         {/* Advanced Features Toggle - Video/Interview options only */}
         <div className="mb-8 text-center pt-4">
            <button
               onClick={() => setShowAdvancedFeatures(!showAdvancedFeatures)}
               className="text-primary-600 hover:text-primary-800 font-bold text-sm px-6 py-2.5 border-2 border-primary-100 rounded-full hover:bg-primary-50 transition-colors"
            >
               {showAdvancedFeatures ? 'Hide Advanced Options ▲' : 'More Options ▼'}
            </button>
         </div>

         {/* Support / Help Section */}
         <div className="flex justify-center mb-8">
            <button
               onClick={() => setSupportModalOpen(true)}
               className="text-slate-400 hover:text-slate-600 text-sm flex items-center gap-1 transition-colors"
            >
               <HelpCircle className="w-4 h-4" /> Need help? Report an issue
            </button>
         </div>

         {/* Modals */}

         <GateModals />

         {selectedCaregiver && (
            <BookingModal
               caregiver={selectedCaregiver}
               onClose={() => setSelectedCaregiver(null)}
               onConfirm={handleBookingConfirm}
            />
         )}

         {reviewModalOpen && reviewTarget && (
            <ReviewModal
               caregiverName={reviewTarget.name}
               onClose={() => setReviewModalOpen(false)}
               onSubmit={submitReview}
            />
         )}

         {supportModalOpen && (
            <SupportModal
               onClose={() => setSupportModalOpen(false)}
               onShowToast={onShowToast}
               userType="client"
            />
         )}

         {cancelTarget && (
            <CancellationModal
               appointment={cancelTarget}
               onClose={() => setCancelTarget(null)}
               onSuccess={() => onShowToast('Cancellation processed', 'success')}
               onShowToast={onShowToast}
               cancelledBy="client"
            />
         )}

         {/* Appointment Details Modal */}
         {viewingAppointment && createPortal(
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
               <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-slide-in">
                  <div className="flex justify-between items-center mb-4">
                     <h3 className="text-xl font-bold text-slate-900">Appointment Details</h3>
                     <button 
                        onClick={() => setViewingAppointment(null)}
                        className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                     >
                        ✕
                     </button>
                  </div>
                  
                  <div className="space-y-4">
                     <div className="flex items-center gap-3">
                        <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center">
                           <User className="w-6 h-6 text-primary-600" />
                        </div>
                        <div>
                           <p className="font-semibold text-slate-900">{viewingAppointment.caregiverName}</p>
                           <p className="text-sm text-slate-500">Caregiver</p>
                        </div>
                     </div>
                     
                     <div className="bg-slate-50 p-4 rounded-xl space-y-2">
                        <div className="flex justify-between">
                           <span className="text-slate-500">Date:</span>
                           <span className="font-medium">{viewingAppointment.date}</span>
                        </div>
                        <div className="flex justify-between">
                           <span className="text-slate-500">Time:</span>
                           <span className="font-medium">{viewingAppointment.time}</span>
                        </div>
                        <div className="flex justify-between">
                           <span className="text-slate-500">Status:</span>
                           <Badge variant={viewingAppointment.status === 'confirmed' ? 'success' : viewingAppointment.status === 'completed' ? 'secondary' : 'warning'}>
                              {viewingAppointment.status}
                           </Badge>
                        </div>
                        {viewingAppointment.cost && (
                           <div className="flex justify-between">
                              <span className="text-slate-500">Cost:</span>
                              <span className="font-medium text-primary-600">${viewingAppointment.cost}</span>
                           </div>
                        )}
                        {viewingAppointment.address && (
                           <div className="flex justify-between">
                              <span className="text-slate-500">Location:</span>
                              <span className="font-medium">{viewingAppointment.address}</span>
                           </div>
                        )}
                     </div>
                     
                     {viewingAppointment.notes && (
                        <div className="bg-accent-50 p-3 rounded-lg border border-accent-100">
                           <p className="text-sm text-accent-800">
                              <span className="font-semibold">Notes:</span> {viewingAppointment.notes}
                           </p>
                        </div>
                     )}
                  </div>
                  
                  <div className="mt-6 flex gap-3">
                     <Button 
                        variant="secondary" 
                        fullWidth 
                        onClick={() => setViewingAppointment(null)}
                     >
                        Close
                     </Button>
                     <Button 
                        variant="primary" 
                        fullWidth
                        onClick={() => {
                           setViewingAppointment(null);
                           handleMessageFromAppointment(viewingAppointment.caregiverId, viewingAppointment.caregiverName);
                        }}
                     >
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Message
                     </Button>
                  </div>
               </div>
            </div>
         , document.body)}

         <SimpleSearchWizard
            isOpen={isSimpleSearchOpen}
            onClose={() => setIsSimpleSearchOpen(false)}
            caregivers={caregivers}
            onSelectCaregiver={setSelectedCaregiver}
            onViewProfile={setViewingCaregiver}
            onScheduleInterview={setScheduleInterviewCaregiver}
            seniorProfile={seniorProfile}
         />

         {/* Keep AI Chat as Advanced Option (Hidden by default) */}
         <AiSearchAgent
            isOpen={isAiAgentOpen}
            onClose={() => {
               setIsAiAgentOpen(false);
               setInitialQuery('');
            }}
            caregivers={matchedCaregivers.length > 0 ? matchedCaregivers : caregivers}
            onBookCaregiver={setSelectedCaregiver}
            onViewProfile={setViewingCaregiver}
            onScheduleInterview={setScheduleInterviewCaregiver}
            initialQuery={initialQuery}
            seniorProfile={seniorProfile}
            previousBookings={appointments}
         />

         {/* Video Interview Modals */}
         {scheduleInterviewCaregiver && (
            <ScheduleInterviewModal
               caregiver={scheduleInterviewCaregiver}
               onClose={() => setScheduleInterviewCaregiver(null)}
               onSuccess={(message) => {
                  onShowToast(message, 'success');
                  setScheduleInterviewCaregiver(null);
               }}
               onShowToast={onShowToast}
            />
         )}

         {activeInterview && (
            <VideoInterviewRoom
               interview={activeInterview}
               userId={authService.getCurrentUser()?.uid || ''}
               userName={authService.getCurrentUser()?.displayName || 'Client'}
               onEnd={() => {
                  setActiveInterview(null);
                  onShowToast('Interview ended', 'info');
               }}
               onShowToast={onShowToast}
            />
         )}

         {/* Caregiver Profile Modal */}
         {viewingCaregiver && (
            <CaregiverProfileModal
               caregiver={viewingCaregiver}
               onClose={() => setViewingCaregiver(null)}
               onBookNow={() => {
                  setSelectedCaregiver(viewingCaregiver);
                  setViewingCaregiver(null);
               }}
            />
         )}

         {/* Referral Program Modal */}
         {isReferralOpen && createPortal(
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
               <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                  <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex justify-between items-center">
                     <h2 className="text-xl font-bold">Refer & Earn</h2>
                     <button
                        onClick={() => setIsReferralOpen(false)}
                        className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                     >
                        ✕
                     </button>
                  </div>
                  <ReferralProgram
                     userId={authService.getCurrentUser()?.uid || ''}
                     userType="client"
                     onShowToast={onShowToast}
                  />
               </div>
            </div>
         , document.body)}

         {/* Persistent Call Support Button for Seniors */}
         <CallSupportButton />
      </div>
      </>
   );
};
