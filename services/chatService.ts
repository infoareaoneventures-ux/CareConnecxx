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
  getDocs,
  serverTimestamp,
  Timestamp,
  writeBatch,
  limit,
  startAfter,
  QueryDocumentSnapshot,
  DocumentSnapshot
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { DirectMessage, Thread } from '../types';
import { validators, ValidationError } from '../utils/validation';

export const SUPPORT_AGENT_ID = 'careconnex-support';
export const SUPPORT_AGENT_NAME = 'CareConnex Support';

export interface ChatRoom {
  id: string;
  participants: string[]; // User UIDs
  participantNames: string[];
  participantAvatars: string[];
  lastMessage: string;
  lastMessageTime: string;
  lastMessageTimestamp: any;
  unreadCount: { [userId: string]: number };
  appointmentId?: string;
  isSupport?: boolean;
  createdAt: any;
}

export interface Message {
  id: string;
  chatRoomId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: any;
  createdAt: string;
  isRead: boolean;
  readBy: string[];
  type: 'text' | 'image' | 'system';
  imageUrl?: string;
}

export interface PaginationCursor {
  lastDoc: QueryDocumentSnapshot<any> | null;
  hasMore: boolean;
}

export interface PaginatedMessagesResult {
  messages: Message[];
  cursor: PaginationCursor;
}

/**
 * Chat Service for real-time messaging between clients and caregivers
 */
