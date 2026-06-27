
import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Sparkles, Mic, MapPin, Star, User, ChevronRight, SlidersHorizontal, Check, Calendar, Clock, ShieldCheck, Trash2, Loader2, Video, HelpCircle } from 'lucide-react';
import { Caregiver, ChatMessage, Appointment, Senior } from '../types';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { aiService } from '../services/ai';
import { availabilityService } from '../services/availabilityService';
import { matchService } from '../services/matchService';
import { dbService } from '../services/api';
import { auth, functions } from '../lib/firebase';
import { logMatchSignal } from '../services/matchFeedback';
import { InlineCaregiverCard } from './InlineCaregiverCard';
import { useBookingFlow } from '../hooks/useBookingFlow';
import { featuredCapabilities, capabilityExample, capabilityLabel, buildCapabilityMenu, isSpanish } from '../constants/caraCapabilities';

// Locale source for bilingual hints (U5). preferredLanguage from the user doc
// isn't plumbed into this component, so we fall back to the browser locale.
const UI_LOCALE = typeof navigator !== 'undefined' ? navigator.language : 'en';

interface AiSearchAgentProps {
  isOpen: boolean;
  onClose: () => void;
  caregivers: Caregiver[];
  onBookCaregiver: (caregiver: Caregiver) => void;
  onViewProfile?: (caregiver: Caregiver) => void;
  onScheduleInterview?: (caregiver: Caregiver) => void;
  initialQuery?: string;
  seniorProfile?: Senior;
  previousBookings?: Appointment[];
}

const AVAILABLE_SKILLS = [
  "Hoyer Lift",
  "CPR Certified",
  "Wound Care",
  "Dementia Care",
  "Certified Nurse",
  "Mobility Expert",
  "Cook",
  "Driver"
];

const STORAGE_KEY = 'care_sync_ai_chat_history';

