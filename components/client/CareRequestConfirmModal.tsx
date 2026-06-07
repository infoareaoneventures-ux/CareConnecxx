import React, { useEffect, useState } from 'react';
import { X, MapPin, Clock, Calendar, DollarSign, Heart, User, Briefcase, Home } from 'lucide-react';
import { db } from '../../lib/firebase';
import { dbService } from '../../services/api';

interface Props {
  uid: string;
  onClose: () => void;
  onPosted: () => void;
  onEdit: () => void;
}

const Row: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="flex items-start gap-2.5 text-sm">
    <span className="mt-0.5 flex-shrink-0 text-slate-400">{icon}</span>
    <div className="min-w-0">
      <span className="text-slate-500 mr-1">{label}:</span>
      <span className="text-slate-800 font-medium">{value}</span>
    </div>
  </div>
);

export const CareRequestConfirmModal: React.FC<Props> = ({ uid, onClose, onPosted, onEdit }) => {
  const [wizardData, setWizardData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (!db) return;
    db.collection('job_postings').doc(uid).get()
      .then(snap => setWizardData(snap.exists ? snap.data() : null))
      .catch(() => setWizardData(null))
      .finally(() => setLoading(false));
  }, [uid]);

  const handlePost = async () => {
    if (!wizardData) return;
    setPosting(true);
    try {
      const city = wizardData.city || '';
      const state = wizardData.state || '';
      await dbService.createJobPost({
        title: `Senior care${city ? ` in ${city}` : ''}`,
        description: wizardData.jobDescription || 'Looking for a caring and reliable caregiver.',
        careTypes: wizardData.careNeeds || [],
        requirements: wizardData.careNeeds || [],
        startDate: wizardData.startDate || new Date().toISOString().split('T')[0],
        city,
        state,
        zipCode: wizardData.zipCode || '',
        location: [city, state].filter(Boolean).join(', '),
        streetAddress: wizardData.street || '',
        timeOfDay: wizardData.timeOfDay || [],
        daysOfWeek: wizardData.selectedDays || [],
        rate: wizardData.rate || 0,
        rateFlexible: !wizardData.rate,
        paymentMethod: wizardData.paymentMethod || 'cash',
        careLevel: wizardData.careLevel || 'moderate',
      }, uid);
      onPosted();
    } catch {
      setPosting(false);
    }
  };

  const recipientName = [wizardData?.careRecipientFirstName, wizardData?.careRecipientLastName].filter(Boolean).join(' ');
  const recipientParts = [
    recipientName,
    wizardData?.relationship && `(${wizardData.relationship})`,
    wizardData?.careRecipientAge && `Age ${wizardData.careRecipientAge}`,
  ].filter(Boolean).join(' · ');

  const locationParts = [wizardData?.street, wizardData?.city, wizardData?.state, wizardData?.zipCode].filter(Boolean).join(', ');

  const homeParts = [
    wizardData?.petsInHome ? 'Pets in home' : null,
    wizardData?.smokingHousehold ? 'Smoking household' : null,
  ].filter(Boolean).join(' · ');

  const rateLine = wizardData?.rateFlexible || !wizardData?.rate
    ? 'Flexible / open to discuss'
    : `$${wizardData.rate}/hr · ${wizardData.paymentMethod || 'cash'}`;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Post Your Care Request</h2>
            <p className="text-xs text-slate-400 mt-0.5">Review what caregivers will see</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-4 bg-slate-100 rounded animate-pulse" />
            ))}
          </div>
        ) : !wizardData ? (
          <div className="p-6 text-center text-slate-500">
            <p className="mb-4">No setup data found. Fill out the form to create a care request.</p>
            <button onClick={onEdit} className="text-primary-600 font-medium hover:underline">
              Create manually →
            </button>
          </div>
        ) : (
          <>
            <div className="overflow-y-auto flex-1 p-6">
              <div className="bg-slate-50 rounded-xl p-4 space-y-3">
                <h3 className="font-semibold text-slate-900 text-base">
                  Senior care{wizardData.city ? ` in ${wizardData.city}` : ''}
                </h3>

                {recipientParts && (
                  <Row icon={<User className="w-4 h-4" />} label="For" value={recipientParts} />
                )}

                {locationParts && (
                  <Row icon={<MapPin className="w-4 h-4" />} label="Location" value={locationParts} />
                )}

                {wizardData.startDate && (
                  <Row icon={<Calendar className="w-4 h-4" />} label="Start date" value={wizardData.startDate} />
                )}

                {wizardData.careFrequency && (
                  <Row icon={<Briefcase className="w-4 h-4" />} label="Frequency" value={wizardData.careFrequency} />
                )}

                {wizardData.selectedDays?.length > 0 && (
                  <Row
                    icon={<Calendar className="w-4 h-4" />}
                    label="Days"
                    value={wizardData.selectedDays.join(', ') + (wizardData.daysFlexible ? ' (flexible)' : '')}
                  />
                )}

                {wizardData.timeOfDay?.length > 0 && (
                  <Row icon={<Clock className="w-4 h-4" />} label="Time of day" value={wizardData.timeOfDay.join(', ')} />
                )}

                {wizardData.careNeeds?.length > 0 && (
                  <Row icon={<Heart className="w-4 h-4" />} label="Care needs" value={wizardData.careNeeds.join(', ')} />
                )}

                <Row icon={<DollarSign className="w-4 h-4" />} label="Rate" value={rateLine} />

                {homeParts && (
                  <Row icon={<Home className="w-4 h-4" />} label="Home" value={homeParts} />
                )}

                {wizardData.jobDescription && (
                  <div className="pt-1 border-t border-slate-200">
                    <p className="text-xs text-slate-500 mb-1">Description</p>
                    <p className="text-sm text-slate-700 leading-relaxed">{wizardData.jobDescription}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 pb-6 pt-4 border-t border-slate-100 flex-shrink-0 space-y-2">
              <button
                onClick={handlePost}
                disabled={posting}
                className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-semibold rounded-xl transition-colors disabled:opacity-60"
              >
                {posting ? 'Posting...' : 'Post Care Request'}
              </button>
              <button
                onClick={onEdit}
                className="w-full py-2 text-sm text-slate-500 hover:text-slate-700 font-medium transition-colors"
              >
                Edit before posting →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