export const chatService = {
  /**
   * Create a new chat room for an appointment
   */
  async createChatRoom(
    clientId: string,
    clientName: string,
    caregiverId: string,
    caregiverName: string,
    appointmentId: string
  ): Promise<string> {
    // Validate inputs
    validators.id(clientId, 'clientId');
    validators.string(clientName, 'clientName', { min: 1, max: 100 });
    validators.id(caregiverId, 'caregiverId');
    validators.string(caregiverName, 'caregiverName', { min: 1, max: 100 });
    validators.id(appointmentId, 'appointmentId');

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const chatRoomRef = await addDoc(collection(fdb, 'chatRooms'), {
      participants: [clientId, caregiverId],
      participantNames: [clientName, caregiverName],
      participantAvatars: ['', ''], // Can be populated later
      lastMessage: 'Chat started for your appointment',
      lastMessageTime: new Date().toISOString(),
      lastMessageTimestamp: serverTimestamp(),
      unreadCount: { [clientId]: 0, [caregiverId]: 0 },
      appointmentId,
      createdAt: serverTimestamp()
    });

    // Add system message
    await addDoc(collection(fdb, 'chatRooms', chatRoomRef.id, 'messages'), {
      chatRoomId: chatRoomRef.id,
      senderId: 'system',
      senderName: 'CareConnex',
      text: `Chat started between ${clientName} and ${caregiverName}. You can now coordinate details for your appointment.`,
      timestamp: serverTimestamp(),
      createdAt: new Date().toISOString(),
      isRead: false,
      readBy: [],
      type: 'system'
    });

    return chatRoomRef.id;
  },

  /**
   * Get or create a chat room between two users
   */
  async getOrCreateChatRoom(
    user1Id: string,
    user1Name: string,
    user2Id: string,
    user2Name: string
  ): Promise<string> {
    // Validate inputs
    validators.id(user1Id, 'user1Id');
    validators.string(user1Name, 'user1Name', { min: 1, max: 100 });
    validators.id(user2Id, 'user2Id');
    validators.string(user2Name, 'user2Name', { min: 1, max: 100 });

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    // Check if chat room already exists
    const q = query(
      collection(fdb, 'chatRooms'),
      where('participants', 'array-contains', user1Id)
    );

    const snapshot = await getDocs(q);
    let existingRoom = null;

    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.participants.includes(user2Id)) {
        existingRoom = doc.id;
      }
    });

    if (existingRoom) {
      return existingRoom;
    }

    // Create new room
    const chatRoomRef = await addDoc(collection(fdb, 'chatRooms'), {
      participants: [user1Id, user2Id],
      participantNames: [user1Name, user2Name],
      participantAvatars: ['', ''],
      lastMessage: '',
      lastMessageTime: '',
      lastMessageTimestamp: null,
      unreadCount: { [user1Id]: 0, [user2Id]: 0 },
      createdAt: serverTimestamp()
    });

    return chatRoomRef.id;
  },

  /**
   * Send a message
   */
  async sendMessage(
    chatRoomId: string,
    senderId: string,
    senderName: string,
    text: string,
    type: 'text' | 'image' = 'text',
    imageUrl?: string
  ): Promise<void> {
    // Validate inputs
    validators.id(chatRoomId, 'chatRoomId');
    validators.id(senderId, 'senderId');
    validators.string(senderName, 'senderName', { min: 1, max: 100 });
    validators.string(text, 'text', { min: 1, max: 2000 });
    validators.enum(type, 'type', ['text', 'image', 'system']);
    if (imageUrl !== undefined) {
      validators.string(imageUrl, 'imageUrl', { max: 2000 });
    }

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const batch = writeBatch(fdb);

    // Add message
    const messageRef = doc(collection(fdb, 'chatRooms', chatRoomId, 'messages'));
    batch.set(messageRef, {
      chatRoomId,
      senderId,
      senderName,
      text,
      timestamp: serverTimestamp(),
      createdAt: new Date().toISOString(),
      isRead: false,
      readBy: [],
      type,
      imageUrl: imageUrl || null
    });

    // Update chat room with last message
    const roomRef = doc(fdb, 'chatRooms', chatRoomId);
    const roomSnap = await getDoc(roomRef);
    const roomData = roomSnap.data();
    
    if (roomData) {
      const otherParticipant = roomData.participants.find((id: string) => id !== senderId);
      const newUnreadCount = { ...roomData.unreadCount };
      newUnreadCount[otherParticipant] = (newUnreadCount[otherParticipant] || 0) + 1;

      batch.update(roomRef, {
        lastMessage: text,
        lastMessageTime: new Date().toISOString(),
        lastMessageTimestamp: serverTimestamp(),
        unreadCount: newUnreadCount
      });
    }

    await batch.commit();
  },

  /**
   * Subscribe to messages in a chat room
   */
  subscribeToMessages(
    chatRoomId: string,
    callback: (messages: Message[]) => void,
    onError?: (error: Error) => void
  ) {
    // Validate inputs
    validators.id(chatRoomId, 'chatRoomId');

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const q = query(
      collection(fdb, 'chatRooms', chatRoomId, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    return onSnapshot(q,
      (snapshot) => {
        const messages = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as Message[];
        callback(messages);
      },
      (error) => {
        console.error('Error in subscribeToMessages:', error);
        if (onError) {
          onError(error);
        } else {
          // Default error handling - callback with empty array
          callback([]);
        }
      }
    );
  },

  /**
   * Subscribe to user's chat rooms
   */
  subscribeToChatRooms(
    userId: string,
    callback: (rooms: ChatRoom[]) => void,
    onError?: (error: Error) => void
  ) {
    // Validate inputs
    validators.id(userId, 'userId');

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const q = query(
      collection(fdb, 'chatRooms'),
      where('participants', 'array-contains', userId),
      orderBy('lastMessageTimestamp', 'desc')
    );

    return onSnapshot(q, 
      (snapshot) => {
        const rooms = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatRoom[];
        callback(rooms);
      },
      (error) => {
        console.error('Error in subscribeToChatRooms:', error);
        if (onError) {
          onError(error);
        } else {
          // Default error handling - callback with empty array
          callback([]);
        }
      }
    );
  },

  /**
   * Mark messages as read
   */
  async markMessagesAsRead(chatRoomId: string, userId: string): Promise<void> {
    // Validate inputs
    validators.id(chatRoomId, 'chatRoomId');
    validators.id(userId, 'userId');

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const batch = writeBatch(fdb);

    // Get unread messages
    const q = query(
      collection(fdb, 'chatRooms', chatRoomId, 'messages'),
      where('isRead', '==', false)
    );

    const snapshot = await getDocs(q);
    
    snapshot.docs.forEach((messageDoc) => {
      const messageData = messageDoc.data();
      if (!messageData.readBy.includes(userId)) {
        const messageRef = doc(fdb, 'chatRooms', chatRoomId, 'messages', messageDoc.id);
        batch.update(messageRef, {
          isRead: true,
          readBy: [...messageData.readBy, userId]
        });
      }
    });

    // Reset unread count for this user
    const roomRef = doc(fdb, 'chatRooms', chatRoomId);
    const roomSnap = await getDoc(roomRef);
    const roomData = roomSnap.data();
    
    if (roomData) {
      const newUnreadCount = { ...roomData.unreadCount };
      newUnreadCount[userId] = 0;
      batch.update(roomRef, { unreadCount: newUnreadCount });
    }

    await batch.commit();
  },

  /**
   * Get unread message count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    // Validate inputs
    validators.id(userId, 'userId');

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const q = query(
      collection(fdb, 'chatRooms'),
      where('participants', 'array-contains', userId)
    );

    const snapshot = await getDocs(q);
    let totalUnread = 0;

    snapshot.forEach((doc) => {
      const data = doc.data();
      totalUnread += data.unreadCount?.[userId] || 0;
    });

    return totalUnread;
  },

  /**
   * Get messages for a chat room (one-time fetch)
   */
  async getMessages(chatRoomId: string, messageLimit: number = 50): Promise<Message[]> {
    // Validate inputs
    validators.id(chatRoomId, 'chatRoomId');
    validators.number(messageLimit, 'messageLimit', { min: 1, max: 100, integer: true });

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const q = query(
      collection(fdb, 'chatRooms', chatRoomId, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(messageLimit)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    })).reverse() as Message[];
  },

  /**
   * Get paginated messages for a chat room (cursor-based pagination)
   * @param chatRoomId - The chat room ID
   * @param cursor - The pagination cursor (null for first page)
   * @param messageLimit - Number of messages per page (default: 20)
   */
  async getPaginatedMessages(
    chatRoomId: string, 
    cursor: PaginationCursor | null = null,
    messageLimit: number = 20
  ): Promise<PaginatedMessagesResult> {
    // Validate inputs
    if (!chatRoomId || typeof chatRoomId !== 'string') {
      throw new Error('Invalid chatRoomId: must be a non-empty string');
    }
    if (messageLimit < 1 || messageLimit > 100) {
      throw new Error('Invalid messageLimit: must be between 1 and 100');
    }

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    let q = query(
      collection(fdb, 'chatRooms', chatRoomId, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(messageLimit + 1) // Fetch one extra to check if there are more
    );

    // Apply cursor if provided
    if (cursor?.lastDoc) {
      q = query(q, startAfter(cursor.lastDoc));
    }

    const snapshot = await getDocs(q);
    const docs = snapshot.docs;

    // Check if there are more messages
    const hasMore = docs.length > messageLimit;
    const messagesDocs = hasMore ? docs.slice(0, messageLimit) : docs;

    const messages = messagesDocs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    })).reverse() as Message[];

    const newCursor: PaginationCursor = {
      lastDoc: messagesDocs.length > 0 ? messagesDocs[messagesDocs.length - 1] : null,
      hasMore
    };

    return { messages, cursor: newCursor };
  },

  /**
   * Subscribe to paginated messages with realtime updates
   * Returns the most recent page of messages and listens for new ones
   */
  subscribeToPaginatedMessages(
    chatRoomId: string,
    callback: (result: PaginatedMessagesResult) => void,
    messageLimit: number = 20,
    onError?: (error: Error) => void
  ) {
    // Validate inputs
    if (!chatRoomId || typeof chatRoomId !== 'string') {
      throw new Error('Invalid chatRoomId: must be a non-empty string');
    }
    if (messageLimit < 1 || messageLimit > 100) {
      throw new Error('Invalid messageLimit: must be between 1 and 100');
    }

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const q = query(
      collection(fdb, 'chatRooms', chatRoomId, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(messageLimit)
    );

    return onSnapshot(q, 
      (snapshot) => {
        const messages = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as Message[];

        const result: PaginatedMessagesResult = {
          messages,
          cursor: {
            lastDoc: snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1] : null,
            hasMore: false // Realtime subscription doesn't track pagination
          }
        };
        callback(result);
      },
      (error) => {
        console.error('Error in subscribeToPaginatedMessages:', error);
        if (onError) {
          onError(error);
        } else {
          // Default error handling - callback with empty result
          callback({ messages: [], cursor: { lastDoc: null, hasMore: false } });
        }
      }
    );
  },

  /**
   * Get or create a dedicated support chat room for a user (client or caregiver).
   * The room appears in AdminMessages because subscribeToAllChatRooms shows every room.
   */
  async createOrGetSupportRoom(userId: string, userName: string): Promise<string> {
    validators.id(userId, 'userId');
    validators.string(userName, 'userName', { min: 1, max: 100 });

    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    // Look for an existing support room for this user
    const q = query(
      collection(fdb, 'chatRooms'),
      where('participants', 'array-contains', userId)
    );
    const snapshot = await getDocs(q);
    const existing = snapshot.docs.find(d => d.data().isSupport === true);
    if (existing) return existing.id;

    // Create a new support room
    const roomRef = await addDoc(collection(fdb, 'chatRooms'), {
      participants: [userId, SUPPORT_AGENT_ID],
      participantNames: [userName, SUPPORT_AGENT_NAME],
      participantAvatars: ['', ''],
      lastMessage: '',
      lastMessageTime: '',
      lastMessageTimestamp: null,
      unreadCount: { [userId]: 0, [SUPPORT_AGENT_ID]: 0 },
      isSupport: true,
      createdAt: serverTimestamp(),
    });

    return roomRef.id;
  },

  /**
   * Subscribe to ALL chat rooms (admin only — no participant filter)
   */
  subscribeToAllChatRooms(
    callback: (rooms: ChatRoom[]) => void,
    onError?: (error: Error) => void
  ) {
    const fdb = db;
    if (!fdb) throw new Error('Firestore not initialized');

    const q = query(
      collection(fdb, 'chatRooms'),
      orderBy('lastMessageTimestamp', 'desc'),
      limit(100)
    );

    return onSnapshot(q,
      (snapshot) => {
        const rooms = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data()
        })) as ChatRoom[];
        callback(rooms);
      },
      (error) => {
        console.error('Error in subscribeToAllChatRooms:', error);
        if (onError) onError(error);
        else callback([]);
      }
    );
  },
};
