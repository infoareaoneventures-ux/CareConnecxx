import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ViewType, AddToastFunction } from '../../../types';
import { authService, dbService } from '../../../services/api';
import { SignupLayout } from './SignupLayout';
import { SignupFormData, INITIAL_FORM_DATA } from './types';
import { Step1PersonalInfo } from './steps/Step1PersonalInfo';

interface CaregiverSignupFlowProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

const cleanData = (data: Record<string, any>): Record<string, any> =>
  Object.fromEntries(
    Object.entries(data).filter(([_, v]) => v !== undefined && v !== '')
  );

export const CaregiverSignupFlow: React.FC<CaregiverSignupFlowProps> = ({
  onNavigate,
  onShowToast,
}) => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState<SignupFormData>(INITIAL_FORM_DATA);
  const [isLoading, setIsLoading] = useState(false);
  const [createdUserId, setCreatedUserId] = useState<string | null>(null);

  // Redirect already-authenticated users
  useEffect(() => {
    const existingUser = authService.getCurrentUser();
    if (existingUser && !createdUserId) {
      dbService.getUser(existingUser.uid).then(profile => {
        if (profile?.userType === 'caregiver') {
          navigate('/caregiver/dashboard', { replace: true });
        } else if (profile?.userType === 'client') {
          navigate('/client/dashboard', { replace: true });
        }
      }).catch(() => {});
    }
  }, [navigate, createdUserId]);

  const handleGoogleSignup = useCallback(async () => {
    setIsLoading(true);
    try {
      const { user } = await authService.signInWithGoogle('caregiver');
      if (user?.uid) setCreatedUserId(user.uid);
      sessionStorage.setItem('careconnex_show_caregiver_wizard', 'true');
      onShowToast('Welcome! Complete your profile to start getting bookings.', 'success');
      navigate('/caregiver/dashboard', { replace: true });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Google sign-up failed';
      onShowToast(errorMessage, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [onShowToast, navigate]);

  const updateField = useCallback((field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleCancel = useCallback(() => {
    navigate('/');
  }, [navigate]);

  // Create account → save location → go to dashboard (wizard auto-shows there)
  const handleStep1 = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      const additionalData: Record<string, any> = {
        hourlyRate: 25,
        verified: false,
        onboardingStatus: 'incomplete',
        onboardingStep: 1,
        verificationStatus: 'incomplete',
      };
      if (formData.phone) additionalData.phone = formData.phone;
      if (formData.dateOfBirth) additionalData.dateOfBirth = formData.dateOfBirth;

      const result = await authService.signup(
        formData.email,
        formData.password,
        `${formData.firstName} ${formData.lastName}`,
        'caregiver',
        additionalData as any
      );

      const uid = result?.uid || authService.getCurrentUser()?.uid;
      if (uid) {
        setCreatedUserId(uid);
        const locationString = [formData.street, formData.city, formData.state, formData.zipCode]
          .filter(Boolean).join(', ');
        await dbService.updateUser('caregivers', uid, cleanData({
          location: locationString,
          street: formData.street,
          city: formData.city,
          state: formData.state,
          zipCode: formData.zipCode,
          latitude: formData.latitude || null,
          longitude: formData.longitude || null,
        }) as any);
      }

      sessionStorage.setItem('careconnex_show_caregiver_wizard', 'true');
      navigate('/caregiver/dashboard');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create account';
      onShowToast(errorMessage, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [formData, isLoading, onShowToast, navigate]);

  return (
    <SignupLayout step={1} onCancel={handleCancel} sideContent={undefined} imageLeft={false}>
      <Step1PersonalInfo
        firstName={formData.firstName}
        lastName={formData.lastName}
        dateOfBirth={formData.dateOfBirth}
        email={formData.email}
        password={formData.password}
        phone={formData.phone}
        termsAccepted={formData.termsAccepted}
        street={formData.street}
        zipCode={formData.zipCode}
        city={formData.city}
        state={formData.state}
        onChange={updateField}
        onNext={handleStep1}
        onShowToast={onShowToast}
        onGoogleSignup={handleGoogleSignup}
        isLoading={isLoading}
      />
    </SignupLayout>
  );
};
