
import React, { useState } from 'react';
import { X, Briefcase, Calendar, Clock, DollarSign, MapPin, Sparkles, Car, Utensils, Moon, Activity, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { LocationInput } from './ui/LocationInput';
import { dbService, authService } from '../services/api';
import { aiService } from '../services/ai';
import { AddToastFunction } from '../types';

interface JobPostModalProps {
  onClose: () => void;
  onShowToast: AddToastFunction;
}

const TEMPLATES = [
  { 
    id: 'transport', 
    label: 'Transport', 
    icon: Car, 
    title: 'Ride to Appointment', 
    desc: 'Need a reliable driver to take senior to a medical appointment and wait for them.', 
    defaultRate: 28,
    duration: 3 
  },
  { 
    id: 'meal', 
    label: 'Meal Prep', 
    icon: Utensils, 
    title: 'Lunch & Company', 
    desc: 'Prepare a healthy lunch and provide companionship during the meal.', 
    defaultRate: 25,
    duration: 2 
  },
  { 
    id: 'morning', 
    label: 'Morning', 
    icon: Activity, 
    title: 'Morning Routine Help', 
    desc: 'Assistance with waking up, hygiene, dressing, and breakfast.', 
    defaultRate: 30,
    duration: 4 
  },
  { 
    id: 'overnight', 
    label: 'Overnight', 
    icon: Moon, 
    title: 'Overnight Watch', 
    desc: 'Stay overnight to ensure safety and assist with bathroom needs if required.', 
    defaultRate: 220, // Flat rate logic usually, but here hourly
    duration: 10 
  }
];

export const JobPostModal: React.FC<JobPostModalProps> = ({ onClose, onShowToast }) => {
  const [loading, setLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [naturalInput, setNaturalInput] = useState('');
  
  const [job, setJob] = useState({
    title: '',
    description: '',
    date: '',
    startTime: '',
    endTime: '',
    rate: 25,
    location: ''
  });

  // Real AI Logic using Gemini
  const handleAiParse = async () => {
    if (!naturalInput.trim()) return;
    setIsAnalyzing(true);

    try {
      const data = await aiService.parseJobRequest(naturalInput);
      
      setJob(prev => ({
        ...prev,
        title: data.title || prev.title,
        description: data.description || prev.description,
        date: data.date || prev.date,
        startTime: data.startTime || prev.startTime,
        endTime: data.endTime || prev.endTime,
        rate: data.rate || prev.rate,
        location: data.location || prev.location
      }));

      onShowToast("Google Gemini auto-filled your request!", 'success');
    } catch (error) {
      console.error(error);
      onShowToast("Could not understand the request. Please fill manually.", 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const applyTemplate = (t: typeof TEMPLATES[0]) => {
     setJob(prev => ({
        ...prev,
        title: t.title,
        description: t.desc,
        rate: t.defaultRate,
        startTime: '09:00', // Default
        endTime: `${9 + t.duration}:00`
     }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[JobPostModal] handleSubmit called');
    console.log('[JobPostModal] Job state:', job);
    
    // Manual validation for all required fields
    const missingFields = [];
    if (!job.title?.trim()) missingFields.push('Job Title');
    if (!job.date) missingFields.push('Date');
    if (!job.startTime) missingFields.push('Start Time');
    if (!job.location) missingFields.push('Location');
    
    if (missingFields.length > 0) {
      onShowToast(`Please fill in: ${missingFields.join(', ')}`, 'error');
      return;
    }
    
    setLoading(true);
    
    try {
      console.log('[JobPostModal] Getting current user...');
      const user = authService.getCurrentUser();
      console.log('[JobPostModal] User:', user?.uid || 'anon');
      
      console.log('[JobPostModal] Calling createJobPost...');
      await dbService.createJobPost(
        {
          ...job,
          requirements: [] 
        },
        user?.uid || 'anon'
      );
      console.log('[JobPostModal] Job posted successfully!');
      onShowToast("Job Posted! Caregivers will be notified.", 'success');
      onClose();
    } catch (e: any) {
      console.error('[JobPostModal] Error posting job:', e);
      const msg = typeof e === 'object' && e.message ? e.message : "Failed to post job.";
      onShowToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  // Helper to get static map URL
  const getMapUrl = (location: string) => {
      const encoded = encodeURIComponent(location);
      return `https://maps.googleapis.com/maps/api/staticmap?center=${encoded}&zoom=14&size=400x150&maptype=roadmap&markers=color:red%7C${encoded}&key=AIzaSyAeRUth6w1KpSzx4bid2oXdCtrFEtJrO7o`;
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden animate-slide-in flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
           <div className="flex items-center gap-3">
              <div className="bg-primary-100 p-2 rounded-full text-primary-600">
                 <Briefcase className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-bold text-slate-900">Post a Job</h2>
           </div>
           <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <X size={24} />
           </button>
        </div>

        {/* Form wrapping the scrollable area and the footer */}
        <form id="job-form" onSubmit={handleSubmit} className="flex flex-col overflow-hidden">
          <div className="overflow-y-auto p-6 space-y-6">
             
             {/* AI Magic Input */}
             <div className="bg-gradient-to-br from-primary-50 to-blue-50 p-4 rounded-2xl border border-primary-100">
                <div className="flex items-center gap-2 mb-2 text-primary-800 font-bold text-sm">
                   <Sparkles className="w-4 h-4" /> AI Quick Fill (Powered by Gemini)
                </div>
                <div className="relative">
                   <textarea 
                      className="w-full p-3 pr-12 rounded-xl border-none bg-white/80 focus:bg-white focus:ring-2 focus:ring-primary-200 text-sm resize-none h-20 placeholder:text-slate-400"
                      placeholder="e.g. I need a driver to take mom to the dentist next Tuesday from 9am to 12pm, willing to pay $30/hr..."
                      value={naturalInput}
                      onChange={(e) => setNaturalInput(e.target.value)}
                   />
                   <button 
                      type="button"
                      onClick={handleAiParse}
                      disabled={!naturalInput || isAnalyzing}
                      className="absolute bottom-2 right-2 p-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-all shadow-sm"
                   >
                      {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin"/> : <Sparkles className="w-4 h-4" />}
                   </button>
                </div>
             </div>

             {/* Quick Templates */}
             <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Quick Templates</label>
                <div className="grid grid-cols-4 gap-2">
                   {TEMPLATES.map(t => (
                      <button 
                         key={t.id}
                         type="button"
                         onClick={() => applyTemplate(t)}
                         className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all ${
                            job.title === t.title 
                               ? 'bg-primary-50 border-primary-500 text-primary-700 ring-1 ring-primary-500' 
                               : 'bg-white border-slate-200 text-slate-500 hover:border-primary-200 hover:bg-slate-50'
                         }`}
                      >
                         <t.icon className="w-6 h-6 mb-2" />
                         <span className="text-[10px] font-bold leading-tight text-center">{t.label}</span>
                      </button>
                   ))}
                </div>
             </div>

             <div className="h-px bg-slate-100 my-2"></div>

             {/* The Form Fields */}
             <div className="space-y-4">
                <Input 
                  label="Job Title" 
                  placeholder="e.g. Help with morning routine"
                  required
                  value={job.title}
                  onChange={(e) => setJob({...job, title: e.target.value})}
                />
                
                <div className="grid grid-cols-2 gap-4">
                   <Input 
                     label="Date" 
                     type="date"
                     required
                     value={job.date}
                     onChange={(e) => setJob({...job, date: e.target.value})}
                   />
                   <div>
                      <LocationInput 
                          label="Location" 
                          placeholder="Enter city or zip code"
                          value={typeof job.location === 'object' ? (job.location as any).address : job.location}
                          onChange={(val) => setJob({...job, location: typeof val === 'object' ? val.address : val})}
                      />
                   </div>
                </div>
                
                {/* Map Preview */}
                {job.location && (
                    <div className="w-full h-32 rounded-xl overflow-hidden border border-slate-200 mb-4 bg-slate-100">
                        <img 
                          src={getMapUrl(typeof job.location === 'object' ? (job.location as any).address : job.location)} 
                          alt="Location Preview" 
                          className="w-full h-full object-cover"
                          onError={(e) => (e.currentTarget.style.display = 'none')}
                        />
                    </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                   <Input 
                     label="Start Time" 
                     type="time"
                     required
                     value={job.startTime}
                     onChange={(e) => setJob({...job, startTime: e.target.value})}
                   />
                   <Input 
                     label="End Time" 
                     type="time"
                     required
                     value={job.endTime}
                     onChange={(e) => setJob({...job, endTime: e.target.value})}
                   />
                </div>

                <div>
                   <label className="block text-sm font-medium text-slate-700 mb-1">Hourly Rate ($)</label>
                   <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                      <input 
                        type="number" 
                        className="w-full pl-9 pr-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-100"
                        value={job.rate}
                        onChange={(e) => setJob({...job, rate: parseInt(e.target.value) || 0})}
                      />
                      {/* Smart Price Hint */}
                      {job.rate > 0 && (
                          <div className="absolute right-3 top-1/2 transform -translate-y-1/2 text-xs text-slate-400">
                             {job.rate >= 30 ? 'High Priority' : job.rate < 20 ? 'Low Range' : 'Market Rate'}
                          </div>
                      )}
                   </div>
                </div>

                <div>
                   <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                   <textarea 
                      className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-100 min-h-[80px] resize-none"
                      placeholder="Describe tasks needed (e.g. lifting, meal prep)..."
                      required
                      value={job.description}
                      onChange={(e) => setJob({...job, description: e.target.value})}
                    />
                </div>
             </div>
          </div>

          <div className="p-6 border-t border-slate-100 bg-slate-50">
             <Button fullWidth type="submit" disabled={loading}>
               {loading ? 'Posting...' : 'Post Job to Board'}
             </Button>
          </div>
        </form>

      </div>
    </div>
  );
};
