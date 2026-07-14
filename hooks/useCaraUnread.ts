import { useEffect, useState } from 'react';
import { dbService } from '../services/api';

// Live unread count for the Evia thread (threads/cara_{uid}.unreadCount — a
// scalar incremented server-side on each Evia reply, cleared by the chat tab).
// Feeds the Chat tab badge in both navigation shells.
export function useCaraUnread(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const unsub = dbService.subscribeToCaraThread((thread) => {
      const n = thread?.unreadCount;
      setCount(typeof n === 'number' && n > 0 ? n : 0);
    });
    return unsub;
  }, []);

  return count;
}
