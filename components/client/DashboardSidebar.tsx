import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Briefcase, Plus, Users, Bookmark, Search,
} from 'lucide-react';
import { db } from '../../lib/firebase';


interface JobPostSummary {
  id: string;
  title: string;
  applicantCount: number;
}

interface SavedSearch {
  name: string;
  filters: Record<string, any>;
  emailFrequency: string;
  savedAt: string;
}

interface DashboardSidebarProps {
  currentUserUid?: string;
  onChatCoordinator?: () => void;
  hideCareRequests?: boolean;
}

export const DashboardSidebar: React.FC<DashboardSidebarProps> = ({
  currentUserUid,
  hideCareRequests = false,
}) => {
  const navigate = useNavigate();
  const [jobPosts, setJobPosts] = useState<JobPostSummary[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);

  useEffect(() => {
    if (!currentUserUid || !db) return;
    let isMounted = true;
    db.collection('job_posts')
      .where('clientId', '==', currentUserUid)
      .where('status', '==', 'open')
      .get()
      .then(snap => {
        if (!isMounted) return;
        const all = snap.docs.map(d => ({
          id: d.id,
          title: (d.data() as any).title || 'Care Job',
          applicantCount: (d.data() as any).applicantCount || 0,
          createdAt: (d.data() as any).createdAt || '',
        }));
        all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        setJobPosts(all.slice(0, 3));
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, [currentUserUid]);

  useEffect(() => {
    if (!currentUserUid || !db) return;
    let isMounted = true;
    db.collection('users').doc(currentUserUid).get()
      .then(doc => {
        if (!isMounted) return;
        setSavedSearches((doc.data() as any)?.savedSearches || []);
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, [currentUserUid]);

  return (
    <div className="space-y-4">
      {/* My Job Posts */}
      {!hideCareRequests && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-primary-600" />
              Care Requests
            </h3>
            <button
              onClick={() => navigate('/client/post-job')}
              className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
            >
              <Plus className="w-3 h-3" />New
            </button>
          </div>
          <div className="p-3">
            {jobPosts.length > 0 ? (
              <div className="space-y-2">
                {jobPosts.map(post => (
                  <div key={post.id} className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-slate-700 truncate flex-1">{post.title}</p>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {post.applicantCount > 0 && (
                        <span className="flex items-center gap-0.5 text-xs bg-primary-50 text-primary-700 border border-primary-100 px-1.5 py-0.5 rounded-full font-semibold">
                          <Users className="w-2.5 h-2.5" />{post.applicantCount}
                        </span>
                      )}
                      <button
                        onClick={() => navigate('/client/posts')}
                        className="text-xs text-primary-600 font-medium hover:underline"
                      >
                        View
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => navigate('/client/posts')}
                  className="w-full mt-1 text-xs text-slate-400 hover:text-primary-600 text-center py-1 transition-colors"
                >
                  View all →
                </button>
              </div>
            ) : (
              <div className="text-center py-3">
                <Briefcase className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
                <p className="text-xs text-slate-400 leading-snug">Create a care request so caregivers can apply to you</p>
                <button
                  onClick={() => navigate('/client/post-job')}
                  className="mt-2 text-xs text-primary-600 font-medium hover:underline"
                >
                  New Request →
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Saved Searches */}
      {savedSearches.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
              <Bookmark className="w-4 h-4 text-primary-600" />
              Saved Search
            </h3>
          </div>
          <div className="p-3 space-y-2">
            {savedSearches.slice(0, 2).map((s, i) => (
              <div key={i} className="bg-slate-50 rounded-lg px-3 py-2">
                <p className="text-xs font-semibold text-slate-800 truncate">{s.name}</p>
                <p className="text-xs text-slate-400 mt-0.5 truncate">
                  {[s.filters?.searchTerm, ...(s.filters?.certifications || [])].filter(Boolean).join(' · ') || 'All caregivers'}
                </p>
                <button
                  onClick={() => navigate('/client/find-caregivers')}
                  className="mt-1.5 flex items-center gap-1 text-xs text-primary-600 font-medium hover:underline"
                >
                  <Search className="w-3 h-3" />View saved search
                </button>
              </div>
            ))}
          </div>
        </div>
      )}



    </div>
  );
};
