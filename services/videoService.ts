import firebase, { db, functions } from '../lib/firebase';
import { VideoInterview, VideoInterviewStatus } from '../types';


/**
 * @deprecated V5: in-app Twilio Video replaced by FaceTime/Google Meet links delivered via Cara iMessage.
 * This function is intentionally stubbed — calling it will throw.
 */
export const generateAccessToken = async (
    _identity: string,
    _roomName: string
): Promise<string> => {
    throw new Error(
        "Twilio Video removed in V5. Interviews are conducted via FaceTime/Google Meet links sent by Cara."
    );
};

export const videoService = {
    /**
     * Schedule a new video interview
     */
    async scheduleInterview(
        clientId: string,
        clientName: string,
        caregiverId: string,
        caregiverName: string,
        scheduledTime: Date,
        notes?: string,
        jobId?: string,
        jobTitle?: string,
        interviewType?: 'video' | 'phone' | 'in-person',
        caregiverPhoto?: string,
        clientPhotoURL?: string,
    ): Promise<VideoInterview> {
        console.log('🎥 [VideoService] scheduleInterview called with:', {
            clientId,
            clientName,
            caregiverId,
            caregiverName,
            scheduledTime: scheduledTime.toISOString(),
            notes
        });

        // Check database connection
        if (!db) {
            console.error('❌ [VideoService] Database not connected! db is:', db);
            throw new Error("Database not connected");
        }
        console.log('✅ [VideoService] Database connection verified');

        // Validate parameters
        if (!clientId || !clientName || !caregiverId || !caregiverName) {
            const error = new Error('Missing required parameters for interview scheduling');
            console.error('❌ [VideoService] Validation failed:', {
                clientId: !!clientId,
                clientName: !!clientName,
                caregiverId: !!caregiverId,
                caregiverName: !!caregiverName
            });
            throw error;
        }

        try {
            const roomName = `interview_${clientId}_${caregiverId}_${Date.now()}`;

            const interviewData: Omit<VideoInterview, 'id'> = {
                clientId,
                clientName,
                caregiverId,
                caregiverName,
                scheduledTime: scheduledTime.toISOString(),
                status: 'requested',
                roomName,
                createdAt: new Date().toISOString(),
                notes: notes || '',
                interviewType: interviewType || 'video',
                ...(jobId ? { jobId } : {}),
                ...(jobTitle ? { jobTitle } : {}),
                ...(caregiverPhoto ? { caregiverPhoto } : {}),
                ...(clientPhotoURL ? { clientPhotoURL } : {}),
            };

            console.log('📝 [VideoService] Attempting to write to Firestore:', interviewData);

            const docRef = await db.collection('video_interviews').add(interviewData);

            console.log('✅ [VideoService] Interview scheduled successfully! Doc ID:', docRef.id);

            // Notification handled by onVideoInterviewWrite Cloud Function

            return {
                id: docRef.id,
                ...interviewData,
            };
        } catch (error: any) {
            console.error('❌ [VideoService] Error scheduling interview:');
            console.error('Error type:', error?.constructor?.name);
            console.error('Error message:', error?.message);
            console.error('Error code:', error?.code);
            console.error('Full error:', error);
            console.error('Stack trace:', error?.stack);
            throw error;
        }
    },

    /**
     * Get all interviews for a specific user (client or caregiver)
     */
    async getUserInterviews(userId: string, userType: 'client' | 'caregiver'): Promise<VideoInterview[]> {
        if (!db) return [];

        try {
            const fieldName = userType === 'client' ? 'clientId' : 'caregiverId';
            const snapshot = await db.collection('video_interviews')
                .where(fieldName, '==', userId)
                .orderBy('scheduledTime', 'desc')
                .get();

            return snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
            } as VideoInterview));
        } catch (error) {
            console.error('Error fetching interviews:', error);
            return [];
        }
    },

    /**
     * Get a specific interview by ID
     */
    async getInterview(interviewId: string): Promise<VideoInterview | null> {
        if (!db) return null;

        try {
            const docSnap = await db.collection('video_interviews').doc(interviewId).get();

            if (docSnap.exists) {
                return {
                    id: docSnap.id,
                    ...docSnap.data(),
                } as VideoInterview;
            }
            return null;
        } catch (error) {
            console.error('Error fetching interview:', error);
            return null;
        }
    },

    /**
     * Update interview status
     */
    async updateInterviewStatus(
        interviewId: string,
        status: VideoInterviewStatus,
        additionalData?: Partial<VideoInterview>
    ): Promise<void> {
        if (!db) return;

        try {
            const updateData: any = { status };

            if (status === 'in-progress' && !additionalData?.startedAt) {
                updateData.startedAt = new Date().toISOString();
            }

            if (status === 'completed' && !additionalData?.endedAt) {
                updateData.endedAt = new Date().toISOString();
            }

            if (additionalData) {
                Object.assign(updateData, additionalData);
            }

            await db.collection('video_interviews').doc(interviewId).update(updateData);
        } catch (error) {
            console.error('Error updating interview status:', error);
            throw error;
        }
    },

    /**
     * Cancel a scheduled interview
     */
    async cancelInterview(interviewId: string, reason?: string): Promise<void> {
        try {
            await this.updateInterviewStatus(interviewId, 'cancelled', {
                notes: reason ? `Cancelled: ${reason}` : 'Cancelled',
            });
        } catch (error) {
            console.error('Error cancelling interview:', error);
            throw error;
        }
    },

    /**
     * Accept a requested interview (Caregiver action)
     */
    async acceptInterview(interviewId: string): Promise<void> {
        try {
            await this.updateInterviewStatus(interviewId, 'accepted');
        } catch (error) {
            console.error('Error accepting interview:', error);
            throw error;
        }
    },

    /**
     * Join a video interview room
     */
    async joinInterview(
        interviewId: string,
        userId: string,
        userName: string
    ): Promise<{ roomName: string; token: string }> {
        try {
            const interview = await this.getInterview(interviewId);

            if (!interview) {
                throw new Error('Interview not found');
            }

            if (interview.status === 'cancelled') {
                throw new Error('Interview has been cancelled');
            }

            if (interview.status === 'completed') {
                throw new Error('Interview has already ended');
            }

            // Update status to in-progress if it's the first person joining
            if (interview.status === 'scheduled' || interview.status === 'accepted') {
                await this.updateInterviewStatus(interviewId, 'in-progress');
            }

            const roomName = interview.roomName || `interview_${interviewId}`;
            const token = await generateAccessToken(userName, roomName);

            return { roomName, token };
        } catch (error) {
            console.error('Error joining interview:', error);
            throw error;
        }
    },

    /**
     * Get upcoming interviews (scheduled within next 24 hours)
     */
    async getUpcomingInterviews(userId: string, userType: 'client' | 'caregiver'): Promise<VideoInterview[]> {
        try {
            const allInterviews = await this.getUserInterviews(userId, userType);
            const now = new Date();
            const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

            return allInterviews.filter(interview => {
                const scheduledTime = new Date(interview.scheduledTime);
                return (
                    interview.status === 'scheduled' &&
                    scheduledTime >= now &&
                    scheduledTime <= tomorrow
                );
            });
        } catch (error) {
            console.error('Error fetching upcoming interviews:', error);
            return [];
        }
    },

    /**
     * Subscribe to real-time interview updates for a user
     */
    subscribeToInterviews(
        userId: string,
        userType: 'client' | 'caregiver',
        onUpdate: (interviews: VideoInterview[]) => void
    ): () => void {
        if (!db) return () => { };

        try {
            const field = userType === 'client' ? 'clientId' : 'caregiverId';

            console.log(`📡 Setting up interview listener for ${userType}: ${userId}`);

            const unsubscribe = db.collection('video_interviews')
                .where(field, '==', userId)
                .orderBy('scheduledTime', 'desc')
                .onSnapshot((snapshot) => {
                    const interviews: VideoInterview[] = [];
                    snapshot.forEach((doc) => {
                        interviews.push({ id: doc.id, ...doc.data() } as VideoInterview);
                    });
                    console.log(`📊 Received ${interviews.length} interviews for ${userType} ${userId}`);
                    onUpdate(interviews);
                }, (error) => {
                    console.error('Error in interview subscription:', error);
                });

            return unsubscribe;
        } catch (error) {
            console.error('Error setting up interview subscription:', error);
            return () => { };
        }
    },
};

