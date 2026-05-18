import React, { useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileText, DollarSign, Calendar, Clock, PenTool, CheckCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { useCareConnex } from '../context/CareConnexContext';

export default function Agreement() {
  const navigate = useNavigate();
  const { caregiverId } = useParams();
  const { addToast } = useCareConnex();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSigned, setHasSigned] = useState(false);
  
  const [agreement, setAgreement] = useState({
    hourlyRate: 28,
    startDate: '',
    schedule: {
      monday: false,
      tuesday: false,
      wednesday: false,
      thursday: false,
      friday: false,
      saturday: false,
      sunday: false
    },
    startTime: '09:00',
    endTime: '17:00',
    termsAccepted: false
  });

  const caregiver = {
    id: caregiverId,
    name: 'Sarah Johnson',
    photo: ''
  };

  const handleRateChange = (value: string) => {
    const rate = parseFloat(value) || 0;
    setAgreement(prev => ({ ...prev, hourlyRate: rate }));
  };

  const handleScheduleToggle = (day: keyof typeof agreement.schedule) => {
    setAgreement(prev => ({
      ...prev,
      schedule: { ...prev.schedule, [day]: !prev.schedule[day] }
    }));
  };

  // Signature pad functions
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setIsDrawing(true);
    ctx.beginPath();
    
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    
    ctx.moveTo(clientX - rect.left, clientY - rect.top);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    
    ctx.lineTo(clientX - rect.left, clientY - rect.top);
    ctx.stroke();
    setHasSigned(true);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSigned(false);
  };

  const handleSubmit = async () => {
    if (!agreement.termsAccepted || !hasSigned) {
      addToast('Please accept the terms and sign the agreement before submitting.', 'error');
      return;
    }

    try {
      const user = auth.currentUser;
      if (!user) {
        navigate('/login');
        return;
      }

      // Save agreement to Firestore
      await db.collection('agreements').add({
        clientId: user.uid,
        caregiverId: caregiverId,
        hourlyRate: agreement.hourlyRate,
        startDate: agreement.startDate,
        schedule: agreement.schedule,
        startTime: agreement.startTime,
        endTime: agreement.endTime,
        status: 'active',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        signedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      addToast('Agreement signed successfully!', 'success');
      navigate('/client/calendar');
    } catch (error) {
      console.error('Error saving agreement:', error);
      addToast('Failed to save agreement. Please try again.', 'error');
    }
  };

  const days = [
    { key: 'monday', label: 'Mon' },
    { key: 'tuesday', label: 'Tue' },
    { key: 'wednesday', label: 'Wed' },
    { key: 'thursday', label: 'Thu' },
    { key: 'friday', label: 'Fri' },
    { key: 'saturday', label: 'Sat' },
    { key: 'sunday', label: 'Sun' }
  ];

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Care Agreement</h1>
            <p className="text-slate-600">Finalize terms with {caregiver.name}</p>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Main Form */}
          <div className="lg:col-span-2 space-y-6">
            {/* Rate Negotiation */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-center gap-3 mb-4">
                <DollarSign className="w-6 h-6 text-primary-600" />
                <h2 className="text-xl font-bold text-slate-900">Hourly Rate</h2>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-slate-700 mb-2">Rate per hour</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                    <input
                      type="number"
                      value={agreement.hourlyRate}
                      onChange={(e) => handleRateChange(e.target.value)}
                      className="w-full pl-8 pr-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>
                </div>
                <div className="text-center p-4 bg-slate-50 rounded-xl">
                  <p className="text-sm text-slate-500">Weekly Estimate</p>
                  <p className="text-2xl font-bold text-primary-600">
                    ${(agreement.hourlyRate * 40).toFixed(0)}
                  </p>
                  <p className="text-xs text-slate-400">Based on 40 hrs/week</p>
                </div>
              </div>
            </div>

            {/* Schedule */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-center gap-3 mb-4">
                <Calendar className="w-6 h-6 text-primary-600" />
                <h2 className="text-xl font-bold text-slate-900">Schedule</h2>
              </div>
              
              {/* Start Date */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-slate-700 mb-2">Start Date</label>
                <input
                  type="date"
                  value={agreement.startDate}
                  onChange={(e) => setAgreement(prev => ({ ...prev, startDate: e.target.value }))}
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              {/* Days of Week */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-slate-700 mb-3">Days of Week</label>
                <div className="grid grid-cols-7 gap-2">
                  {days.map(day => (
                    <button
                      key={day.key}
                      onClick={() => handleScheduleToggle(day.key as keyof typeof agreement.schedule)}
                      className={`p-3 rounded-xl text-sm font-medium transition-colors ${
                        agreement.schedule[day.key as keyof typeof agreement.schedule]
                          ? 'bg-primary-600 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Time Range */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Start Time</label>
                  <input
                    type="time"
                    value={agreement.startTime}
                    onChange={(e) => setAgreement(prev => ({ ...prev, startTime: e.target.value }))}
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">End Time</label>
                  <input
                    type="time"
                    value={agreement.endTime}
                    onChange={(e) => setAgreement(prev => ({ ...prev, endTime: e.target.value }))}
                    className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
            </div>

            {/* Terms */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-center gap-3 mb-4">
                <FileText className="w-6 h-6 text-primary-600" />
                <h2 className="text-xl font-bold text-slate-900">Terms & Conditions</h2>
              </div>
              <div className="p-4 bg-slate-50 rounded-xl h-48 overflow-y-auto text-sm text-slate-600 mb-4">
                <h3 className="font-bold text-slate-900 mb-2">1. Care Services</h3>
                <p className="mb-3">The caregiver agrees to provide in-home care services as specified in the care plan, including but not limited to assistance with activities of daily living, medication reminders, and companionship.</p>
                
                <h3 className="font-bold text-slate-900 mb-2">2. Payment Terms</h3>
                <p className="mb-3">The client agrees to pay the caregiver directly at the agreed hourly rate. Payment is due weekly based on hours worked.</p>
                
                <h3 className="font-bold text-slate-900 mb-2">3. Schedule</h3>
                <p className="mb-3">The caregiver will work according to the agreed schedule. Any changes must be communicated at least 24 hours in advance.</p>
                
                <h3 className="font-bold text-slate-900 mb-2">4. Cancellation</h3>
                <p className="mb-3">Either party may terminate this agreement with 7 days written notice.</p>
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreement.termsAccepted}
                  onChange={(e) => setAgreement(prev => ({ ...prev, termsAccepted: e.target.checked }))}
                  className="w-5 h-5 text-primary-600 rounded focus:ring-primary-500"
                />
                <span className="text-slate-700">I have read and agree to the terms and conditions</span>
              </label>
            </div>

            {/* Digital Signature */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-center gap-3 mb-4">
                <PenTool className="w-6 h-6 text-primary-600" />
                <h2 className="text-xl font-bold text-slate-900">Digital Signature</h2>
              </div>
              <div className="border-2 border-slate-200 rounded-xl overflow-hidden">
                <canvas
                  ref={canvasRef}
                  width={600}
                  height={150}
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                  onTouchStart={startDrawing}
                  onTouchMove={draw}
                  onTouchEnd={stopDrawing}
                  className="w-full bg-white cursor-crosshair"
                />
              </div>
              <div className="flex justify-between mt-3">
                <button
                  onClick={clearSignature}
                  className="text-sm text-slate-500 hover:text-slate-700"
                >
                  Clear Signature
                </button>
                {hasSigned && (
                  <span className="text-sm text-primary-600 flex items-center gap-1">
                    <CheckCircle className="w-4 h-4" />
                    Signed
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Summary Sidebar */}
          <div>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sticky top-24">
              <h3 className="text-lg font-bold text-slate-900 mb-4">Agreement Summary</h3>
              
              <div className="space-y-4 mb-6">
                <div className="flex justify-between">
                  <span className="text-slate-600">Caregiver</span>
                  <span className="font-medium text-slate-900">{caregiver.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Hourly Rate</span>
                  <span className="font-medium text-primary-600">${agreement.hourlyRate}/hr</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Days/Week</span>
                  <span className="font-medium text-slate-900">
                    {Object.values(agreement.schedule).filter(Boolean).length} days
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Hours/Day</span>
                  <span className="font-medium text-slate-900">
                    {Math.round((parseInt(agreement.endTime) - parseInt(agreement.startTime)) / 100 * 100) || 8} hrs
                  </span>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4 mb-6">
                <div className="flex justify-between items-center">
                  <span className="text-lg font-bold text-slate-900">Weekly Total</span>
                  <span className="text-2xl font-bold text-primary-600">
                    ${(agreement.hourlyRate * Object.values(agreement.schedule).filter(Boolean).length * 8).toFixed(0)}
                  </span>
                </div>
                <p className="text-sm text-slate-500 mt-1">Estimated based on selected schedule</p>
              </div>

              <button
                onClick={handleSubmit}
                disabled={!agreement.termsAccepted || !hasSigned || !agreement.startDate}
                className="w-full py-4 bg-gradient-to-r from-primary-600 to-blue-600 text-white font-bold rounded-xl hover:from-primary-700 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Sign Agreement
              </button>

              <p className="text-xs text-slate-500 text-center mt-4">
                By signing, you agree to hire {caregiver.name} under these terms
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
