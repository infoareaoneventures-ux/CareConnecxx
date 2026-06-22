import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';

export interface Report {
  id: string;
  reportedBy: string;
  reportedUser: string;
  reportedUserName: string;
  reason: string;
  details?: string | null;
  createdAt: any;
  status?: 'new' | 'reviewed';
  reporterName?: string;
}

export interface UseAdminReports {
  reports: Report[];
  loading: boolean;
  markReviewed: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

/**
 * Encapsulates all Firestore access for the admin user-reports view so the
 * component doesn't touch `db` directly (see CLAUDE.md — service/hook layer).
 * Subscribes to the `reports` collection, enriches each with the reporter's
 * display name, and exposes review/dismiss mutations.
 */
export function useAdminReports(): UseAdminReports {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!db) return;
    const unsub = db.collection('reports')
      .orderBy('createdAt', 'desc')
      .onSnapshot(async snap => {
        const raw: Report[] = snap.docs.map(d => ({
          id: d.id,
          ...(d.data() as Omit<Report, 'id'>),
          status: (d.data() as any).status || 'new',
        }));

        // Batch-fetch reporter display names
        const uniqueReporterIds = [...new Set(raw.map(r => r.reportedBy).filter(Boolean))];
        const nameMap: Record<string, string> = {};
        await Promise.all(
          uniqueReporterIds.map(async uid => {
            try {
              const snap = await db!.collection('users').doc(uid).get();
              const data = snap.data() as any;
              nameMap[uid] = data?.displayName || data?.name || data?.email?.split('@')[0] || uid.slice(0, 8);
            } catch {
              nameMap[uid] = uid.slice(0, 8);
            }
          })
        );

        setReports(raw.map(r => ({ ...r, reporterName: nameMap[r.reportedBy] || r.reportedBy?.slice(0, 8) })));
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, []);

  const markReviewed = async (id: string) => {
    if (!db) return;
    await db.collection('reports').doc(id).update({ status: 'reviewed' });
  };

  const dismiss = async (id: string) => {
    if (!db) return;
    await db.collection('reports').doc(id).delete();
  };

  return { reports, loading, markReviewed, dismiss };
}
