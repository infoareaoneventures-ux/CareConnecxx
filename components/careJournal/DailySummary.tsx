import React from 'react';
import { Heart, AlertCircle, CheckCircle, Clock, Calendar, User, Camera } from 'lucide-react';
import { CareJournalEntry } from '../../types';

interface DailySummaryProps {
  entries: CareJournalEntry[];
  seniorName: string;
  date: string;
}

/**
 * Daily Summary Card for Families
 * Shows the day's care at a glance
 */
export const DailySummary: React.FC<DailySummaryProps> = ({
  entries,
  seniorName,
  date
}) => {
  if (entries.length === 0) {
    return (
      <div className="bg-slate-50 border-2 border-slate-200 rounded-2xl p-8 text-center">
        <Clock className="w-12 h-12 text-slate-400 mx-auto mb-3" />
        <h3 className="text-xl font-bold text-slate-700 mb-2">No visits today</h3>
        <p className="text-slate-500">
          {seniorName} hasn't had any care visits today.
        </p>
      </div>
    );
  }

  const latestEntry = entries[entries.length - 1];
  const hasPhotos = entries.some(e => e.photos && e.photos.length > 0);
  const allMoods = entries.map(e => e.wellness?.mood || 'good');
  const avgMood = allMoods.includes('poor') ? 'concern' : allMoods.includes('ok') ? 'watch' : 'good';

  const moodConfig = {
    good: { icon: Heart, color: 'text-emerald-600', bg: 'bg-emerald-50', label: 'Doing Well' },
    watch: { icon: Clock, color: 'text-accent-600', bg: 'bg-accent-50', label: 'Okay Today' },
    concern: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50', label: 'Needs Attention' }
  };

  const mood = moodConfig[avgMood];
  const MoodIcon = mood.icon;

  // Calculate wellness stats
  const totalVisits = entries.length;
  const ateWellCount = entries.filter(e => e.wellness?.ateWell).length;
  const tookMedsCount = entries.filter(e => e.wellness?.tookMeds).length;
  const wasActiveCount = entries.filter(e => e.wellness?.wasActive).length;

  return (
    <div className="bg-white rounded-3xl shadow-lg border border-slate-100 overflow-hidden">
      {/* Header */}
      <div className={`${mood.bg} p-6 border-b border-slate-100`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500 mb-1">{date}</p>
            <h2 className="text-2xl font-bold text-slate-900">{seniorName}'s Day</h2>
          </div>
          <div className={`${mood.bg} p-4 rounded-2xl`}>
            <MoodIcon className={`w-10 h-10 ${mood.color}`} />
          </div>
        </div>
        <div className={`mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full ${mood.bg} border border-slate-200`}>
          <span className={`font-bold ${mood.color}`}>{mood.label}</span>
        </div>
      </div>

      {/* Wellness Summary */}
      <div className="p-6 grid grid-cols-3 gap-4 border-b border-slate-100">
        <div className="text-center p-4 bg-slate-50 rounded-xl">
          <div className={`text-3xl font-bold mb-1 ${ateWellCount === totalVisits ? 'text-emerald-600' : 'text-accent-600'}`}>
            {ateWellCount}/{totalVisits}
          </div>
          <p className="text-sm text-slate-600">Ate Well</p>
        </div>
        <div className="text-center p-4 bg-slate-50 rounded-xl">
          <div className={`text-3xl font-bold mb-1 ${tookMedsCount === totalVisits ? 'text-blue-600' : 'text-accent-600'}`}>
            {tookMedsCount}/{totalVisits}
          </div>
          <p className="text-sm text-slate-600">Took Meds</p>
        </div>
        <div className="text-center p-4 bg-slate-50 rounded-xl">
          <div className={`text-3xl font-bold mb-1 ${wasActiveCount >= totalVisits / 2 ? 'text-accent-600' : 'text-slate-400'}`}>
            {wasActiveCount}/{totalVisits}
          </div>
          <p className="text-sm text-slate-600">Active</p>
        </div>
      </div>

      {/* Visit Details */}
      <div className="p-6">
        <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-primary-600" />
          Today's Visits ({entries.length})
        </h3>

        <div className="space-y-4">
          {entries.map((entry, idx) => (
            <div key={entry.id} className="bg-slate-50 rounded-xl p-4 border border-slate-200">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                    <User className="w-5 h-5 text-primary-600" />
                  </div>
                  <div>
                    <p className="font-bold text-slate-900">Visit #{idx + 1}</p>
                    <p className="text-sm text-slate-500">
                      {new Date(entry.checkInTime).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </p>
                  </div>
                </div>
                {entry.wellness?.mood && (
                  <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                    entry.wellness.mood === 'great' ? 'bg-emerald-100 text-emerald-700' :
                    entry.wellness.mood === 'good' ? 'bg-primary-100 text-primary-700' :
                    entry.wellness.mood === 'ok' ? 'bg-accent-100 text-accent-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {entry.wellness.mood === 'great' ? 'Great' :
                     entry.wellness.mood === 'good' ? 'Good' :
                     entry.wellness.mood === 'ok' ? 'Okay' : 'Not Great'}
                  </span>
                )}
              </div>

              {/* Activities */}
              {entry.activities && entry.activities.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {entry.activities.map(activity => (
                    <span key={activity} className="px-3 py-1 bg-white rounded-lg text-sm text-slate-700 border border-slate-200">
                      {activity.charAt(0).toUpperCase() + activity.slice(1)}
                    </span>
                  ))}
                </div>
              )}

              {/* Notes */}
              {entry.notes && (
                <p className="text-slate-600 text-sm bg-white p-3 rounded-lg border border-slate-200">
                  "{entry.notes}"
                </p>
              )}

              {/* Photos */}
              {entry.photos && entry.photos.length > 0 && (
                <div className="flex gap-2 mt-3">
                  {entry.photos.slice(0, 3).map((photo, pidx) => (
                    <div key={pidx} className="w-16 h-16 rounded-lg overflow-hidden border border-slate-200">
                      <img src={photo} alt={`Visit photo ${pidx + 1}`} className="w-full h-full object-cover" />
                    </div>
                  ))}
                  {entry.photos.length > 3 && (
                    <div className="w-16 h-16 rounded-lg bg-slate-200 flex items-center justify-center text-sm font-medium text-slate-600">
                      +{entry.photos.length - 3}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