export const AiSearchAgent: React.FC<AiSearchAgentProps> = ({
  isOpen,
  onClose,
  caregivers,
  onBookCaregiver,
  onViewProfile,
  onScheduleInterview,
  initialQuery,
  seniorProfile,
  previousBookings = []
}) => {
  // Initialize messages from localStorage if available
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error("Failed to parse chat history", e);
    }
    return [{
      id: '1',
      sender: 'ai',
      text: "Hi Martha! I'm your Care Concierge. Tell me what you need help with today?"
    }];
  });

  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [caraAvailable, setCaraAvailable] = useState<boolean | null>(null);

  // Filter State
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [filters, setFilters] = useState({
    verifiedOnly: false,
    minMatchScore: 80,
    maxHourlyRate: 50,
    minRating: 0,
    selectedSkills: [] as string[],
    date: '',
    time: ''
  });

  // Booking state
  const { bookingState, updateBookingState, isComplete, reset: resetBooking } = useBookingFlow();
  const [matchedCaregivers, setMatchedCaregivers] = useState<Caregiver[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasProcessedInitialQuery = useRef(false);

  // Cache backend matches so we don't fetch on every message
  const backendMatchesRef = useRef<Map<string, { score: number; reasons: string[] }> | null>(null);
  const loadBackendMatches = async (): Promise<Map<string, { score: number; reasons: string[] }>> => {
    if (backendMatchesRef.current) return backendMatchesRef.current;
    if (!auth) return new Map();
    const user = auth.currentUser;
    if (!user) return new Map();
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 5000));
    const data = await Promise.race([dbService.getClientMatches(user.uid).catch(() => null), timeout]);
    const map = new Map<string, { score: number; reasons: string[] }>(
      (data?.topMatches || []).map(m => [m.caregiverId, { score: m.score, reasons: m.reasons }] as [string, { score: number; reasons: string[] }])
    );
    backendMatchesRef.current = map;
    return map;
  };

  // Apply backend AI scores onto a caregiver list, sorted by score desc
  const applyBackendScores = (cgList: Caregiver[], scoreMap: Map<string, { score: number; reasons: string[] }>): Caregiver[] => {
    if (!scoreMap.size) return cgList;
    return cgList
      .map(cg => {
        const m = scoreMap.get(cg.id);
        return m ? { ...cg, matchScore: m.score, matchReasoning: m.reasons[0] || '' } : cg;
      })
      .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  };

  // Handle Initial Query
  useEffect(() => {
    if (isOpen && initialQuery && !hasProcessedInitialQuery.current) {
      hasProcessedInitialQuery.current = true;
      sendMessage(initialQuery);
    }
    // Reset flag when closed so it can run again next time
    if (!isOpen) {
      hasProcessedInitialQuery.current = false;
    }
  }, [isOpen, initialQuery]);

  // Scroll to bottom when messages change or typing status changes
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isTyping, isOpen]);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  if (!isOpen) return null;

  const handleClearHistory = () => {
    const defaultMsg: ChatMessage = {
      id: '1',
      sender: 'ai',
      text: "Hi Martha! I'm your Care Concierge. Tell me what you need help with today?"
    };
    setMessages([defaultMsg]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([defaultMsg]));
  };

  const toggleSkill = (skill: string) => {
    setFilters(prev => ({
      ...prev,
      selectedSkills: prev.selectedSkills.includes(skill)
        ? prev.selectedSkills.filter(s => s !== skill)
        : [...prev.selectedSkills, skill]
    }));
  };

  const applyFilters = async () => {
    setIsFilterOpen(false);

    // Simplified trigger for the effect:
    const userText = "I applied some filters. Can you update the list?";
    const userMsg: ChatMessage = { id: Date.now().toString(), sender: 'user', text: userText };
    setMessages(prev => [...prev, userMsg]);

    // Run async filtering with real availability checking
    await processClientSideFilter();
  };

  const processClientSideFilter = async () => {
    setIsTyping(true);
    
    try {
      let matches: Caregiver[];
      
      // Use backend AI matches when available; fall back to client-side scoring
      if (filters.date && filters.time) {
        const [year, month, day] = filters.date.split('-').map(Number);
        const requestedDate = new Date(year, month - 1, day);

        const scoreMap = await loadBackendMatches();
        if (scoreMap.size > 0) {
          matches = applyBackendScores(caregivers, scoreMap);
          // Apply date/time availability filter client-side on pre-ranked list
          const availChecks = await Promise.all(
            matches.map(async cg => {
              try {
                return await availabilityService.isAvailable(cg as any, requestedDate, filters.time, 2) ? cg : null;
              } catch { return cg; }
            })
          );
          const available = availChecks.filter(Boolean) as Caregiver[];
          if (available.length >= 2) matches = available;
        } else {
          matches = await matchService.scoreCaregivers(
            caregivers,
            seniorProfile || { id: 0, name: 'Client', age: 75, location: 'Nearby', zipCode: '', needs: [], personality: 'Ambivert' },
            [],
            { requestedDate, requestedTime: filters.time, requestedDuration: 2 }
          );
        }

        // Apply additional filters on top of scoring
        matches = matches.filter(c => {
          if (filters.verifiedOnly && !c.verified) return false;
          if (c.hourlyRate > filters.maxHourlyRate) return false;
          if (filters.minRating > 0 && (c.rating || 0) < filters.minRating) return false;
          if (filters.selectedSkills.length > 0) {
            const hasSkill = filters.selectedSkills.every(skill => {
              const inPersonality = c.personalityTags?.includes(skill);
              const inMedical = c.medicalSkills?.includes(skill);
              const inCerts = c.certifications?.includes(skill);
              const isDriver = skill === "Driver" && c.hasTransportation;
              return inPersonality || inMedical || inCerts || isDriver;
            });
            if (!hasSkill) return false;
          }
          return true;
        });
      } else {
        // Fallback to client-side filtering if no date/time selected
        matches = caregivers.filter(c => {
          if (filters.verifiedOnly && !c.verified) return false;
          if (c.matchScore < filters.minMatchScore) return false;
          if (c.hourlyRate > filters.maxHourlyRate) return false;
          if (filters.minRating > 0 && (c.rating || 0) < filters.minRating) return false;
          if (filters.selectedSkills.length > 0) {
            const hasSkill = filters.selectedSkills.every(skill => {
              const inPersonality = c.personalityTags?.includes(skill);
              const inMedical = c.medicalSkills?.includes(skill);
              const inCerts = c.certifications?.includes(skill);
              const isDriver = skill === "Driver" && c.hasTransportation;
              return inPersonality || inMedical || inCerts || isDriver;
            });
            if (!hasSkill) return false;
          }
          return true;
        });
      }

      const aiMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: matches.length > 0 
          ? `Based on your filters${filters.date && filters.time ? ' and real-time availability' : ''}, here are ${matches.length} caregivers.` 
          : "No exact matches found for those filters.",
        recommendedCaregivers: matches.length > 0 ? matches : undefined
      };
      setMessages(prev => [...prev, aiMessage]);
    } catch (error) {
      console.error('Filter failed:', error);
      const aiMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: 'ai',
        text: "Sorry, I couldn't apply those filters right now. Please try again."
      };
      setMessages(prev => [...prev, aiMessage]);
    } finally {
      setIsTyping(false);
    }
  };

  // Try Cara (backend qaAgent) first; fall back to Gemini if unavailable
  const processAiResponse = async (userText: string) => {
    setIsTyping(true);

    try {
      // ── Cara path ──────────────────────────────────────────────────────────
      if (caraAvailable !== false && functions && auth?.currentUser) {
        try {
          const caraFn = functions.httpsCallable('v1-chatWithCara');
          const result = await caraFn({ message: userText });
          const data = result.data as {
            available: boolean;
            reply: string;
            showMatches?: boolean;
            rateLimited?: boolean;
          };

          if (data.available) {
            setCaraAvailable(true);
            let recommendedCaregivers: Caregiver[] | undefined;

            if (data.showMatches) {
              const scoreMap = await loadBackendMatches();
              let matches = applyBackendScores(caregivers, scoreMap);
              if (filters.date && filters.time) {
                const [year, month, day] = filters.date.split('-').map(Number);
                const requestedDate = new Date(year, month - 1, day);
                const availChecks = await Promise.all(
                  matches.slice(0, 20).map(async cg => {
                    try { return await availabilityService.isAvailable(cg as any, requestedDate, filters.time, 2) ? cg : null; }
                    catch { return cg; }
                  })
                );
                const available = availChecks.filter(Boolean) as Caregiver[];
                if (available.length >= 2) matches = available;
              }
              recommendedCaregivers = matches.slice(0, 5);
            }

            setMessages(prev => [...prev, {
              id: Date.now().toString(),
              sender: 'ai',
              text: data.reply || "I'm listening, tell me more about what you need.",
              recommendedCaregivers,
            }]);
            return;
          }

          // available: false means user isn't onboarded to Linq — fall through to Gemini
          setCaraAvailable(false);
        } catch (caraErr) {
          console.warn('Cara callable unavailable, falling back to Gemini:', caraErr);
          setCaraAvailable(false);
        }
      }

      // ── Gemini fallback ────────────────────────────────────────────────────
      const history = messages.map(m => ({
        role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text
      }));

      let targetCaregiverSchedule = undefined;
      const targetId = bookingState.selectedCaregiverId;
      if (targetId) {
        const caregiver = caregivers.find(c => c.id === targetId);
        if (caregiver) targetCaregiverSchedule = caregiver.weeklyAvailability;
      }

      const bookingResult = await aiService.conversationalBooking(history, bookingState, {
        previousBookings,
        seniorProfile,
        targetCaregiverSchedule
      });

      if (bookingResult.extractedInfo) updateBookingState(bookingResult.extractedInfo);

      const isEmergency = bookingResult.isEmergency || false;
      let recommendedCaregivers: Caregiver[] | undefined;

      if (bookingResult.readyToShowMatches || (isEmergency && bookingResult.extractedInfo?.service)) {
        if (filters.date && filters.time) {
          const [year, month, day] = filters.date.split('-').map(Number);
          const requestedDate = new Date(year, month - 1, day);
          const scoreMap = await loadBackendMatches();
          let matches: Caregiver[];
          if (scoreMap.size > 0) {
            matches = applyBackendScores(caregivers, scoreMap);
            const availChecks = await Promise.all(
              matches.slice(0, 20).map(async cg => {
                try { return await availabilityService.isAvailable(cg as any, requestedDate, filters.time, 2) ? cg : null; }
                catch { return cg; }
              })
            );
            const available = availChecks.filter(Boolean) as Caregiver[];
            if (available.length >= 2) matches = available;
          } else {
            matches = await matchService.scoreCaregivers(
              caregivers,
              seniorProfile || { id: 0, name: 'Client', age: 75, location: 'Nearby', zipCode: '', needs: bookingResult.extractedInfo?.service ? [bookingResult.extractedInfo.service] : [], personality: 'Ambivert' },
              [],
              { requestedDate, requestedTime: filters.time, requestedDuration: 2 }
            );
          }
          if (isEmergency) {
            const emergency = matches.filter(c => c.verified && (c.rating || 0) >= 4.5);
            if (emergency.length >= 1) matches = emergency;
          }
          recommendedCaregivers = matches.slice(0, 5);
        } else {
          const scoreMap = await loadBackendMatches();
          const query = `${bookingResult.extractedInfo?.service || ''} ${userText}`.trim();
          const { recommendedIds } = await aiService.searchCaregivers(query, caregivers, seniorProfile);
          let matches = recommendedIds?.length ? caregivers.filter(c => recommendedIds.includes(c.id)) : caregivers;
          if (scoreMap.size > 0) matches = applyBackendScores(matches, scoreMap);
          if (isEmergency) {
            const emergency = matches.filter(c => c.verified && (c.rating || 0) >= 4.5).sort((a, b) => (b.rating || 0) - (a.rating || 0));
            if (emergency.length >= 1) matches = emergency;
          }
          recommendedCaregivers = matches.slice(0, 5);
        }
      }

      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        sender: 'ai',
        text: bookingResult.response || "I'm listening, tell me more about what you need.",
        recommendedCaregivers,
        suggestions: bookingResult.suggestions,
        isEmergency,
      }]);
    } catch (e) {
      console.error("AI Error", e);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        sender: 'ai',
        text: "I'm having trouble connecting right now. Please try again."
      }]);
    } finally {
      setIsTyping(false);
    }
  };

  // Handle booking from inline caregiver card
  const handleBookCaregiver = (caregiverId: string) => {
    const caregiver = caregivers.find(c => c.id === caregiverId);
    if (!caregiver) return;

    // Update booking state
    updateBookingState({ selectedCaregiverId: caregiverId });

    // Add confirmation message
    const confirmMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'ai',
      text: `Great choice! I'm booking ${caregiver.name} for you. ${bookingState.date && bookingState.time ? `They'll arrive on ${bookingState.date} at ${bookingState.time}.` : ''} The total will be $${caregiver.hourlyRate * (bookingState.duration || 1)} (${bookingState.duration || 1} hours × $${caregiver.hourlyRate}/hr). Would you like to confirm this booking?`
    };
    setMessages(prev => [...prev, confirmMsg]);

    // If we have all info, trigger the actual booking
    if (isComplete()) {
      onBookCaregiver(caregiver);
      resetBooking();
    }
  };

  const handleSend = () => {
    if (!inputValue.trim()) return;
    sendMessage(inputValue);
  };

  // U5: render the capability menu as a Cara bubble (in-app /help). Reuses the
  // normal message rendering path — no new UI surface.
  const showHelpMenu = (echoUser: boolean) => {
    setInputValue('');
    setMessages(prev => [
      ...prev,
      ...(echoUser ? [{ id: Date.now().toString(), sender: 'user' as const, text: '/help' }] : []),
      { id: `${Date.now()}-help`, sender: 'ai' as const, text: buildCapabilityMenu('client', UI_LOCALE) },
    ]);
  };

  const sendMessage = (text: string) => {
    // Intercept the /help command (and "help"/"ayuda") → show the capability menu.
    const norm = text.trim().toLowerCase();
    if (norm === '/help' || norm === 'help' || norm === 'ayuda') {
      showHelpMenu(true);
      return;
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: text
    };

    setMessages(prev => [...prev, userMsg]);
    const textToProcess = text;
    setInputValue('');
    processAiResponse(textToProcess);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSend();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 md:p-6">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />

      <div className="relative bg-white w-full max-w-lg h-[650px] max-h-[90vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-slide-in">

        {/* Header */}
        <div className="bg-primary-600 p-4 flex justify-between items-center shadow-md z-20 relative">
          <div className="flex items-center text-white">
            <div className="bg-white/20 p-2 rounded-full mr-3">
              <Sparkles className="w-5 h-5 text-primary-50" />
            </div>
            <div>
              <h3 className="font-bold">Care Concierge</h3>
              <p className="text-xs text-primary-100 flex items-center">
                <span className="w-2 h-2 bg-green-400 rounded-full mr-1 animate-pulse"></span>
                {caraAvailable === true ? 'Cara AI Active' : 'Gemini AI Active'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleClearHistory}
              title="Clear Chat History"
              className="text-primary-100 hover:text-white hover:bg-white/10 p-2 rounded-full transition-colors"
            >
              <Trash2 className="w-5 h-5" />
            </button>
            <button
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              className={`p-2 rounded-full transition-colors ${isFilterOpen ? 'bg-white text-primary-600' : 'text-primary-100 hover:bg-white/10 hover:text-white'}`}
            >
              <SlidersHorizontal className="w-5 h-5" />
            </button>
            <button onClick={onClose} className="text-primary-100 hover:text-white hover:bg-white/10 p-2 rounded-full transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Filter Panel (Slide Down) */}
        <div className={`absolute top-[72px] left-0 right-0 bg-white border-b border-slate-100 shadow-lg z-10 transition-all duration-300 ease-in-out overflow-hidden ${isFilterOpen ? 'max-h-[550px] opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="p-5 space-y-4 max-h-[450px] overflow-y-auto">
            <div className="flex justify-between items-center">
              <h4 className="font-bold text-slate-800">Filter Recommendations</h4>
              <button onClick={() => setIsFilterOpen(false)} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
            </div>

            {/* Availability Section */}
            <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3 rounded-xl border border-slate-100">
              <div>
                <span className="flex items-center text-sm font-medium text-slate-700 mb-2">
                  <Calendar className="w-4 h-4 mr-1 text-primary-600" /> Date
                </span>
                <input
                  type="date"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-primary-500 transition-colors"
                  value={filters.date}
                  onChange={(e) => setFilters({ ...filters, date: e.target.value })}
                />
              </div>
              <div>
                <span className="flex items-center text-sm font-medium text-slate-700 mb-2">
                  <Clock className="w-4 h-4 mr-1 text-primary-600" /> Time
                </span>
                <input
                  type="time"
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-primary-500 transition-colors"
                  value={filters.time}
                  onChange={(e) => setFilters({ ...filters, time: e.target.value })}
                />
              </div>
            </div>

            {/* Verified Toggle */}
            <label className="flex items-center justify-between p-3 rounded-xl border border-slate-100 cursor-pointer hover:bg-slate-50">
              <span className="flex items-center font-medium text-slate-700">
                <Badge variant="success" className="mr-2">Verified</Badge> Only
              </span>
              <div className={`w-12 h-6 rounded-full p-1 transition-colors ${filters.verifiedOnly ? 'bg-primary-600' : 'bg-slate-200'}`}>
                <div className={`bg-white w-4 h-4 rounded-full shadow-sm transition-transform ${filters.verifiedOnly ? 'translate-x-6' : 'translate-x-0'}`}></div>
              </div>
              <input type="checkbox" className="hidden" checked={filters.verifiedOnly} onChange={() => setFilters({ ...filters, verifiedOnly: !filters.verifiedOnly })} />
            </label>

            {/* Rating Slider */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-slate-600">Min. Rating</span>
                <div className="flex items-center font-bold text-slate-900">
                  <Star className="w-3 h-3 text-accent-400 fill-current mr-1" />
                  {filters.minRating === 0 ? "Any" : `${filters.minRating}+`}
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="5"
                step="0.5"
                value={filters.minRating}
                onChange={(e) => setFilters({ ...filters, minRating: parseFloat(e.target.value) })}
                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-teal-600"
              />
            </div>

            {/* Price Slider */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-slate-600">Max Hourly Rate</span>
                <span className="font-bold text-slate-900">${filters.maxHourlyRate}/hr</span>
              </div>
              <input
                type="range"
                min="15"
                max="60"
                value={filters.maxHourlyRate}
                onChange={(e) => setFilters({ ...filters, maxHourlyRate: parseInt(e.target.value) })}
                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-teal-600"
              />
            </div>

            {/* Match Score */}
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-slate-600">Min. Match Score</span>
                <span className="font-bold text-slate-900">{filters.minMatchScore}%</span>
              </div>
              <input
                type="range"
                min="50"
                max="99"
                value={filters.minMatchScore}
                onChange={(e) => setFilters({ ...filters, minMatchScore: parseInt(e.target.value) })}
                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-teal-600"
              />
            </div>

            {/* Skills */}
            <div>
              <span className="block text-sm text-slate-600 mb-2">Required Skills / Certs</span>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_SKILLS.map(skill => (
                  <button
                    key={skill}
                    onClick={() => toggleSkill(skill)}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${filters.selectedSkills.includes(skill)
                      ? 'bg-primary-100 text-primary-800 border-primary-200'
                      : 'bg-white text-slate-500 border-slate-200 hover:border-primary-200'
                      }`}
                  >
                    {skill}
                  </button>
                ))}
              </div>
            </div>

            <Button fullWidth onClick={applyFilters}>Apply Filters</Button>
          </div>
        </div>

        {/* Chat Area */}
        <div className="flex-grow overflow-y-auto p-4 space-y-4 bg-slate-50 scrollbar-hide">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>

              {/* Message Bubble */}
              <div className={`max-w-[85%] p-4 rounded-2xl shadow-sm ${msg.sender === 'user'
                ? 'bg-primary-600 text-white rounded-br-none'
                : msg.isEmergency
                  ? 'bg-red-50 text-slate-800 border-2 border-red-500 rounded-bl-none'
                  : 'bg-white text-slate-800 border border-slate-100 rounded-bl-none'
                }`}>

                {/* Emergency Badge */}
                {msg.isEmergency && msg.sender === 'ai' && (
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b border-red-200">
                    <div className="flex items-center gap-1.5 bg-red-600 text-white px-3 py-1 rounded-full text-xs font-bold animate-pulse">
                      <span className="w-2 h-2 bg-white rounded-full"></span>
                      URGENT
                    </div>
                    <span className="text-xs text-red-700 font-medium">Emergency mode activated - showing priority caregivers</span>
                  </div>
                )}

                <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>

                {/* Proactive Suggestions Chips */}
                {msg.suggestions && msg.suggestions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2 animate-fade-in">
                    {msg.suggestions.map((suggestion, idx) => (
                      <button
                        key={idx}
                        onClick={() => sendMessage(suggestion)}
                        className="text-[10px] md:text-xs bg-primary-50 text-primary-700 px-2 py-1 rounded-lg border border-primary-100 hover:bg-primary-100 transition-colors"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Recommended Caregivers Cards */}
              {msg.recommendedCaregivers && (
                <div className="mt-3 w-full max-w-[90%] space-y-2">
                  {msg.recommendedCaregivers.map(caregiver => (
                    <div key={caregiver.id} className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm flex gap-3 animate-slide-in hover:shadow-md transition-shadow">
                      <img src={caregiver.imageUrl} alt={caregiver.name} className="w-16 h-16 rounded-lg object-cover bg-slate-200" />
                      <div className="flex-grow">
                        <div className="flex justify-between items-start">
                          <h4 className="font-bold text-slate-900 text-sm">{caregiver.name}</h4>
                          <span className="text-xs font-bold text-primary-600">${caregiver.hourlyRate}/hr</span>
                        </div>
                        <div className="flex items-center text-xs text-slate-500 mt-1">
                          <Star className="w-3 h-3 text-accent-400 mr-1" fill="currentColor" />
                          <span className="font-medium mr-1 text-slate-900">{(caregiver.rating ?? 0).toFixed(1)}</span>
                          <span className="text-slate-400 mr-2">({caregiver.matchScore}% Match)</span>
                          <MapPin className="w-3 h-3 mr-1" />
                          <span>{caregiver.distance} mi</span>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {caregiver.verified && (
                            <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-100 text-[10px] rounded font-medium flex items-center">
                              <ShieldCheck className="w-3 h-3 mr-0.5" /> Verified
                            </span>
                          )}
                          {/* Match Reason Tag (Dynamic) */}
                          {caregiver.matchReasons && caregiver.matchReasons.length > 0 && (
                            <span className="px-1.5 py-0.5 bg-green-50 text-green-700 border border-green-100 text-[10px] rounded font-bold">
                              {caregiver.matchReasons[0]}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 text-[10px] text-slate-400">
                          Avail: {caregiver.availability.slice(0, 3).join(", ")}{caregiver.availability.length > 3 ? "..." : ""}
                        </div>
                        {/* Action Buttons */}
                        <div className="mt-2 grid grid-cols-3 gap-2">
                          <button
                            onClick={() => {
                              logMatchSignal(caregiver.id, 'hired').catch(() => {});
                              onBookCaregiver(caregiver);
                              setTimeout(() => onClose(), 100);
                            }}
                            className="py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-xs font-bold rounded-lg transition-colors"
                          >
                            Book
                          </button>
                          <button
                            onClick={() => {
                              logMatchSignal(caregiver.id, 'favorited').catch(() => {});
                              onViewProfile?.(caregiver);
                              setTimeout(() => onClose(), 100);
                            }}
                            className="py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg transition-colors"
                          >
                            Profile
                          </button>
                          <button
                            onClick={() => {
                              logMatchSignal(caregiver.id, 'interviewed').catch(() => {});
                              onScheduleInterview?.(caregiver);
                              setTimeout(() => onClose(), 100);
                            }}
                            className="py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-700 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1"
                          >
                            <Video className="w-3 h-3" />
                            Call
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Quick Actions (only show if last message was AI) */}
          {messages.length > 0 && messages[messages.length - 1].sender === 'ai' && !isTyping && !messages[messages.length - 1].recommendedCaregivers && (
            <div className="flex flex-wrap gap-2 mt-2">
              {featuredCapabilities('client').map(cap => (
                <button
                  key={cap.id}
                  onClick={() => sendMessage(capabilityExample(cap, UI_LOCALE))}
                  title={capabilityExample(cap, UI_LOCALE)}
                  className="bg-primary-50 hover:bg-primary-100 text-primary-700 text-xs px-3 py-1.5 rounded-full transition-colors border border-primary-200"
                >
                  {capabilityLabel(cap, UI_LOCALE)}
                </button>
              ))}
            </div>
          )}

          {isTyping && (
            <div className="flex items-center space-x-2 p-4 bg-white rounded-2xl rounded-bl-none max-w-[100px] border border-slate-100">
              <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-100"></div>
              <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-200"></div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 bg-white border-t border-slate-100 z-20">
          <div className="flex items-center gap-2">
            {/* U5: in-app /help — sends the capability menu as a Cara bubble */}
            <button
              onClick={() => showHelpMenu(false)}
              title={isSpanish(UI_LOCALE) ? '¿Qué puedo hacer? (/help)' : 'What can I do? (/help)'}
              aria-label="Show what Cara can do"
              className="p-3 text-slate-400 hover:text-primary-600 rounded-xl transition-colors"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
            <div className="relative flex-grow">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isSpanish(UI_LOCALE) ? "Describe lo que necesitas (ej. 'Conductor con certificación CPR')..." : "Describe your needs (e.g. 'Driver with CPR training')..."}
                className="w-full pl-4 pr-10 py-3 bg-slate-100 border-transparent focus:bg-white focus:border-primary-500 focus:border-transparent focus:ring-2 focus:ring-primary-100 rounded-xl transition-all outline-none text-sm"
              />
              <button className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1.5 text-slate-400 hover:text-primary-600 rounded-full transition-colors">
                <Mic className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              className="bg-primary-600 hover:bg-primary-700 text-white p-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg shadow-primary-200"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
