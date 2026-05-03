import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Briefcase, Users, MapPin, Calendar, Loader2, MoreHorizontal,
} from 'lucide-react';
import { ClientNavigation } from './ClientNavigation';
import { useCareConnex } from '../../context/CareConnexContext';
import { dbService } from '../../services/api';
import { db } from '../../lib/firebase';
import { JobPost } from '../../types';

type Tab = 'open' | 'closed';

export const PostsPage: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser, addToast } = useCareConnex();

  const [posts, setPosts] = useState<JobPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('open');
  const [applicantCounts, setApplicantCounts] = useState<Record<string, number>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser?.uid) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    dbService.getJobPostsByClient(currentUser.uid)
      .then(list => { if (!cancelled) setPosts(list); })
      .catch(err => { if (!cancelled) { console.error(err); addToast('Could not load your posts', 'error'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentUser?.uid, addToast]);

  // Count applicants per post in parallel
  useEffect(() => {
    if (!db || posts.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(posts.map(async p => {
        try {
          const snap = await db!.collection('job_applications').where('jobId', '==', p.id).get();
          return [p.id, snap.size] as const;
        } catch {
          return [p.id, (p as any).applicantCount || 0] as const;
        }
      }));
      if (!cancelled) {
        setApplicantCounts(Object.fromEntries(entries));
      }
    })();
    return () => { cancelled = true; };
  }, [posts]);

  const { openPosts, closedPosts } = useMemo(() => ({
    openPosts: posts.filter(p => p.status === 'open'),
    closedPosts: posts.filter(p => p.status !== 'open'),
  }), [posts]);

  const visiblePosts = tab === 'open' ? openPosts : closedPosts;

  const formatSchedule = (p: JobPost) => {
    const start = p.startDate || p.date || '';
    const end = p.endDate ? `to ${p.endDate}` : '';
    return [start, end].filter(Boolean).join(' ');
  };

  const formatLocation = (p: JobPost) => {
    const parts = [p.city, p.state, p.zipCode].filter(Boolean);
    if (parts.length) return parts.join(', ');
    return p.location || '—';
  };

  const formatRate = (p: JobPost) => {
    if (p.rateFlexible || !p.rate) return 'Rate flexible';
    return `$${p.rate}/hr`;
  };

  const handleCancel = async (postId: string) => {
    if (!currentUser?.uid) return;
    setOpenMenuId(null);
    if (!window.confirm('Cancel this job post? Caregivers will no longer be able to apply.')) return;
    try {
      await dbService.cancelJobPost(postId, currentUser.uid);
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, status: 'cancelled' } : p));
      addToast('Job post cancelled', 'info');
    } catch (err: any) {
      addToast(err?.message || 'Failed to cancel post', 'error');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientNavigation />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Job posts</h1>
          <p className="text-sm text-slate-500 hidden sm:block">Get interested caregivers within minutes on job posts.</p>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2 mb-6">
          <button
            onClick={() => setTab('open')}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
              tab === 'open'
                ? 'bg-primary-50 border-primary-500 text-primary-700'
                : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
            }`}
          >
            Open Jobs ({openPosts.length})
          </button>
          <button
            onClick={() => setTab('closed')}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
              tab === 'closed'
                ? 'bg-primary-50 border-primary-500 text-primary-700'
                : 'bg-white border-slate-200 text-slate-600 hover:border-primary-300'
            }`}
          >
            Closed Jobs ({closedPosts.length})
          </button>
        </div>

        {loading ? (
          <div className="py-16 flex items-center justify-center text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mr-2" />
            Loading your posts...
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Post-new card (only on Open tab) */}
            {tab === 'open' && (
              <button
                onClick={() => navigate('/client/post-job')}
                className="flex flex-col items-center justify-center text-center border-2 border-dashed border-slate-300 rounded-2xl px-4 py-10 bg-white hover:border-primary-400 hover:bg-primary-50/30 transition-colors min-h-[200px]"
              >
                <Briefcase className="w-8 h-8 text-slate-300 mb-2" />
                <p className="text-sm text-slate-500 mb-1">Post for a specific date</p>
                <p className="text-sm text-slate-500 mb-4">or post for recurring needs</p>
                <span className="inline-flex items-center gap-1.5 text-primary-600 font-semibold">
                  <Plus className="w-4 h-4" /> Post a New Job
                </span>
              </button>
            )}

            {visiblePosts.length === 0 && tab === 'closed' && (
              <div className="md:col-span-2 text-center py-14 bg-white border border-slate-200 rounded-2xl">
                <Briefcase className="w-10 h-10 text-slate-200 mx-auto mb-2" />
                <p className="text-slate-400">No closed jobs yet.</p>
              </div>
            )}

            {visiblePosts.map(post => {
              const count = applicantCounts[post.id] ?? 0;
              return (
                <div key={post.id} className="relative bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <h3 className="font-bold text-slate-900 text-base leading-snug">{post.title}</h3>
                    {post.status === 'open' && (
                      <div className="relative">
                        <button
                          onClick={() => setOpenMenuId(openMenuId === post.id ? null : post.id)}
                          aria-label="Post options"
                          className="w-7 h-7 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                        {openMenuId === post.id && (
                          <div className="absolute right-0 mt-1 w-40 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-10">
                            <button
                              onClick={() => handleCancel(post.id)}
                              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                            >
                              Cancel post
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {post.status !== 'open' && (
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${
                        post.status === 'filled' ? 'bg-primary-50 text-primary-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {post.status}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1.5 text-sm text-slate-600 mb-4">
                    {formatSchedule(post) && (
                      <p className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        {formatSchedule(post)}
                      </p>
                    )}
                    <p className="flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      {formatLocation(post)}
                    </p>
                    <p className="text-primary-700 font-semibold">{formatRate(post)}</p>
                  </div>

                  <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                    <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                      <Users className="w-4 h-4 text-primary-600" />
                      <span className="font-semibold">{count}</span>
                      {count === 1 ? 'interested caregiver' : 'interested caregivers'}
                    </span>
                    <button
                      onClick={() => navigate('/client/inbox')}
                      className="text-sm font-semibold text-primary-600 hover:text-primary-700"
                    >
                      {count > 0 ? 'View' : 'Share post →'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default PostsPage;
