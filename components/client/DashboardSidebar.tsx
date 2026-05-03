import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Heart, MessageSquare, Calendar, Phone, Mail, FileText, Home,
  Shield, Award, CheckCircle, Briefcase, Plus, Users, Bookmark, Search,
} from 'lucide-react';
import { Caregiver, ViewType } from '../../types';
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
  savedCaregivers: Caregiver[];
  currentUserUid?: string;
  onChatCoordinator: () => void;
  onNavigate: (view: ViewType) => void;
  onViewCaregiver: (caregiver: Caregiver) => void;
}

export const DashboardSidebar: React.FC<DashboardSidebarProps> = ({
  savedCaregivers,
  currentUserUid,
  onChatCoordinator,
  onNavigate,
  onViewCaregiver,
}) => {
  const navigate = useNavigate();
  const [jobPosts, setJobPosts] = useState<JobPostSummary[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);

  useEffect(() => {
    if (!currentUserUid || !db) return;
    let isMounted = true;
    db.collection('job_posts')
      .where('clientId', '==', currentUserUid)
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
      {/* Support */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-primary-600 to-primary-500 px-4 py-3">
          <h3 className="font-bold text-white text-sm flex items-center gap-2">
            <Heart className="w-4 h-4" />
            Need Help?
          </h3>
        </div>
        <div className="p-4">
          <p className="text-xs text-slate-500 mb-3">Our care team is here to help you find the right caregiver.</p>
          <div className="space-y-1.5 mb-3">
            <a href="mailto:support@careconnex.com" className="flex items-center gap-2 text-xs text-slate-600 hover:text-primary-600">
              <Mail className="w-3.5 h-3.5 text-slate-400" />support@careconnex.com
            </a>
          </div>
          <button onClick={onChatCoordinator} className="w-full flex items-center justify-center gap-1.5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-lg transition-colors">
            <MessageSquare className="w-3.5 h-3.5" />Chat with Us
          </button>
        </div>
      </div>

      {/* My Job Posts */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
            <Briefcase className="w-4 h-4 text-primary-600" />
            My Job Posts
          </h3>
          <button
            onClick={() => navigate('/client/post-job')}
            className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
          >
            <Plus className="w-3 h-3" />Post
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
                View all posts →
              </button>
            </div>
          ) : (
            <div className="text-center py-3">
              <Briefcase className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
              <p className="text-xs text-slate-400 leading-snug">Post a job so caregivers can apply to you</p>
              <button
                onClick={() => navigate('/client/post-job')}
                className="mt-2 text-xs text-primary-600 font-medium hover:underline"
              >
                Post a job →
              </button>
            </div>
          )}
        </div>
      </div>

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

      {/* Saved Caregivers */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
            <Heart className="w-4 h-4 text-rose-500 fill-rose-500" />
            Saved Caregivers
          </h3>
          {savedCaregivers.length > 0 && (
            <span className="text-xs text-slate-400">{savedCaregivers.length} saved</span>
          )}
        </div>
        <div className="p-3">
          {savedCaregivers.length > 0 ? (
            <div className="space-y-2">
              {savedCaregivers.slice(0, 4).map(cg => (
                <div key={cg.id} className="flex items-center gap-2.5">
                  {cg.imageUrl || cg.photo ? (
                    <img
                      src={cg.imageUrl || cg.photo}
                      alt={cg.name}
                      className="w-8 h-8 rounded-lg object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-lg bg-primary-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-bold text-primary-600">{cg.name.charAt(0).toUpperCase()}</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-800 truncate">{cg.name}</p>
                    <p className="text-xs text-slate-400">${cg.hourlyRate}/hr</p>
                  </div>
                  <button
                    onClick={() => onViewCaregiver(cg)}
                    className="text-xs text-primary-600 font-medium hover:underline whitespace-nowrap"
                  >
                    View
                  </button>
                </div>
              ))}
              <button
                onClick={() => navigate('/client/find-caregivers')}
                className="w-full mt-1 text-xs text-slate-400 hover:text-primary-600 text-center py-1 transition-colors"
              >
                Browse more →
              </button>
            </div>
          ) : (
            <div className="text-center py-3">
              <Heart className="w-6 h-6 text-slate-200 mx-auto mb-1.5" />
              <p className="text-xs text-slate-400 leading-snug">Heart a caregiver in Browse to save them here</p>
              <button
                onClick={() => navigate('/client/find-caregivers')}
                className="mt-2 text-xs text-primary-600 font-medium hover:underline"
              >
                Browse caregivers →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Digital Care Binder */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <FileText className="w-4 h-4 text-primary-600" />
          <h3 className="font-semibold text-slate-900 text-sm">Digital Care Binder</h3>
        </div>
        <div className="p-4">
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            Keep medications, emergency contacts, and daily routines in one place — shared with your caregiver before every visit.
          </p>
          <button
            onClick={() => onNavigate('care-plan')}
            className="w-full flex items-center justify-center gap-1.5 py-2 bg-primary-600 hover:bg-primary-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            Open Care Binder
          </button>
        </div>
      </div>

      {/* Care Journal */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <Home className="w-4 h-4 text-accent-500" />
          <h3 className="font-semibold text-slate-900 text-sm">Care Journal</h3>
        </div>
        <div className="p-4">
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            After each visit, your caregiver posts mood, meals, medications, and activities. Your family's daily update feed.
          </p>
          <button
            onClick={() => onNavigate('care-journal')}
            className="w-full flex items-center justify-center gap-1.5 py-2 bg-accent-500 hover:bg-accent-600 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            View Journal Updates
          </button>
        </div>
      </div>

      {/* Trust */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-900 text-sm mb-3">Why Families Trust Us</h3>
        <div className="space-y-2.5">
          {[
            { icon: <Shield className="w-4 h-4 text-primary-600" />, title: 'Background Checked', sub: 'Every caregiver verified', bg: 'bg-primary-50' },
            { icon: <Award className="w-4 h-4 text-accent-500" />, title: 'Senior Care Specialists', sub: "Dementia, Parkinson's & more", bg: 'bg-accent-50' },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className={`w-8 h-8 ${item.bg} rounded-lg flex items-center justify-center flex-shrink-0`}>{item.icon}</div>
              <div>
                <p className="text-xs font-semibold text-slate-800">{item.title}</p>
                <p className="text-xs text-slate-500">{item.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Service guarantee */}
      <div className="bg-gradient-to-br from-primary-600 to-primary-700 rounded-xl p-4 text-white">
        <p className="font-bold text-sm mb-1">Our Guarantee</p>
        <p className="text-xs text-primary-100 leading-relaxed">Love your caregiver within 7 days or we'll rematch you — free.</p>
        <div className="mt-3 text-xs text-primary-200 flex items-center gap-1.5">
          <CheckCircle className="w-3.5 h-3.5" />
          Only $29.95/mo · Cancel anytime
        </div>
      </div>
    </div>
  );
};
