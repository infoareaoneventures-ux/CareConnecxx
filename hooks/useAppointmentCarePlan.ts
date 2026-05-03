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
  serverTimestamp,
  getDoc,
  getDocs,
  writeBatch,
  deleteDoc
} from 'firebase/firestore';
import { CarePlan, Appointment } from '../types';

export interface LinkedCarePlan {
  id: string;
  appointmentId: string;
  clientId: string;
  caregiverId: string;
  carePlanSnapshot: CarePlan;
  specialInstructions?: string;
  tasksCompleted: string[];
  notes?: string;
  createdAt: string;
  updatedAt?: string;
}

// Hook to link care plans to appointments
export const useAppointmentCarePlan = (appointmentId: string | null) => {
  const [linkedPlan, setLinkedPlan] = useState<LinkedCarePlan | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!appointmentId || !db) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const plansRef = collection(db, 'appointment_care_plans');
    const q = query(plansRef, where('appointmentId', '==', appointmentId));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        if (!snapshot.empty) {
          const doc = snapshot.docs[0];
          setLinkedPlan({ id: doc.id, ...doc.data() } as LinkedCarePlan);
        } else {
          setLinkedPlan(null);
        }
        setLoading(false);
      },
      (error) => {
        console.error('Linked care plan listener error:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [appointmentId]);

  const markTaskCompleted = useCallback(async (taskId: string) => {
    if (!linkedPlan || !db) return;
    
    const newTasksCompleted = [...linkedPlan.tasksCompleted, taskId];
    await updateDoc(doc(db, 'appointment_care_plans', linkedPlan.id), {
      tasksCompleted: newTasksCompleted,
      updatedAt: serverTimestamp()
    });
  }, [linkedPlan]);

  const addNote = useCallback(async (note: string) => {
    if (!linkedPlan || !db) return;
    
    await updateDoc(doc(db, 'appointment_care_plans', linkedPlan.id), {
      notes: note,
      updatedAt: serverTimestamp()
    });
  }, [linkedPlan]);

  return { linkedPlan, loading, markTaskCompleted, addNote };
};

// Hook for clients to manage care plan links
export const useClientCarePlanLinks = (clientId: string | null) => {
  const [linkedPlans, setLinkedPlans] = useState<LinkedCarePlan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clientId || !db) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const plansRef = collection(db, 'appointment_care_plans');
    const q = query(
      plansRef,
      where('clientId', '==', clientId),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const plans: LinkedCarePlan[] = [];
        snapshot.forEach((doc) => {
          plans.push({ id: doc.id, ...doc.data() } as LinkedCarePlan);
        });
        setLinkedPlans(plans);
        setLoading(false);
      },
      (error) => {
        console.error('Client care plan links listener error:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [clientId]);

  return { linkedPlans, loading };
};

// Service for managing care plan - appointment links
export const appointmentCarePlanService = {
  async linkCarePlanToAppointment(
    appointmentId: string,
    clientId: string,
    caregiverId: string,
    carePlan: CarePlan,
    specialInstructions?: string
  ): Promise<string> {
    if (!db) throw new Error('Database not initialized');

    // Check if already linked
    const existingQuery = query(
      collection(db, 'appointment_care_plans'),
      where('appointmentId', '==', appointmentId)
    );
    const existing = await getDocs(existingQuery);
    
    if (!existing.empty) {
      // Update existing
      const docId = existing.docs[0].id;
      await updateDoc(doc(db, 'appointment_care_plans', docId), {
        carePlanSnapshot: carePlan,
        specialInstructions,
        updatedAt: serverTimestamp()
      });
      return docId;
    }

    // Create new link
    const docRef = await addDoc(collection(db, 'appointment_care_plans'), {
      appointmentId,
      clientId,
      caregiverId,
      carePlanSnapshot: carePlan,
      specialInstructions,
      tasksCompleted: [],
      createdAt: serverTimestamp()
    });

    // Update appointment with care plan reference
    await updateDoc(doc(db, 'appointments', appointmentId), {
      hasCarePlan: true,
      carePlanId: docRef.id
    });

    return docRef.id;
  },

  async unlinkCarePlan(appointmentId: string): Promise<void> {
    if (!db) return;

    const q = query(
      collection(db, 'appointment_care_plans'),
      where('appointmentId', '==', appointmentId)
    );
    const snapshot = await getDocs(q);
    
    if (!snapshot.empty) {
      await deleteDoc(doc(db, 'appointment_care_plans', snapshot.docs[0].id));
      await updateDoc(doc(db, 'appointments', appointmentId), {
        hasCarePlan: false,
        carePlanId: null
      });
    }
  },

  async getCarePlanForAppointment(appointmentId: string): Promise<LinkedCarePlan | null> {
    if (!db) return null;

    const q = query(
      collection(db, 'appointment_care_plans'),
      where('appointmentId', '==', appointmentId)
    );
    const snapshot = await getDocs(q);
    
    if (snapshot.empty) return null;
    
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as LinkedCarePlan;
  },

  async completeTask(
    linkedPlanId: string,
    taskId: string,
    caregiverNotes?: string
  ): Promise<void> {
    if (!db) return;

    const planRef = doc(db, 'appointment_care_plans', linkedPlanId);
    const planDoc = await getDoc(planRef);
    
    if (!planDoc.exists()) return;

    const data = planDoc.data();
    const tasksCompleted = data.tasksCompleted || [];
    
    await updateDoc(planRef, {
      tasksCompleted: [...tasksCompleted, taskId],
      [`taskNotes.${taskId}`]: caregiverNotes,
      updatedAt: serverTimestamp()
    });
  },

  async addCaregiverReport(
    linkedPlanId: string,
    report: {
      medicationsAdministered?: string[];
      vitalSigns?: {
        bloodPressure?: string;
        heartRate?: number;
        temperature?: number;
      };
      observations?: string;
      recommendations?: string;
    }
  ): Promise<void> {
    if (!db) return;

    await updateDoc(doc(db, 'appointment_care_plans', linkedPlanId), {
      caregiverReport: report,
      reportSubmittedAt: serverTimestamp()
    });
  }
};
