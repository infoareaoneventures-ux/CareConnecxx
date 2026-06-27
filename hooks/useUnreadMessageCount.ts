import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';

export function useUnreadMessageCount(userId: string | null): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId || !db) return;

    const q = query(
      collection(db, 'chatRooms'),
      where('participants', 'array-contains', userId)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      let total = 0;
      snapshot.forEach((doc) => {
        const data = doc.data();
        total += data.unreadCount?.[userId] || 0;
      });
      setCount(total);
    });

    return () => unsubscribe();
  }, [userId]);

  return count;
}
