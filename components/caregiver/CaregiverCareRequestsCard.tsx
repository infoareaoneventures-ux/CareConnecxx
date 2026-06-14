import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Briefcase, FileText, Users, Calendar, MapPin, Video, Phone, CalendarDays,
} from 'lucide-react';
import { db } from '../../lib/firebase';

interface Props { caregiverId: string; }

export const CaregiverCareRequestsCard: React.FC<Props> = ({ caregiverId }) => {
  const navigate = useNavigate();
  const [myApplications, setMyApplications] = useState<any[]>([]);
  const [myInterviews, setMyInterviews] = useState<any[]>([]);
  const [careRequestsTab, setCareRequestsTab] = useState<'applications' | 'interviews'>('applications');
  const [ivDashTab, setIvDashTab] = useState<'pending' | 'scheduled'>('pending');

  useEffect(() => {
    if (!caregiverId || !db) return;
    const unsubs: (() => void)[] = [];
    let irList: any[] = [];
    let viList: any[] = [];
    const merge = () => {
      const combined = [...irList, ...viList].sort((a, b) => {
        const ta = a.scheduledTime || a.createdAt || 0;
        const tb = b.scheduledTime || b.createdAt || 0;
        return tb > ta ? 1 : -1;
      });
      setMyInterviews(combined);
    };
    unsubs.push(db.collection('interview_requests').where('caregiverId', '==', caregiverId).orderBy('createdAt', 'desc').onSnapshot(snap => { irList = snap.docs.map(d => ({ id: d.id, _src: 'ir', ...d.data() })); merge(); }, () => {}));
    unsubs.push(db.collection('video_interviews').where('caregiverId', '==', caregiverId).orderBy('scheduledTime', 'desc').onSnapshot(snap => { viList = snap.docs.map(d => ({ id: d.id, _src: 'vi', ...d.data() })); merge(); }, () => {}));

    db.collection('job_applications')
      .where('caregiverId', '==', caregiverId)
      .orderBy('appliedAt', 'desc')
      .limit(20)
      .get()
      .then(snap => setMyApplications(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
      .catch(() => {});

    return () => unsubs.forEach(u => { try { u(); } catch {} });
  }, [caregiverId]);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-3">
        <Briefcase className="w-4 h-4 text-primary-500" />
        <h2 className="font-semibold text-slate-900">Care Requests</h2>
      </div>

      <div className="flex bg-slate-100 rounded-lg p-0.5 mb-4">
        <button
          onClick={() => setCareRequestsTab('applications')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${careRequestsTab === 'applications' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
        >
          <FileText className="w-3.5 h-3.5" /> My Applications
        </button>
        <button
          onClick={() => setCareRequestsTab('interviews')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${careRequestsTab === 'interviews' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
        >
          <Users className="w-3.5 h-3.5" /> Interviews
        </button>
      </div>

      {careRequestsTab === 'applications' && (() => {
        const interviewJobIds = new Set(myInterviews.map((iv: any) => iv.jobId).filter(Boolean));
        const trulyPending = myApplications.filter((a: any) => a.status === 'pending' && !interviewJobIds.has(a.jobId));
        if (trulyPending.length === 0) return (
          <div className="text-center py-5">
            <p className="text-sm text-slate-400 mb-2">No pending applications</p>
            <button onClick={() => navigate('/caregiver/jobs')} className="text-xs text-primary-600 font-medium hover:underline">Browse Jobs →</button>
          </div>
        );
        return (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-700">Pending Applications</p>
              <button onClick={() => navigate('/caregiver/jobs?tab=applications')} className="text-xs text-primary-600 font-medium hover:underline flex items-center gap-0.5">View all &rsaquo;</button>
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {trulyPending.slice(0, 2).map((a: any) => {
                const appliedDate = a.appliedAt ? new Date(a.appliedAt?.toDate?.() ?? a.appliedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
                const rate = a.jobRate ?? a.rate;
                const location = a.jobLocation ?? a.location;
                const days: string[] = Array.isArray(a.jobDaysOfWeek) ? a.jobDaysOfWeek : [];
                return (
                  <div key={a.id} className="border border-slate-200 rounded-xl p-3">
                    <p className="text-sm font-bold text-slate-900 leading-snug mb-1.5">{a.jobTitle || 'Care Job'}</p>
                    {appliedDate && <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-1"><Calendar className="w-3 h-3 flex-shrink-0 text-slate-400" /><span>{appliedDate}</span></div>}
                    {location && <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-1.5"><MapPin className="w-3 h-3 flex-shrink-0 text-slate-400" /><span className="truncate">{location}</span></div>}
                    {rate != null && <p className="text-sm font-bold text-primary-600 mb-1.5">${rate}/hr</p>}
                    {days.length > 0 && <div className="flex items-center gap-1 text-xs text-slate-500"><CalendarDays className="w-3 h-3 flex-shrink-0" />{days.join(', ')}</div>}
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {careRequestsTab === 'interviews' && (() => {
        const now = new Date();
        const pendingIvs   = myInterviews.filter((iv: any) => ['pending', 'requested'].includes(iv.status));
        const scheduledIvs = myInterviews.filter((iv: any) => {
          if (!['accepted', 'confirmed', 'scheduled'].includes(iv.status)) return false;
          const t = iv.scheduledTime ? new Date(iv.scheduledTime?.toDate?.() ?? iv.scheduledTime) : null;
          return !t || t >= now;
        });
        const activeInterviews = myInterviews.filter((iv: any) => ['pending', 'requested', 'accepted', 'scheduled', 'confirmed'].includes(iv.status));
        if (activeInterviews.length === 0) return (
          <div className="text-center py-5">
            <p className="text-sm text-slate-400 mb-2">No interviews scheduled</p>
            <button onClick={() => navigate('/caregiver/jobs?tab=interviews')} className="text-xs text-primary-600 font-medium hover:underline">View Job Board →</button>
          </div>
        );
        const visibleIvs = ivDashTab === 'pending' ? pendingIvs : scheduledIvs;
        return (
          <>
            <div className="flex items-start gap-2 mb-3">
              <button onClick={() => setIvDashTab('pending')} className={`flex-1 flex flex-col items-center justify-center rounded-xl border-2 py-2 px-3 transition-all ${ivDashTab === 'pending' ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-white hover:border-amber-200'}`}>
                <span className={`text-2xl font-bold leading-none ${ivDashTab === 'pending' ? 'text-amber-600' : 'text-slate-500'}`}>{pendingIvs.length}</span>
                <span className={`text-xs font-medium mt-0.5 ${ivDashTab === 'pending' ? 'text-amber-600' : 'text-slate-400'}`}>Pending</span>
              </button>
              <button onClick={() => setIvDashTab('scheduled')} className={`flex-1 flex flex-col items-center justify-center rounded-xl border-2 py-2 px-3 transition-all ${ivDashTab === 'scheduled' ? 'border-green-400 bg-green-50' : 'border-slate-200 bg-white hover:border-green-200'}`}>
                <span className={`text-2xl font-bold leading-none ${ivDashTab === 'scheduled' ? 'text-green-600' : 'text-slate-500'}`}>{scheduledIvs.length}</span>
                <span className={`text-xs font-medium mt-0.5 ${ivDashTab === 'scheduled' ? 'text-green-600' : 'text-slate-400'}`}>Scheduled</span>
              </button>
              <button onClick={() => navigate(`/caregiver/jobs?tab=interviews&filter=${ivDashTab === 'pending' ? 'pending' : 'accepted'}`)} className="self-center ml-1 text-xs text-primary-600 font-medium hover:underline whitespace-nowrap">View all &rsaquo;</button>
            </div>
            {visibleIvs.length === 0 ? (
              <div className="text-center py-4"><p className="text-sm text-slate-400">No {ivDashTab} interviews</p></div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {visibleIvs.slice(0, 4).map((iv: any) => {
                  const scheduled = iv.scheduledTime ? new Date(iv.scheduledTime?.toDate?.() ?? iv.scheduledTime) : null;
                  const ivType = iv.interviewType || iv.type || '';
                  const isVideo = ivType === 'video';
                  return (
                    <div key={iv.id} className="border border-slate-200 rounded-xl p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-100 flex items-center justify-center flex-shrink-0">
                          {iv.clientPhotoURL || iv.clientPhoto
                            ? <img src={iv.clientPhotoURL || iv.clientPhoto} alt={iv.clientName} className="w-full h-full object-cover" />
                            : <span className="text-xs font-bold text-primary-600">{(iv.clientName || 'C')[0].toUpperCase()}</span>}
                        </div>
                        <p className="text-sm font-semibold text-slate-900 truncate">{iv.clientName || 'Client'}</p>
                      </div>
                      <div className="space-y-1">
                        {iv.jobTitle && <p className="text-xs text-slate-500 truncate">{iv.jobTitle}</p>}
                        {scheduled && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Calendar className="w-3 h-3 flex-shrink-0" /><span>{scheduled.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {scheduled.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span></div>}
                        {ivType && <div className="flex items-center gap-1.5 text-xs text-slate-500">{isVideo ? <Video className="w-3 h-3 flex-shrink-0" /> : <Phone className="w-3 h-3 flex-shrink-0" />}<span className="capitalize">{ivType}</span></div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
};
