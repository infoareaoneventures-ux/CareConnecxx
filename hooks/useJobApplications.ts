import { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  doc,
  getDoc,
  serverTimestamp,
  getDocs,
  writeBatch
} from 'firebase/firestore';

export type JobApplicationStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'completed';

export interface JobApplication {
  id: string;
  jobId: string;
  jobTitle: string;
  caregiverId: string;
  caregiverName: string;
  caregiverPhoto?: string;
  clientId: string;
  clientName: string;
  status: JobApplicationStatus;
  appliedAt: string;
  updatedAt?: string;
  coverLetter?: string;
  proposedRate?: number;
  caregiverExperience?: number;
  caregiverRating?: number;
  caregiverSkills?: string[];
  jobRate?: number | null;
  jobLocation?: string | null;
  jobCareTypes?: string[];
  jobFrequency?: string | null;
  jobDaysOfWeek?: string[];
}

// Hook for caregivers to track their job applications
export const useMyApplications = (caregiverId: string | null) => {
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!caregiverId || !db) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const applicationsRef = collection(db, 'job_applications');
    const q = query(
      applicationsRef,
      where('caregiverId', '==', caregiverId),
      orderBy('appliedAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const apps: JobApplication[] = [];
        snapshot.forEach((doc) => {
          apps.push({ id: doc.id, ...doc.data() } as JobApplication);
        });
        setApplications(apps);
        setLoading(false);
      },
      (error) => {
        console.error('Applications listener error:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [caregiverId]);

  const withdrawApplication = useCallback(async (applicationId: string) => {
    if (!db) return;
    try {
      await updateDoc(doc(db, 'job_applications', applicationId), {
        status: 'withdrawn',
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Error withdrawing application:', error);
      throw error;
    }
  }, []);

  return { applications, loading, withdrawApplication };
};

// Hook for clients to manage applications to their jobs
export const useJobApplications = (clientId: string | null) => {
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clientId || !db) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const applicationsRef = collection(db, 'job_applications');
    const q = query(
      applicationsRef,
      where('clientId', '==', clientId),
      orderBy('appliedAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const apps: JobApplication[] = [];
        snapshot.forEach((doc) => {
          apps.push({ id: doc.id, ...doc.data() } as JobApplication);
        });
        setApplications(apps);
        setLoading(false);
      },
      (error) => {
        console.error('Job applications listener error:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [clientId]);

  const acceptApplication = useCallback(async (applicationId: string, jobId: string) => {
    const fdb = db;
    if (!fdb) return;

    const batch = writeBatch(fdb);

    // Update application status
    batch.update(doc(fdb, 'job_applications', applicationId), {
      status: 'accepted',
      updatedAt: serverTimestamp()
    });

    // Reject other applications for this job
    const otherAppsQuery = query(
      collection(fdb, 'job_applications'),
      where('jobId', '==', jobId),
      where('status', '==', 'pending')
    );
    const otherApps = await getDocs(otherAppsQuery);
    otherApps.forEach((appDoc) => {
      if (appDoc.id !== applicationId) {
        batch.update(doc(fdb, 'job_applications', appDoc.id), {
          status: 'rejected',
          updatedAt: serverTimestamp()
        });
      }
    });

    // Update job status
    batch.update(doc(fdb, 'job_posts', jobId), {
      status: 'filled',
      filledAt: serverTimestamp()
    });
    
    await batch.commit();
  }, []);

  const rejectApplication = useCallback(async (applicationId: string) => {
    if (!db) return;
    try {
      await updateDoc(doc(db, 'job_applications', applicationId), {
        status: 'rejected',
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Error rejecting application:', error);
      throw error;
    }
  }, []);

  return { applications, loading, acceptApplication, rejectApplication };
};

// Service for job applications
export const jobApplicationService = {
  async applyToJob(
    jobId: string,
    jobTitle: string,
    clientId: string,
    clientName: string,
    caregiverData: {
      caregiverId: string;
      caregiverName: string;
      caregiverPhoto?: string;
      experience?: number;
      rating?: number;
      skills?: string[];
    },
    coverLetter?: string,
    proposedRate?: number
  ): Promise<string> {
    if (!db) throw new Error('Database not initialized');

    // Credit-only job posts block cash-only caregivers from applying.
    const jobSnap = await getDoc(doc(db, 'job_posts', jobId));
    const jobData = jobSnap.exists() ? jobSnap.data() : {};
    if (jobData?.paymentMethod === 'credit') {
      const caregiverSnap = await getDoc(doc(db, 'caregivers', caregiverData.caregiverId));
      const acceptsCreditCards = caregiverSnap.exists() ? caregiverSnap.data()?.acceptsCreditCards : undefined;
      if (acceptsCreditCards === false) {
        throw new Error('This job requires credit card payment. Enable "Accepts credit cards" in your profile to apply.');
      }
    }

    // Check if already applied
    const existingQuery = query(
      collection(db, 'job_applications'),
      where('jobId', '==', jobId),
      where('caregiverId', '==', caregiverData.caregiverId)
    );
    const existing = await getDocs(existingQuery);
    if (!existing.empty) {
      throw new Error('You have already applied to this job');
    }

    const docRef = await addDoc(collection(db, 'job_applications'), {
      jobId,
      jobTitle,
      clientId,
      clientName,
      ...caregiverData,
      rating: caregiverData.rating ?? null,
      coverLetter: coverLetter ?? '',
      proposedRate: proposedRate ?? null,
      status: 'pending',
      appliedAt: serverTimestamp(),
      // Snapshot job details so card has context without extra lookups
      jobRate: jobData.rate ?? null,
      jobLocation: jobData.location || jobData.city || null,
      jobCareTypes: jobData.careTypes || [],
      jobFrequency: jobData.jobFrequency || null,
      jobDaysOfWeek: jobData.daysOfWeek || [],
    });

    return docRef.id;
  },

  async getApplicationById(applicationId: string): Promise<JobApplication | null> {
    if (!db) return null;
    const docSnap = await getDocs(query(
      collection(db, 'job_applications'),
      where('__name__', '==', applicationId)
    ));
    if (docSnap.empty) return null;
    const doc = docSnap.docs[0];
    return { id: doc.id, ...doc.data() } as JobApplication;
  },

  async updateApplicationStatus(
    applicationId: string,
    status: JobApplicationStatus
  ): Promise<void> {
    if (!db) return;
    await updateDoc(doc(db, 'job_applications', applicationId), {
      status,
      updatedAt: serverTimestamp()
    });
  }
};
