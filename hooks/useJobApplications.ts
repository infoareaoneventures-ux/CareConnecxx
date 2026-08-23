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
import { locationLabel } from '../utils/locationLabel';

export type JobApplicationStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'completed';

// SMS-originated applications (and any doc snapshotted from a job whose
// location was an object) can carry jobLocation as an OBJECT — rendering it
// raw crashes React. Coerce at the read boundary so every consumer gets the
// string the JobApplication type promises.
const normalizeApplication = (raw: any): JobApplication =>
  ({ ...raw, jobLocation: locationLabel(raw.jobLocation) || null }) as JobApplication;

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
  jobRateFlexible?: boolean;
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
          apps.push(normalizeApplication({ id: doc.id, ...doc.data() }));
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
          apps.push(normalizeApplication({ id: doc.id, ...doc.data() }));
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

    const jobSnap = await getDoc(doc(db, 'job_posts', jobId));
    const jobData: any = jobSnap.exists() ? jobSnap.data() : {};

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
      jobRateFlexible: !!jobData.rateFlexible,
      jobLocation: locationLabel(jobData.location) || jobData.city || null,
      jobCareTypes: jobData.careTypes || [],
      jobFrequency: jobData.jobFrequency || null,
      jobDaysOfWeek: jobData.daysOfWeek || [],
    });

    // Notification handled by onJobApplicationCreate Cloud Function
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
    return normalizeApplication({ id: doc.id, ...doc.data() });
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
