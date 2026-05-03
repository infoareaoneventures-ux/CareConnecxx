import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ViewType, AddToastFunction } from '../../../types';
import { authService, dbService } from '../../../services/api';
import { documentUploadService } from '../../../services/documentUpload';
import { SignupLayout } from './SignupLayout';
import { SignupFormData, INITIAL_FORM_DATA, TOTAL_STEPS } from './types';
import { Step1GetStarted } from './steps/Step1GetStarted';
import { Step2AccountInfo } from './steps/Step2AccountInfo';
import { Step3Location } from './steps/Step3Location';
import { Step4ProfilePhoto, Step4SideContent } from './steps/Step4ProfilePhoto';
import { Step5Availability } from './steps/Step5Availability';
import { Step6Services } from './steps/Step6Services';
import { Step7Rates } from './steps/Step7Rates';
import { Step8AboutMe } from './steps/Step8AboutMe';

interface CaregiverSignupFlowProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

// Strip undefined and empty string values before sending to Firestore
const cleanData = (data: Record<string, any>): Record<string, any> =>
  Object.fromEntries(
    Object.entries(data).filter(([_, v]) => v !== undefined && v !== '')
  );

export const CaregiverSignupFlow: React.FC<CaregiverSignupFlowProps> = ({
  onNavigate,
  onShowToast,
}) => {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<SignupFormData>(INITIAL_FORM_DATA);
  const [isLoading, setIsLoading] = useState(false);
  const [createdUserId, setCreatedUserId] = useState<string | null>(null);
  const blobUrlsRef = useRef<Set<string>>(new Set());

  // Redirect authenticated users away from signup
  useEffect(() => {
    const existingUser = authService.getCurrentUser();
    if (existingUser && !createdUserId) {
      // Check their actual role before redirecting
      dbService.getUser(existingUser.uid).then(profile => {
        if (profile?.userType === 'caregiver') {
          navigate('/caregiver/dashboard', { replace: true });
        } else if (profile?.userType === 'client') {
          navigate('/client/dashboard', { replace: true });
        }
        // If no profile yet (mid-signup), stay on the page
      }).catch(() => {});
    }
  }, [navigate, createdUserId]);

  const handleGoogleSignup = useCallback(async () => {
    setIsLoading(true);
    try {
      const { user } = await authService.signInWithGoogle('caregiver');
      if (user?.uid) setCreatedUserId(user.uid);
      onShowToast('Welcome! Complete your profile to start getting bookings.', 'success');
      navigate('/caregiver/dashboard', { replace: true });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Google sign-up failed';
      onShowToast(errorMessage, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [onShowToast, navigate]);

  // Resilient UID getter — falls back to current auth user if state was lost
  const getUid = useCallback(() => {
    return createdUserId || authService.getCurrentUser()?.uid || null;
  }, [createdUserId]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current.clear();
    };
  }, []);

  // Track blob URLs from photo uploads
  useEffect(() => {
    if (formData.profilePhoto.preview) {
      blobUrlsRef.current.add(formData.profilePhoto.preview);
    }
  }, [formData.profilePhoto.preview]);

  const updateField = useCallback((field: string, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  }, []);

  const goBack = useCallback(() => {
    if (step > 1) setStep(step - 1);
  }, [step]);

  const handleCancel = useCallback(() => {
    navigate('/');
  }, [navigate]);

  // Step 2 → Create account
  const handleCreateAccount = useCallback(async () => {
    if (isLoading) return; // Prevent double-click
    setIsLoading(true);
    try {
      // Include phone, DOB, gender, and verificationStatus directly in signup
      // (authService.signup filters undefined/empty values and writes without security stripping)
      const additionalData: Record<string, any> = {
        hourlyRate: 25,
        verified: false,
        onboardingStatus: 'incomplete',
        onboardingStep: 1,
        verificationStatus: 'submitted',
      };
      if (formData.phone) additionalData.phone = formData.phone;
      if (formData.dateOfBirth) additionalData.dateOfBirth = formData.dateOfBirth;
      if (formData.gender) additionalData.gender = formData.gender;

      const result = await authService.signup(
        formData.email,
        formData.password,
        `${formData.firstName} ${formData.lastName}`,
        'caregiver',
        additionalData as any
      );

      if (result?.uid) {
        setCreatedUserId(result.uid);
      }

      setStep(3);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create account';
      onShowToast(errorMessage, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [formData, onShowToast]);

  // Step 3 → Save location
  const handleSaveLocation = useCallback(async () => {
    const uid = getUid();
    if (!uid) { onShowToast('Session lost. Please refresh and try again.', 'error'); return; }
    setIsLoading(true);
    try {
      const locationString = [formData.street, formData.city, formData.state, formData.zipCode]
        .filter(Boolean)
        .join(', ');

      await dbService.updateUser('caregivers', uid, cleanData({
        location: locationString,
        street: formData.street,
        city: formData.city,
        state: formData.state,
        zipCode: formData.zipCode,
        neighborhood: formData.neighborhood,
        latitude: formData.latitude || null,
        longitude: formData.longitude || null,
      }) as any);

      setStep(4);
    } catch (error) {
      onShowToast('Failed to save location. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [getUid, formData, onShowToast]);

  // Step 4 → Upload profile photo
  const handleSavePhoto = useCallback(async () => {
    const uid = getUid();
    if (!uid) { onShowToast('Session lost. Please refresh and try again.', 'error'); return; }
    if (!formData.profilePhoto.file) return;
    setIsLoading(true);
    try {
      await documentUploadService.uploadDocument(
        uid,
        formData.profilePhoto.file,
        'profilePhoto'
      );
      setStep(5);
    } catch (error) {
      onShowToast('Failed to upload photo. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [getUid, formData.profilePhoto, onShowToast]);

  // Step 5 → Save availability
  const handleSaveAvailability = useCallback(async () => {
    const uid = getUid();
    if (!uid) { onShowToast('Session lost. Please refresh and try again.', 'error'); return; }
    setIsLoading(true);
    try {
      await dbService.updateUser('caregivers', uid, cleanData({
        weeklyAvailability: formData.weeklyAvailability,
        jobTypes: formData.jobTypes,
      }) as any);
      setStep(6);
    } catch (error) {
      onShowToast('Failed to save availability. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [getUid, formData, onShowToast]);

  // Step 6 → Save services
  const handleSaveServices = useCallback(async () => {
    const uid = getUid();
    if (!uid) { onShowToast('Session lost. Please refresh and try again.', 'error'); return; }
    setIsLoading(true);
    try {
      const allSkills = [
        ...formData.primaryServices.map((s) => s.name),
        ...formData.additionalServices,
      ];

      await dbService.updateUser('caregivers', uid, cleanData({
        primaryServices: formData.primaryServices,
        skills: allSkills,
        certifications: formData.certifications,
      }) as any);
      setStep(7);
    } catch (error) {
      onShowToast('Failed to save services. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [getUid, formData, onShowToast]);

  // Step 7 → Save rates
  const handleSaveRates = useCallback(async () => {
    const uid = getUid();
    if (!uid) { onShowToast('Session lost. Please refresh and try again.', 'error'); return; }
    setIsLoading(true);
    try {
      const rateData: Record<string, any> = {
        hourlyRate: parseInt(formData.hourlyRate) || 25,
      };
      if (formData.rateFor2Seniors) rateData.rateFor2Seniors = parseInt(formData.rateFor2Seniors);
      if (formData.rateFor3PlusSeniors) rateData.rateFor3PlusSeniors = parseInt(formData.rateFor3PlusSeniors);
      if (formData.maxClients) rateData.maxClients = parseInt(formData.maxClients);

      await dbService.updateUser('caregivers', uid, rateData as any);
      setStep(8);
    } catch (error) {
      onShowToast('Failed to save rates. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [getUid, formData, onShowToast]);

  // Step 8 → Save bio + finish
  const handleFinish = useCallback(async () => {
    const uid = getUid();
    if (!uid) { onShowToast('Session lost. Please refresh and try again.', 'error'); return; }
    setIsLoading(true);
    try {
      // Note: verificationStatus was set during signup (Bug 2 fix — updateUser strips it)
      await dbService.updateUser('caregivers', uid, cleanData({
        bio: formData.bio,
        onboardingStep: 2,
        submittedAt: new Date().toISOString(),
      }) as any);

      onShowToast('Profile submitted! Welcome to CareConnecxx.', 'success');
      navigate('/caregiver/dashboard');
    } catch (error) {
      onShowToast('Failed to save bio. Please try again.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [getUid, formData.bio, onShowToast, navigate]);

  // Side content for specific steps
  const getSideContent = () => {
    if (step === 4) {
      return (
        <Step4SideContent
          profilePhoto={formData.profilePhoto}
          firstName={formData.firstName}
          city={formData.city}
          state={formData.state}
        />
      );
    }
    return undefined;
  };

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <Step1GetStarted
            dateOfBirth={formData.dateOfBirth}
            termsAccepted={formData.termsAccepted}
            onChange={updateField}
            onNext={() => setStep(2)}
            onShowToast={onShowToast}
            onGoogleSignup={handleGoogleSignup}
            isLoading={isLoading}
          />
        );
      case 2:
        return (
          <Step2AccountInfo
            email={formData.email}
            password={formData.password}
            confirmPassword={formData.confirmPassword}
            firstName={formData.firstName}
            lastName={formData.lastName}
            phone={formData.phone}
            onChange={updateField}
            onNext={handleCreateAccount}
            onBack={goBack}
            onShowToast={onShowToast}
            isLoading={isLoading}
          />
        );
      case 3:
        return (
          <Step3Location
            street={formData.street}
            apt={formData.apt}
            zipCode={formData.zipCode}
            city={formData.city}
            state={formData.state}
            neighborhood={formData.neighborhood}
            onChange={updateField}
            onNext={handleSaveLocation}
            onBack={goBack}
            onShowToast={onShowToast}
            isLoading={isLoading}
          />
        );
      case 4:
        return (
          <Step4ProfilePhoto
            profilePhoto={formData.profilePhoto}
            firstName={formData.firstName}
            city={formData.city}
            state={formData.state}
            onChange={updateField}
            onNext={handleSavePhoto}
            onBack={goBack}
            onShowToast={onShowToast}
            isLoading={isLoading}
          />
        );
      case 5:
        return (
          <Step5Availability
            jobTypes={formData.jobTypes}
            weeklyAvailability={formData.weeklyAvailability}
            neverAvailable={formData.neverAvailable}
            onChange={updateField}
            onNext={handleSaveAvailability}
            onBack={goBack}
            onShowToast={onShowToast}
            isLoading={isLoading}
          />
        );
      case 6:
        return (
          <Step6Services
            primaryServices={formData.primaryServices}
            additionalServices={formData.additionalServices}
            certifications={formData.certifications}
            onChange={updateField}
            onNext={handleSaveServices}
            onBack={goBack}
            onShowToast={onShowToast}
            isLoading={isLoading}
          />
        );
      case 7:
        return (
          <Step7Rates
            hourlyRate={formData.hourlyRate}
            rateFor2Seniors={formData.rateFor2Seniors}
            rateFor3PlusSeniors={formData.rateFor3PlusSeniors}
            maxClients={formData.maxClients}
            onChange={updateField}
            onNext={handleSaveRates}
            onBack={goBack}
            onShowToast={onShowToast}
            isLoading={isLoading}
          />
        );
      case 8:
        return (
          <Step8AboutMe
            bio={formData.bio}
            onChange={updateField}
            onSubmit={handleFinish}
            onBack={goBack}
            onShowToast={onShowToast}
            isLoading={isLoading}
          />
        );
      default:
        return null;
    }
  };

  return (
    <SignupLayout
      step={step}
      onCancel={handleCancel}
      sideContent={getSideContent()}
      imageLeft={step % 2 === 0}
    >
      {renderStep()}
    </SignupLayout>
  );
};
