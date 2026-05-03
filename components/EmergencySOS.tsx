
import React, { useState, useRef, useEffect } from 'react';
import { AlertTriangle, X, PhoneCall } from 'lucide-react';
import { dbService, authService } from '../services/api';
import { AddToastFunction } from '../types';

interface EmergencySOSProps {
  onShowToast: AddToastFunction;
  className?: string;
  initiatorType: 'client' | 'caregiver';
}

export const EmergencySOS: React.FC<EmergencySOSProps> = ({ onShowToast, className, initiatorType }) => {
  const [isHolding, setIsHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isActive, setIsActive] = useState(false); // Modal open
  const [isSent, setIsSent] = useState(false);
  
  const holdTimerRef = useRef<number | null>(null);
  const HOLD_DURATION = 2000; // 2 seconds

  const startHold = () => {
    setIsHolding(true);
    let startTime = Date.now();
    
    holdTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min((elapsed / HOLD_DURATION) * 100, 100);
      setProgress(pct);

      if (pct >= 100) {
        triggerAlert();
      }
    }, 16);
  };

  const endHold = () => {
    setIsHolding(false);
    setProgress(0);
    if (holdTimerRef.current) clearInterval(holdTimerRef.current);
  };

  const triggerAlert = async () => {
    endHold();
    const user = authService.getCurrentUser();
    
    // Simulate getting location
    let location = { lat: 0, lng: 0 };
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => {
            location = { lat: p.coords.latitude, lng: p.coords.longitude };
        });
    }

    try {
        await dbService.triggerEmergencyAlert(user?.uid || 'anon', initiatorType, location);
        setIsSent(true);
        // Play sound
        const audio = new Audio('https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg');
        audio.play().catch(e => console.log("Audio play failed", e));
    } catch (e) {
        onShowToast("Failed to send alert", 'error');
    }
  };

  if (!isActive) {
      return (
          <button 
            onClick={() => setIsActive(true)}
            className={`bg-red-600 hover:bg-red-700 text-white font-bold rounded-full shadow-lg shadow-red-200 flex items-center justify-center transition-transform hover:scale-105 ${className}`}
          >
             <AlertTriangle className="w-6 h-6 mr-2" /> SOS
          </button>
      );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-red-600 flex flex-col items-center justify-center p-6 animate-slide-in">
       <button onClick={() => setIsActive(false)} className="absolute top-6 right-6 text-white/80 hover:text-white bg-white/10 p-2 rounded-full">
          <X size={32} />
       </button>

       {isSent ? (
           <div className="text-center text-white animate-pulse">
               <div className="w-24 h-24 bg-white rounded-full flex items-center justify-center mx-auto mb-6">
                   <PhoneCall className="w-12 h-12 text-red-600" />
               </div>
               <h2 className="text-3xl font-bold mb-2">ALERT SENT</h2>
               <p className="text-lg opacity-90 mb-8">Notifying contacts and emergency services...</p>
               <button onClick={() => { setIsSent(false); setIsActive(false); }} className="bg-white/20 hover:bg-white/30 text-white px-8 py-3 rounded-xl font-bold">
                   Dismiss
               </button>
           </div>
       ) : (
           <div className="text-center max-w-md w-full">
               <AlertTriangle className="w-20 h-20 text-white mx-auto mb-6" />
               <h2 className="text-3xl font-bold text-white mb-2">EMERGENCY MODE</h2>
               <p className="text-white/80 mb-12">Press and hold button to trigger instant alert to family members.</p>

               <div className="relative w-48 h-48 mx-auto">
                   {/* Progress Ring */}
                   <svg className="w-full h-full transform -rotate-90">
                       <circle
                         cx="96" cy="96" r="90"
                         fill="none"
                         stroke="rgba(255,255,255,0.2)"
                         strokeWidth="8"
                       />
                       <circle
                         cx="96" cy="96" r="90"
                         fill="none"
                         stroke="white"
                         strokeWidth="8"
                         strokeDasharray="565" // 2 * PI * 90
                         strokeDashoffset={565 - (565 * progress) / 100}
                         className="transition-all duration-75"
                       />
                   </svg>
                   
                   <button
                      onMouseDown={startHold}
                      onMouseUp={endHold}
                      onMouseLeave={endHold}
                      onTouchStart={startHold}
                      onTouchEnd={endHold}
                      className="absolute inset-2 bg-white rounded-full flex flex-col items-center justify-center text-red-600 shadow-2xl active:scale-95 transition-transform"
                   >
                      <span className="text-xl font-black">HOLD</span>
                      <span className="text-sm font-bold">3 SECONDS</span>
                   </button>
               </div>
           </div>
       )}
    </div>
  );
};
