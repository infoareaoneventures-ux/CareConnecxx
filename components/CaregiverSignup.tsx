import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Heart, ArrowLeft, ChevronRight, FileText, Upload, CheckCircle, Shield, Play, X, Star, DollarSign, Lock, Calendar, Camera, MapPin } from 'lucide-react';
import { Input } from './ui/Input';
import { LocationInput } from './ui/LocationInput';
import { Button } from './ui/Button';
import { DocumentUpload } from './ui/DocumentUpload';
import { LegalDocs } from './LegalDocs';
import { ViewType, AddToastFunction, CaregiverDocuments } from '../types';
import { authService, dbService } from '../services/api';
import { documentUploadService, DocumentType } from '../services/documentUpload';
import { validators } from '../utils/validation';
import firebase from '../lib/firebase';
import 'firebase/compat/storage';

interface CaregiverSignupProps {
   onNavigate: (view: ViewType) => void;
   onShowToast: AddToastFunction;
}

const TOTAL_STEPS = 10;

export const CaregiverSignup: React.FC<CaregiverSignupProps> = ({ onNavigate, onShowToast }) => {
   const [step, setStep] = useState(1);
   const [isLoading, setIsLoading] = useState(false);
   const [createdUserId, setCreatedUserId] = useState<string | null>(null);

   // Cleanup blob URLs on unmount to prevent memory leaks
   useEffect(() => {
      return () => {
         // Revoke all tracked blob URLs
         blobUrlsRef.current.forEach((url) => {
            URL.revokeObjectURL(url);
         });
         blobUrlsRef.current.clear();
      };
   }, []);

   // Step 1: Basics
   const [basicInfo, setBasicInfo] = useState({
      firstName: '',
      lastName: '',
      email: '',
      password: '',
      phone: '',
      gender: '' as 'Male' | 'Female' | 'Non-binary' | 'Prefer not to say' | ''
   });
   const [acceptedTerms, setAcceptedTerms] = useState(false);
   const [legalModal, setLegalModal] = useState<'privacy' | 'terms' | null>(null);

   // Step 2: Expertise
   const [certs, setCerts] = useState<string[]>([]);
   const [skills, setSkills] = useState<string[]>([]);
   const [bio, setBio] = useState('');

   // Step 3: Logistics
   const [logistics, setLogistics] = useState({
      experience: '',
      rate: '',
      rateFor2: '',
      rateFor3Plus: '',
      hasCar: false,
      location: '',
      latitude: 0,
      longitude: 0
   });

   // Steps 4-6: Documents
   const [documents, setDocuments] = useState<CaregiverDocuments>({});
   const [skipDocuments, setSkipDocuments] = useState(false);

   // Step 9: Profile & Verification
   const [profilePhoto, setProfilePhoto] = useState<{file: File | null; preview: string | null}>({file: null, preview: null});
   const [videoFile, setVideoFile] = useState<File | null>(null);
   const [videoPreview, setVideoPreview] = useState<string | null>(null);
   const [licenseDetails, setLicenseDetails] = useState({
      number: '',
      expirationDate: '',
   });

   // Step 7: Background Check Data
   const [backgroundCheckData, setBackgroundCheckData] = useState({
      ssn: '', // Stores raw digits only (NOT masked display)
      dateOfBirth: '',
      consentToBackgroundCheck: false
   });
   // Secure ref to store full SSN - only used on submit, never persisted to state
   const fullSsnRef = useRef<string>('');
   // Track if SSN field is focused (to show/hide real digits)
   const [ssnFocused, setSsnFocused] = useState(false);
   // Track blob URLs for cleanup
   const blobUrlsRef = useRef<Set<string>>(new Set());

   // Step 8: Weekly Availability — AM/PM/Evening per day
   const [weeklyAvailability, setWeeklyAvailability] = useState<Record<string, string[]>>({
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [],
      saturday: [],
      sunday: []
   });

   // Step 10: Payment Preferences
   const [payVenmo, setPayVenmo] = useState('');
   const [payZelle, setPayZelle] = useState('');
   const [payCash, setPayCash] = useState(false);
   const [payOther, setPayOther] = useState('');
   const [acceptsCreditCards, setAcceptsCreditCards] = useState(true);

   const CERTS_OPTIONS = ["CNA", "HHA", "CPR/First Aid", "RN", "LPN"];
   const SKILLS_OPTIONS = [
      "Alzheimer's/Dementia", "Parkinson's", "Stroke Recovery", "Fall Risk",
      "Hospice Care", "Diabetes", "COPD", "Wheelchair/Mobility",
      "Medication Management", "Post-Surgery Recovery", "Incontinence Care",
      "Feeding Assistance", "Sundowning Behavior", "Transfer/Lifting", "Meal Prep"
   ];

   const toggleSelection = useCallback((item: string, list: string[], setList: (l: string[]) => void) => {
      if (list.includes(item)) setList(list.filter(i => i !== item));
      else setList([...list, item]);
   }, []);

   const toggleSlot = useCallback((day: string, slot: string) => {
      setWeeklyAvailability(prev => ({
         ...prev,
         [day]: prev[day].includes(slot)
            ? prev[day].filter(s => s !== slot)
            : [...prev[day], slot]
      }));
   }, []);

   const handleDocumentUpload = useCallback(async (file: File, type: DocumentType) => {
      // Store file temporarily - will upload after account creation on final submit
      try {
         // Create a temporary object URL for preview
         const tempUrl = URL.createObjectURL(file);
         // Track for cleanup
         blobUrlsRef.current.add(tempUrl);
         
         setDocuments(prev => ({
            ...prev,
            [type]: {
               name: file.name,
               path: tempUrl,
               url: tempUrl,
               type: file.type,
               size: file.size,
               uploadedAt: new Date().toISOString(),
               status: 'approved', // Mark as approved immediately since it's stored locally
               _pendingFile: file // Store actual file for later upload
            }
         }));

         onShowToast(`${documentUploadService.getDocumentTypeName(type)} selected (will upload on submit)`, 'success');
      } catch (error) {
         console.error('Document selection error:', error);
         onShowToast(error instanceof Error ? error.message : 'Failed to select document', 'error');
      }
   }, [onShowToast]);

   const handleDocumentDelete = useCallback(async (type: DocumentType) => {
      try {
         const doc = documents[type];
         // Revoke object URL if it's a pending upload
         if (doc?.path?.startsWith('blob:')) {
            URL.revokeObjectURL(doc.path);
            blobUrlsRef.current.delete(doc.path);
         }

         setDocuments(prev => ({
            ...prev,
            [type]: undefined
         }));

         onShowToast('Document removed', 'info');
      } catch (error) {
         onShowToast('Failed to remove document', 'error');
      }
   }, [documents, onShowToast]);

   const handleNext = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      // Validate Step 1
      if (step === 1) {
         const passwordError = validators.password(basicInfo.password);
         if (passwordError) {
            onShowToast(passwordError, 'error');
            return;
         }
         if (!basicInfo.email || !basicInfo.firstName || !basicInfo.lastName || !basicInfo.phone) {
            onShowToast("Please fill in all fields", 'error');
            return;
         }
         const phoneError = validators.phone(basicInfo.phone);
         if (phoneError) {
            onShowToast(phoneError, 'error');
            return;
         }
         if (!acceptedTerms) {
            onShowToast("You must accept the Terms of Service and Privacy Policy to continue", 'error');
            return;
         }
      }

      // Validate Step 2 (Bio length)
      if (step === 2 && bio.length > 500) {
         onShowToast("Bio must be 500 characters or less", 'error');
         return;
      }

      // Validate Step 6 (Background Check)
      if (step === 6) {
         // Use the ref for validation (source of truth for full SSN)
         const ssnDigits = fullSsnRef.current;
         if (!ssnDigits || ssnDigits.length !== 9 || !backgroundCheckData.dateOfBirth) {
            onShowToast("Please provide complete SSN and Date of Birth", 'error');
            return;
         }
         if (!backgroundCheckData.consentToBackgroundCheck) {
            onShowToast("You must consent to background check to proceed", 'error');
            return;
         }
         // Format for validator (expects XXX-XX-XXXX format)
         const formattedSsn = `${ssnDigits.slice(0, 3)}-${ssnDigits.slice(3, 5)}-${ssnDigits.slice(5)}`;
         const ssnError = validators.ssn(formattedSsn);
         if (ssnError) {
            onShowToast(ssnError, 'error');
            return;
         }
      }

      // Handle step 3 -> validate and proceed (account creation moved to final step)
      if (step === 3) {
         // Just validate and proceed to next step
         setStep(step + 1);
         return;
      }

      // Validate Step 8: Profile & Verification
      if (step === 8) {
         if (!profilePhoto.file) {
            onShowToast("Please upload a profile photo", 'error');
            return;
         }
      }

      if (step < TOTAL_STEPS) {
         setStep(step + 1);
      } else {
         handleSubmit();
      }
   }, [step, basicInfo, logistics, certs, skills, bio, backgroundCheckData, weeklyAvailability, onShowToast, documents, skipDocuments, profilePhoto, licenseDetails]);

   const handleSubmit = useCallback(async () => {
      setIsLoading(true);
      try {
         // Create account with ALL data including secure full SSN
         const result = await authService.signup(
            basicInfo.email,
            basicInfo.password,
            `${basicInfo.firstName} ${basicInfo.lastName}`,
            'caregiver',
            {
               certifications: certs,
               personalityTags: skills,
               experience: parseInt(logistics.experience) || 0,
               hourlyRate: parseInt(logistics.rate) || 25,
               rateForTwo: logistics.rateFor2 ? parseInt(logistics.rateFor2) : undefined,
               rateForThree: logistics.rateFor3Plus ? parseInt(logistics.rateFor3Plus) : undefined,
               hasTransportation: logistics.hasCar,
               location: logistics.location,
               latitude: logistics.latitude,
               longitude: logistics.longitude,
               gender: basicInfo.gender || undefined,
               phone: basicInfo.phone,
               bio: bio,
               verified: false,
               onboardingStep: 2,
               verificationStatus: 'submitted',
               submittedAt: new Date().toISOString(),
               // SECURE: Full SSN only sent on submit, never stored in state
               ssn: fullSsnRef.current,
               dateOfBirth: backgroundCheckData.dateOfBirth,
               consentToBackgroundCheck: backgroundCheckData.consentToBackgroundCheck,
               weeklyAvailability: weeklyAvailability,
               paymentPreferences: {
                  ...(payVenmo.trim() && { venmo: payVenmo.trim() }),
                  ...(payZelle.trim() && { zelle: payZelle.trim() }),
                  cash: payCash,
                  ...(payOther.trim() && { other: payOther.trim() }),
               },
               acceptsCreditCards,
            }
         );

         // Get created user for document uploads
         const user = authService.getCurrentUser();
         if (user?.uid) {
            // Upload profile photo
            if (profilePhoto.file) {
               try {
                  await documentUploadService.uploadDocument(
                     user.uid,
                     profilePhoto.file,
                     'profilePhoto'
                  );
               } catch (uploadError) {
                  console.error('Failed to upload profile photo:', uploadError);
               }
            }

            // Upload video introduction to Firebase Storage
            if (videoFile) {
               try {
                  const storage = firebase.storage();
                  const timestamp = Date.now();
                  const sanitized = videoFile.name.replace(/[^a-zA-Z0-9.-]/g, '_');
                  const path = `caregivers/${user.uid}/video/intro_${timestamp}_${sanitized}`;
                  const snapshot = await storage.ref().child(path).put(videoFile);
                  const videoUrl = await snapshot.ref.getDownloadURL();
                  await dbService.updateUser('caregivers', user.uid, { videoUrl });
               } catch (uploadError) {
                  console.error('Failed to upload video intro:', uploadError);
               }
            }

            // Save license details to user profile (images already uploaded in step 4)
            if (licenseDetails.number || licenseDetails.expirationDate) {
               try {
                  await dbService.updateUser('caregivers', user.uid, {
                     licenseDetails: {
                        number: licenseDetails.number,
                        expirationDate: licenseDetails.expirationDate,
                        status: 'pending',
                        submittedAt: new Date().toISOString()
                     }
                  } as any);
               } catch (error) {
                  console.error('Failed to save license details:', error);
               }
            }

            // Actually upload _pendingFile to Firebase Storage
            const docTypes = Object.keys(documents) as DocumentType[];
            for (const docType of docTypes) {
               const doc = documents[docType];
               if (doc?._pendingFile) {
                  // Upload pending document to Firebase Storage
                  try {
                     await documentUploadService.uploadDocument(
                        user.uid,
                        doc._pendingFile,
                        docType
                     );
                  } catch (uploadError) {
                     console.error(`Failed to upload ${docType}:`, uploadError);
                     // Continue with other documents even if one fails
                  }
               }
            }
         }

         onShowToast("Profile submitted for review!", 'success');
         onNavigate('caregiver');
      } catch (error: unknown) {
         console.error(error);
         const errorMessage = error instanceof Error ? error.message : "Failed to create account";
         onShowToast(errorMessage, 'error');
      } finally {
         setIsLoading(false);
      }
   }, [onNavigate, onShowToast, basicInfo, logistics, certs, skills, bio, backgroundCheckData, weeklyAvailability, documents, profilePhoto, licenseDetails]);

   const canProceedFromDocuments = useCallback(() => {
      if (skipDocuments) return true;
      
      if (step === 4) return !!documents.driversLicense;
      if (step === 5) return !!documents.registration;
      return true;
   }, [step, documents, skipDocuments]);

   const getStepTitle = () => {
      switch (step) {
         case 1: return 'Account Basics';
         case 2: return 'Qualifications';
         case 3: return 'Final Details';
         case 4: return "Driver's License";
         case 5: return 'Vehicle Registration';
         case 6: return 'Background Check';
         case 7: return 'Availability';
         case 8: return 'Profile & Verification';
         case 9: return 'Payment Preferences';
         case 10: return 'Review & Submit';
         default: return '';
      }
   };

   const getStepSubtitle = () => {
      switch (step) {
         case 4: return 'Upload a clear photo of your driver\'s license (front)';
         case 5: return 'Upload your vehicle registration';
         case 6: return 'Secure information for background verification';
         case 7: return 'Select your typical availability';
         case 8: return 'Add your profile photo and license details for admin approval';
         case 9: return 'How would you like families to pay you after each visit?';
         case 10: return 'Review your information before submitting';
         default: return '';
      }
   };

   const formatPhoneNumber = (value: string) => {
      const cleaned = value.replace(/\D/g, '');
      if (cleaned.length <= 3) return cleaned;
      if (cleaned.length <= 6) return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3)}`;
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
   };

   // SSN Input: Store raw digits in both ref and state
   // Display shows masked version when not focused, real digits when focused
   const formatSsnDisplay = (cleanedDigits: string) => {
      const cleaned = cleanedDigits.slice(0, 9);
      
      // Return masked display - only show last 4 digits
      if (cleaned.length === 0) return '';
      if (cleaned.length <= 3) {
         return '*'.repeat(cleaned.length);
      }
      if (cleaned.length <= 5) {
         return `***-${'*'.repeat(cleaned.length - 3)}`;
      }
      
      // Full mask: ***-**-####
      const last4 = cleaned.slice(-4);
      return `***-**-${last4}`;
   };

   const handleSsnChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const inputValue = e.target.value;
      
      // Extract only digits from the input (strips any mask chars if present)
      let digitsOnly = inputValue.replace(/\D/g, '').slice(0, 9);
      
      // BUG FIX: If the input contains mask characters (*), it means the user
      // typed while the field was blurred. In this case, we should only keep
      // the newly typed digits, not the masked display value.
      if (inputValue.includes('*')) {
         // Extract only the digits that come after any mask characters
         const afterMask = inputValue.replace(/.*\*/g, '');
         digitsOnly = afterMask.replace(/\D/g, '').slice(0, 9);
      }
      
      // Update both ref and state with the clean digits
      fullSsnRef.current = digitsOnly;
      setBackgroundCheckData(prev => ({ ...prev, ssn: digitsOnly }));
   };

   const handleSsnFocus = () => setSsnFocused(true);
   const handleSsnBlur = () => setSsnFocused(false);

   // Get the display value for the SSN input
   const getSsnDisplayValue = () => {
      if (ssnFocused) {
         // When focused, show raw digits with dashes for readability
         const digits = backgroundCheckData.ssn;
         if (digits.length <= 3) return digits;
         if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
         return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
      }
      // When not focused, show masked
      return formatSsnDisplay(backgroundCheckData.ssn);
   };

   const HERO_PANELS: { gradient: string; icon: React.ComponentType<{ className?: string }>; headline: string; subtext: string }[] = [
      { gradient: 'from-primary-600 to-blue-700', icon: Heart, headline: "There's a family that can't wait to meet you", subtext: "Join CareConnex and connect with seniors who need your compassionate care." },
      { gradient: 'from-accent-500 to-accent-600', icon: Star, headline: "Your experience changes lives", subtext: "Highlight your certifications and specialties to get matched with the right families." },
      { gradient: 'from-green-500 to-primary-600', icon: DollarSign, headline: "Set your worth — you've earned it", subtext: "Caregivers in your area earn $24–$35/hr. Set a rate that reflects your experience." },
      { gradient: 'from-blue-600 to-indigo-700', icon: Shield, headline: "Families trust verified caregivers", subtext: "Your license and documents help families feel confident choosing you." },
      { gradient: 'from-slate-600 to-blue-700', icon: MapPin, headline: "Your vehicle is your reliability", subtext: "Caregivers with transportation get 2× more job requests from families." },
      { gradient: 'from-indigo-600 to-blue-700', icon: Lock, headline: "Trusted caregivers get 3× more bookings", subtext: "A background check is the #1 thing families look for when choosing a caregiver." },
      { gradient: 'from-primary-500 to-cyan-600', icon: Calendar, headline: "The more available, the more you'll earn", subtext: "Set your weekly availability so families know exactly when you're free." },
      { gradient: 'from-accent-500 to-rose-500', icon: Camera, headline: "A great photo gets 3× more inquiries", subtext: "Choose a clear, friendly headshot. Families want to see your smile." },
      { gradient: 'from-green-600 to-emerald-700', icon: DollarSign, headline: "Fast, flexible payouts", subtext: "Set up your payment preferences so you get paid quickly after every shift." },
      { gradient: 'from-primary-600 to-blue-700', icon: CheckCircle, headline: "Almost there — review and submit!", subtext: "Take a moment to review your profile before going live on CareConnex." },
   ];

   return (
      <div className="flex min-h-screen overflow-hidden animate-slide-in">

         {/* ── LEFT PANEL ── */}
         <div className="flex-1 flex flex-col overflow-y-auto bg-white min-h-screen">
            {/* Logo */}
            <div className="px-8 pt-8 pb-2 flex-shrink-0">
               <div className="flex items-center gap-2">
                  <div className="bg-accent-500 p-2 rounded-xl shadow-md shadow-accent-200">
                     <Heart className="text-white w-5 h-5" />
                  </div>
                  <span className="text-xl font-bold text-slate-900">CareConnex</span>
               </div>
            </div>

            {/* Form area */}
            <div className="flex-1 flex flex-col justify-center px-6 sm:px-12 py-6">
               <div className="w-full max-w-md mx-auto">

                  <form className="space-y-4 relative z-10" onSubmit={handleNext}>

                     {/* Step Header */}
                  <div className="mb-6">
                     <h3 className="text-lg font-bold text-slate-900">{getStepTitle()}</h3>
                     {getStepSubtitle() && (
                        <p className="text-sm text-slate-500 mt-1">{getStepSubtitle()}</p>
                     )}
                  </div>

                  {/* STEP 1: BASICS */}
                  {step === 1 && (
                     <div className="animate-slide-in space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                           <Input
                              label="First Name" required
                              value={basicInfo.firstName}
                              onChange={(e) => setBasicInfo({ ...basicInfo, firstName: e.target.value })}
                           />
                           <Input
                              label="Last Name" required
                              value={basicInfo.lastName}
                              onChange={(e) => setBasicInfo({ ...basicInfo, lastName: e.target.value })}
                           />
                        </div>
                        <Input
                           label="Email Address" type="email" required
                           value={basicInfo.email}
                           onChange={(e) => setBasicInfo({ ...basicInfo, email: e.target.value })}
                        />
                        <Input
                           label="Phone Number" type="tel" required
                           value={basicInfo.phone}
                           onChange={(e) => setBasicInfo({ ...basicInfo, phone: formatPhoneNumber(e.target.value) })}
                           placeholder="(555) 123-4567"
                        />
                        <Input
                           label="Password" type="password" required
                           value={basicInfo.password}
                           onChange={(e) => setBasicInfo({ ...basicInfo, password: e.target.value })}
                        />
                        <div>
                           <label htmlFor="gender-select" className="block text-sm font-medium text-slate-700 mb-2">Gender (Optional)</label>
                           <select
                              id="gender-select"
                              value={basicInfo.gender}
                              onChange={(e) => setBasicInfo({ ...basicInfo, gender: e.target.value as 'Male' | 'Female' | 'Non-binary' | 'Prefer not to say' | '' })}
                              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-accent-500 bg-white text-slate-900"
                           >
                              <option value="">Prefer not to say</option>
                              <option value="Male">Male</option>
                              <option value="Female">Female</option>
                              <option value="Non-binary">Non-binary</option>
                           </select>
                        </div>
                        <label className="flex items-start gap-3 pt-2 cursor-pointer">
                           <input
                              type="checkbox"
                              checked={acceptedTerms}
                              onChange={(e) => setAcceptedTerms(e.target.checked)}
                              className="mt-0.5 w-4 h-4 rounded border-slate-300 text-accent-600 focus:ring-accent-500"
                           />
                           <span className="text-xs text-slate-600 leading-relaxed">
                              I agree to the{' '}
                              <button type="button" onClick={() => setLegalModal('terms')} className="text-accent-600 underline hover:text-accent-700">
                                 Terms of Service
                              </button>
                              {' '}and{' '}
                              <button type="button" onClick={() => setLegalModal('privacy')} className="text-accent-600 underline hover:text-accent-700">
                                 Privacy Policy
                              </button>
                              .
                           </span>
                        </label>
                     </div>
                  )}

                  {/* STEP 2: EXPERTISE */}
                  {step === 2 && (
                     <div className="animate-slide-in space-y-4">
                        <p className="text-sm text-slate-500 mb-4">Select your certifications to get higher pay.</p>

                        <div className="space-y-4">
                           <div>
                              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Certifications</label>
                              <div className="flex flex-wrap gap-2">
                                 {CERTS_OPTIONS.map(c => (
                                    <button
                                       key={c}
                                       type="button"
                                       onClick={() => toggleSelection(c, certs, setCerts)}
                                       className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${certs.includes(c) ? 'bg-accent-100 border-accent-500 text-accent-700' : 'bg-white border-slate-200 text-slate-600'
                                          }`}
                                    >
                                       {c}
                                    </button>
                                 ))}
                              </div>
                           </div>

                           <div>
                              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Senior Care Experience</label>
                              <p className="text-xs text-slate-500 mb-2">Select all conditions you have experience with — this helps families find the right match.</p>
                              <div className="grid grid-cols-2 gap-2">
                                 {SKILLS_OPTIONS.map(s => (
                                    <div
                                       key={s}
                                       onClick={() => toggleSelection(s, skills, setSkills)}
                                       className={`p-2 rounded-lg border text-sm cursor-pointer flex items-center gap-1.5 transition-colors ${skills.includes(s) ? 'bg-accent-50 border-accent-400 text-accent-800 font-medium' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}
                                    >
                                       {skills.includes(s) && <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                                       {s}
                                    </div>
                                 ))}
                              </div>
                           </div>
                        </div>

                        <div>
                           <label htmlFor="bio" className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Bio / About You</label>
                           <textarea
                              id="bio"
                              value={bio}
                              onChange={(e) => setBio(e.target.value)}
                              placeholder="Tell families about your experience, approach to care, and what makes you unique..."
                              rows={4}
                              maxLength={500}
                              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-accent-500 bg-white text-slate-900 resize-none"
                           />
                           <p className={`text-xs mt-1 ${bio.length >= 500 ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
                              {bio.length}/500 characters
                              {bio.length >= 500 && <span className="ml-1">(maximum reached)</span>}
                           </p>
                        </div>
                     </div>
                  )}

                  {/* STEP 3: LOGISTICS */}
                  {step === 3 && (
                     <div className="animate-slide-in space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                           <Input
                              label="Years Exp." type="number" required
                              value={logistics.experience}
                              onChange={(e) => setLogistics({ ...logistics, experience: e.target.value })}
                           />
                           <Input
                              label="Hourly Rate ($)" type="number" required
                              min={15}
                              max={100}
                              value={logistics.rate}
                              onChange={(e) => {
                                 const value = e.target.value;
                                 // Allow empty string while typing
                                 if (value === '') {
                                    setLogistics({ ...logistics, rate: '' });
                                    return;
                                 }
                                 const numValue = parseInt(value);
                                 if (isNaN(numValue)) return;
                                 // Allow any value between 15-100, or partial input while typing
                                 if (numValue >= 15 && numValue <= 100) {
                                    setLogistics({ ...logistics, rate: value });
                                 } else if (numValue < 15) {
                                    setLogistics({ ...logistics, rate: '15' });
                                 } else if (numValue > 100) {
                                    setLogistics({ ...logistics, rate: '100' });
                                 }
                              }}
                           />
                        </div>

                        {/* Tiered pricing for multiple seniors */}
                        <div className="p-4 bg-accent-50 border border-accent-200 rounded-xl space-y-3">
                           <p className="text-xs font-semibold text-accent-800 uppercase tracking-wide">Multiple Seniors (Optional)</p>
                           <p className="text-xs text-accent-700">Many families care for couples. Set different rates for multiple seniors.</p>
                           <div className="grid grid-cols-2 gap-3">
                              <Input
                                 label="Rate for 2 seniors ($)"
                                 type="number"
                                 min={15}
                                 max={150}
                                 value={logistics.rateFor2}
                                 onChange={(e) => setLogistics({ ...logistics, rateFor2: e.target.value })}
                              />
                              <Input
                                 label="Rate for 3+ seniors ($)"
                                 type="number"
                                 min={15}
                                 max={200}
                                 value={logistics.rateFor3Plus}
                                 onChange={(e) => setLogistics({ ...logistics, rateFor3Plus: e.target.value })}
                              />
                           </div>
                        </div>

                        <LocationInput
                           label="Your Location"
                           placeholder="City, State or Zip"
                           value={logistics.location}
                           onChange={(val) => {
                              if (typeof val === 'object') {
                                 setLogistics({
                                    ...logistics,
                                    location: val.address,
                                    latitude: val.lat || 0,
                                    longitude: val.lng || 0
                                 });
                              } else {
                                 setLogistics({ ...logistics, location: val });
                              }
                           }}
                           required
                        />

                        <label className="flex items-center justify-between p-4 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                           <div>
                              <span className="block font-bold text-slate-900">Reliable Transportation</span>
                              <span className="text-sm text-slate-500">I have my own car</span>
                           </div>
                           <div className={`w-12 h-6 rounded-full p-1 transition-colors ${logistics.hasCar ? 'bg-accent-500' : 'bg-slate-300'}`}>
                              <div className={`bg-white w-4 h-4 rounded-full shadow-sm transition-transform ${logistics.hasCar ? 'translate-x-6' : 'translate-x-0'}`} />
                           </div>
                           <input
                              type="checkbox"
                              className="hidden"
                              checked={logistics.hasCar}
                              onChange={(e) => setLogistics({ ...logistics, hasCar: e.target.checked })}
                           />
                        </label>
                     </div>
                  )}

                  {/* STEP 4: DRIVER'S LICENSE */}
                  {step === 4 && (
                     <div className="animate-slide-in space-y-4">
                        <DocumentUpload
                           type="driversLicense"
                           label="Driver's License (Front)"
                           description="Upload a clear photo of the front of your driver's license"
                           existingDocument={documents.driversLicense}
                           onUpload={handleDocumentUpload}
                           onDelete={handleDocumentDelete}
                        />
                        
                        {logistics.hasCar && (
                           <DocumentUpload
                              type="driversLicenseBack"
                              label="Driver's License (Back) - Optional"
                              description="Upload the back of your license (optional but recommended)"
                              existingDocument={documents.driversLicenseBack}
                              onUpload={handleDocumentUpload}
                              onDelete={handleDocumentDelete}
                           />
                        )}

                        <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg">
                           <input
                              type="checkbox"
                              id="skip-docs"
                              checked={skipDocuments}
                              onChange={(e) => setSkipDocuments(e.target.checked)}
                              className="rounded border-slate-300 text-accent-500 focus:ring-accent-500"
                           />
                           <label htmlFor="skip-docs" className="text-sm text-slate-600 cursor-pointer">
                              I'll upload these later
                           </label>
                        </div>
                     </div>
                  )}

                  {/* STEP 5: REGISTRATION */}
                  {step === 5 && !skipDocuments && (
                     <div className="animate-slide-in">
                        <DocumentUpload
                           type="registration"
                           label="Vehicle Registration"
                           description="Upload your current vehicle registration document"
                           existingDocument={documents.registration}
                           onUpload={handleDocumentUpload}
                           onDelete={handleDocumentDelete}
                        />
                     </div>
                  )}

                  {/* Skip step 5 if user chose to skip */}
                  {step === 5 && skipDocuments && (
                     <div className="animate-slide-in text-center py-8">
                        <CheckCircle className="w-16 h-16 text-accent-500 mx-auto mb-4" />
                        <h4 className="text-lg font-bold text-slate-900 mb-2">Documents skipped</h4>
                        <p className="text-slate-500">You can upload your documents later from your profile.</p>
                     </div>
                  )}

                  {/* STEP 6: BACKGROUND CHECK */}
                  {step === 6 && (
                     <div className="animate-slide-in space-y-4">
                        <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                           <Shield className="w-6 h-6 text-blue-500 flex-shrink-0" />
                           <p className="text-sm text-blue-700">
                              Your information is securely encrypted and used only for background verification purposes.
                           </p>
                        </div>

                        <Input
                           label="Social Security Number" 
                           type={ssnFocused ? "text" : "password"}
                           required
                           value={getSsnDisplayValue()}
                           onChange={handleSsnChange}
                           onFocus={handleSsnFocus}
                           onBlur={handleSsnBlur}
                           placeholder="123-45-6789"
                           maxLength={11}
                           autoComplete="off"
                        />

                        <div>
                           <label className="block text-sm font-medium text-slate-700 mb-2">Date of Birth *</label>
                           <input
                              type="date"
                              required
                              value={backgroundCheckData.dateOfBirth}
                              onChange={(e) => setBackgroundCheckData({ ...backgroundCheckData, dateOfBirth: e.target.value })}
                              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-accent-100 focus:border-accent-500 bg-white text-slate-900"
                           />
                        </div>

                        <div className="flex items-start gap-3 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                           <input
                              type="checkbox"
                              id="background-consent"
                              checked={backgroundCheckData.consentToBackgroundCheck}
                              onChange={(e) => setBackgroundCheckData({ ...backgroundCheckData, consentToBackgroundCheck: e.target.checked })}
                              className="mt-1 rounded border-slate-300 text-accent-500 focus:ring-accent-500"
                           />
                           <label htmlFor="background-consent" className="text-sm text-slate-600 cursor-pointer">
                              I consent to a background check and understand that my information will be used for verification purposes in accordance with applicable laws.
                           </label>
                        </div>
                     </div>
                  )}

                  {/* STEP 7: AVAILABILITY */}
                  {step === 7 && (
                     <div className="animate-slide-in space-y-4">
                        <p className="text-sm text-slate-500 mb-2">Select the days and times you're typically available.</p>

                        {/* AM/PM × 7-day grid */}
                        <div className="overflow-x-auto">
                           <table className="w-full text-sm border-collapse">
                              <thead>
                                 <tr>
                                    <th className="w-24 pb-2 text-left text-xs text-slate-400 font-medium"></th>
                                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                                       <th key={d} className="pb-2 text-center text-xs text-slate-500 font-semibold w-12">{d}</th>
                                    ))}
                                 </tr>
                              </thead>
                              <tbody>
                                 {[
                                    { label: 'Morning', sub: '6am–12pm', slot: 'morning', bg: 'bg-accent-100 border-accent-400 text-accent-800' },
                                    { label: 'Afternoon', sub: '12pm–6pm', slot: 'afternoon', bg: 'bg-accent-100 border-accent-400 text-accent-800' },
                                    { label: 'Evening', sub: '6pm–10pm', slot: 'evening', bg: 'bg-primary-100 border-primary-400 text-primary-800' },
                                 ].map(({ label, sub, slot, bg }) => (
                                    <tr key={slot}>
                                       <td className="pr-3 py-2">
                                          <div className="text-xs font-semibold text-slate-700">{label}</div>
                                          <div className="text-xs text-slate-400">{sub}</div>
                                       </td>
                                       {Object.keys(weeklyAvailability).map(day => {
                                          const active = weeklyAvailability[day].includes(slot);
                                          return (
                                             <td key={day} className="py-2 text-center">
                                                <button
                                                   type="button"
                                                   onClick={() => toggleSlot(day, slot)}
                                                   className={`w-8 h-8 rounded-lg border-2 transition-colors text-xs font-bold ${
                                                      active ? bg : 'bg-slate-50 border-slate-200 text-slate-300 hover:border-slate-300'
                                                   }`}
                                                >
                                                   {active ? '✓' : ''}
                                                </button>
                                             </td>
                                          );
                                       })}
                                    </tr>
                                 ))}
                              </tbody>
                           </table>
                        </div>

                        {/* Summary */}
                        {Object.values(weeklyAvailability).some(slots => slots.length > 0) && (
                           <div className="flex flex-wrap gap-1.5 mt-2">
                              {Object.entries(weeklyAvailability)
                                 .filter(([, slots]) => slots.length > 0)
                                 .map(([day, slots]) => (
                                    <span key={day} className="px-2 py-1 bg-primary-50 text-primary-700 border border-primary-200 rounded-full text-xs font-medium capitalize">
                                       {day.slice(0, 3)}: {slots.join(', ')}
                                    </span>
                                 ))}
                           </div>
                        )}

                        <p className="text-xs text-slate-400 mt-2">
                           You can update your availability anytime from your profile settings.
                        </p>
                     </div>
                  )}

                  {/* STEP 8: PROFILE & VERIFICATION */}
                  {step === 8 && (
                     <div className="animate-slide-in space-y-6">
                        {/* Profile Photo Upload */}
                        <div className="text-center">
                           <label className="block text-sm font-medium text-slate-700 mb-3">Profile Photo</label>
                           <div className="relative inline-block">
                              {profilePhoto.preview ? (
                                 <div className="relative">
                                    <img 
                                       src={profilePhoto.preview} 
                                       alt="Profile preview" 
                                       className="w-32 h-32 rounded-full object-cover border-4 border-accent-200"
                                    />
                                    <button
                                       type="button"
                                       onClick={() => {
                                          if (profilePhoto.preview) URL.revokeObjectURL(profilePhoto.preview);
                                          setProfilePhoto({file: null, preview: null});
                                       }}
                                       className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                                    >
                                       <ArrowLeft className="w-4 h-4" />
                                    </button>
                                 </div>
                              ) : (
                                 <label className="flex flex-col items-center justify-center w-32 h-32 rounded-full border-4 border-dashed border-slate-300 hover:border-accent-400 cursor-pointer bg-slate-50 hover:bg-accent-50 transition-colors">
                                    <Upload className="w-8 h-8 text-slate-400 mb-2" />
                                    <span className="text-xs text-slate-500 text-center px-2">Upload Photo</span>
                                    <input
                                       type="file"
                                       accept="image/*"
                                       className="hidden"
                                       onChange={(e) => {
                                          const file = e.target.files?.[0];
                                          if (file) {
                                             const preview = URL.createObjectURL(file);
                                             blobUrlsRef.current.add(preview);
                                             setProfilePhoto({file, preview});
                                          }
                                       }}
                                    />
                                 </label>
                              )}
                           </div>
                           <p className="text-xs text-slate-500 mt-2">This will be visible to families</p>
                        </div>

                        {/* Video Introduction */}
                        <div className="border-t border-slate-200 pt-6">
                           <h4 className="font-medium text-slate-900 mb-1 flex items-center gap-2">
                              <Play className="w-5 h-5 text-accent-500" />
                              Video Introduction
                              <span className="text-xs bg-accent-100 text-accent-700 px-2 py-0.5 rounded-full font-normal">Optional but recommended</span>
                           </h4>
                           <p className="text-sm text-slate-500 mb-3">Caregivers with a video intro get 3× more family inquiries. Record or upload a 60-second clip.</p>

                           {videoPreview ? (
                              <div className="relative rounded-xl overflow-hidden border border-slate-200">
                                 <video src={videoPreview} controls className="w-full max-h-48 bg-black" />
                                 <button
                                    type="button"
                                    onClick={() => {
                                       if (videoPreview) URL.revokeObjectURL(videoPreview);
                                       setVideoPreview(null);
                                       setVideoFile(null);
                                    }}
                                    className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                                 >
                                    <X className="w-3.5 h-3.5" />
                                 </button>
                                 <div className="p-2 bg-green-50 border-t border-green-200 flex items-center gap-2">
                                    <CheckCircle className="w-4 h-4 text-green-600" />
                                    <span className="text-xs text-green-700 font-medium">Video ready to upload</span>
                                 </div>
                              </div>
                           ) : (
                              <label className="flex flex-col items-center justify-center w-full h-28 border-2 border-dashed border-slate-300 rounded-xl hover:border-accent-400 cursor-pointer bg-slate-50 hover:bg-accent-50 transition-colors">
                                 <Play className="w-7 h-7 text-slate-400 mb-1.5" />
                                 <span className="text-sm text-slate-600 font-medium">Upload video intro</span>
                                 <span className="text-xs text-slate-400 mt-0.5">.mp4 or .mov · max 100MB</span>
                                 <input
                                    type="file"
                                    accept="video/mp4,video/quicktime,video/*"
                                    className="hidden"
                                    onChange={(e) => {
                                       const file = e.target.files?.[0];
                                       if (file) {
                                          const preview = URL.createObjectURL(file);
                                          blobUrlsRef.current.add(preview);
                                          setVideoPreview(preview);
                                          setVideoFile(file);
                                       }
                                    }}
                                 />
                              </label>
                           )}
                        </div>

                        {/* Driver's License Details */}
                        <div className="border-t border-slate-200 pt-6">
                           <h4 className="font-medium text-slate-900 mb-4 flex items-center gap-2">
                              <Shield className="w-5 h-5 text-accent-500" />
                              Driver's License Verification
                           </h4>
                           <p className="text-sm text-slate-500 mb-4">Admin will review and approve your license.</p>
                           
                           <div className="space-y-4">
                              <Input
                                 label="License Number"
                                 placeholder="e.g., D12345678"
                                 value={licenseDetails.number}
                                 onChange={(e) => setLicenseDetails({...licenseDetails, number: e.target.value})}
                                 required
                              />
                              
                              <Input
                                 label="Expiration Date"
                                 type="date"
                                 value={licenseDetails.expirationDate}
                                 onChange={(e) => setLicenseDetails({...licenseDetails, expirationDate: e.target.value})}
                                 required
                              />

                           </div>
                        </div>
                     </div>
                  )}

                  {/* STEP 9: PAYMENT PREFERENCES */}
                  {step === 9 && (
                     <div className="animate-slide-in space-y-4">
                        <p className="text-sm text-slate-500">Families pay you directly after each visit. Set the methods you accept so they know how to send money.</p>
                        {/* Venmo */}
                        <div>
                           <label className="block text-sm font-medium text-slate-700 mb-1.5">Venmo username <span className="text-slate-400 font-normal">(optional)</span></label>
                           <div className="flex items-center gap-2">
                              <span className="text-slate-400 font-medium">@</span>
                              <input
                                 value={payVenmo.replace(/^@/, '')}
                                 onChange={e => setPayVenmo('@' + e.target.value.replace(/^@/, ''))}
                                 placeholder="your-venmo-handle"
                                 className="flex-1 px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-200 focus:border-accent-400"
                              />
                           </div>
                        </div>
                        {/* Zelle */}
                        <div>
                           <label className="block text-sm font-medium text-slate-700 mb-1.5">Zelle (phone or email) <span className="text-slate-400 font-normal">(optional)</span></label>
                           <input
                              value={payZelle}
                              onChange={e => setPayZelle(e.target.value)}
                              placeholder="415-555-0100 or you@email.com"
                              className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-200 focus:border-accent-400"
                           />
                        </div>
                        {/* Cash toggle */}
                        <div className="flex items-center justify-between py-2 px-4 bg-slate-50 rounded-xl border border-slate-200">
                           <div>
                              <p className="text-sm font-medium text-slate-700">Accept cash</p>
                              <p className="text-xs text-slate-400">Shown on your profile so families know</p>
                           </div>
                           <button
                              type="button"
                              onClick={() => setPayCash(v => !v)}
                              className={`relative w-11 h-6 rounded-full transition-colors ${payCash ? 'bg-accent-500' : 'bg-slate-300'}`}
                           >
                              <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${payCash ? 'translate-x-5' : ''}`} />
                           </button>
                        </div>
                        {/* Credit card toggle */}
                        <div className="flex items-center justify-between py-2 px-4 bg-slate-50 rounded-xl border border-slate-200">
                           <div>
                              <p className="text-sm font-medium text-slate-700">Accept credit card payments</p>
                              <p className="text-xs text-slate-400">Required to apply to credit-only job posts. Earns the "Accepts credit cards" badge.</p>
                           </div>
                           <button
                              type="button"
                              onClick={() => setAcceptsCreditCards(v => !v)}
                              className={`relative w-11 h-6 rounded-full transition-colors ${acceptsCreditCards ? 'bg-blue-500' : 'bg-slate-300'}`}
                           >
                              <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${acceptsCreditCards ? 'translate-x-5' : ''}`} />
                           </button>
                        </div>
                        {/* Other */}
                        <div>
                           <label className="block text-sm font-medium text-slate-700 mb-1.5">Other <span className="text-slate-400 font-normal">(PayPal, Apple Pay, etc. — optional)</span></label>
                           <input
                              value={payOther}
                              onChange={e => setPayOther(e.target.value)}
                              placeholder="PayPal @handle, Apple Pay 415-555-0100…"
                              className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-200 focus:border-accent-400"
                           />
                        </div>
                        <p className="text-xs text-slate-400 text-center">You can update these anytime in your account settings.</p>
                     </div>
                  )}

                  {/* STEP 10: REVIEW */}
                  {step === 10 && (
                     <div className="animate-slide-in space-y-4">
                        <div className="p-4 bg-green-50 border border-green-200 rounded-xl">
                           <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                           <h4 className="text-center font-bold text-green-800 mb-1">Almost there!</h4>
                           <p className="text-center text-sm text-green-700">
                              Review your information and submit to complete your caregiver profile.
                           </p>
                        </div>

                        <div className="space-y-3 text-sm">
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Name</span>
                              <span className="font-medium text-slate-900">{basicInfo.firstName} {basicInfo.lastName}</span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Email</span>
                              <span className="font-medium text-slate-900">{basicInfo.email}</span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Phone</span>
                              <span className="font-medium text-slate-900">{basicInfo.phone}</span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Experience</span>
                              <span className="font-medium text-slate-900">{logistics.experience} years</span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Hourly Rate</span>
                              <span className="font-medium text-slate-900">${logistics.rate}/hr</span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Location</span>
                              <span className="font-medium text-slate-900">{logistics.location}</span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Certifications</span>
                              <span className="font-medium text-slate-900">{certs.length > 0 ? certs.join(', ') : 'None'}</span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Available Days</span>
                              <span className="font-medium text-slate-900">
                                 {Object.values(weeklyAvailability).filter(slots => slots.length > 0).length} days selected
                              </span>
                           </div>
                           <div className="flex justify-between py-2 border-b border-slate-100">
                              <span className="text-slate-500">Documents</span>
                              <span className="font-medium text-slate-900">
                                 {skipDocuments ? 'Skipped' : [
                                    documents.driversLicense && "License",
                                    documents.registration && "Registration"
                                 ].filter(Boolean).join(', ') || 'Pending'}
                              </span>
                           </div>
                           <div className="flex justify-between py-2">
                              <span className="text-slate-500">Background Check</span>
                              <span className="font-medium text-green-600">Consent Given</span>
                           </div>
                        </div>
                     </div>
                  )}

                  <div className="pt-4 flex gap-3">
                     {step > 1 && (
                        <Button type="button" variant="secondary" onClick={() => setStep(step - 1)}>
                           Back
                        </Button>
                     )}
                     <Button 
                        fullWidth 
                        type="submit" 
                        disabled={isLoading || (!skipDocuments && step > 3 && step < 6 && !canProceedFromDocuments())}
                        variant="accent"
                     >
                        {isLoading ? "Creating Profile..." : step === TOTAL_STEPS ? "Submit" : "Next Step"}
                        {!isLoading && step < TOTAL_STEPS && <ChevronRight className="w-4 h-4 ml-1" />}
                     </Button>
                  </div>
                  </form>

                  {/* Step dots + back to home */}
                  <div className="mt-8 flex flex-col items-center gap-4">
                     <div className="flex items-center gap-1.5">
                        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map(s => (
                           <div
                              key={s}
                              className={`h-2 rounded-full transition-all duration-300 ${
                                 step === s ? 'w-5 bg-accent-500' : step > s ? 'w-2 bg-accent-300' : 'w-2 bg-slate-200'
                              }`}
                           />
                        ))}
                     </div>
                     <button type="button" onClick={() => onNavigate('landing')} className="flex items-center text-slate-400 hover:text-slate-600 transition-colors text-sm">
                        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Home
                     </button>
                  </div>

               </div>
            </div>
         </div>

         {/* ── RIGHT PANEL (desktop only) ── */}
         {(() => {
            const panel = HERO_PANELS[step - 1];
            const Icon = panel.icon;
            return (
               <div className={`hidden lg:flex lg:w-[42%] flex-shrink-0 bg-gradient-to-br ${panel.gradient} flex-col items-center justify-center text-white p-12 text-center`}>
                  <div className="w-24 h-24 rounded-full bg-white/20 flex items-center justify-center mb-8">
                     <Icon className="w-12 h-12 text-white" />
                  </div>
                  <h2 className="text-3xl font-bold mb-4 leading-tight max-w-xs">{panel.headline}</h2>
                  <p className="text-white/80 text-lg leading-relaxed max-w-xs">{panel.subtext}</p>
                  <div className="mt-12 flex items-center gap-2">
                     {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map(s => (
                        <div
                           key={s}
                           className={`h-1.5 rounded-full transition-all duration-300 ${
                              step === s ? 'w-6 bg-white' : step > s ? 'w-3 bg-white/60' : 'w-3 bg-white/25'
                           }`}
                        />
                     ))}
                  </div>
               </div>
            );
         })()}

         {legalModal && <LegalDocs type={legalModal} onClose={() => setLegalModal(null)} />}
      </div>
   );
};
