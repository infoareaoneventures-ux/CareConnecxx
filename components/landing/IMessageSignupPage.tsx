import React from 'react';
import { useNavigate } from 'react-router-dom';

const CONVERSATION: Array<{ from: 'cara' | 'user'; text: string; delay: number }> = [
  { from: 'cara', text: "Maria just finished today's visit 💙", delay: 0 },
  { from: 'cara', text: "Your mom ate well and seemed happy. She mentioned her left knee was a little stiff — I'll keep an eye on it.", delay: 150 },
  { from: 'user', text: "Should I be worried?", delay: 300 },
  { from: 'cara', text: "One stiff day isn't cause for concern. I'll flag it if it comes up again. Next visit is Wednesday at 9am.", delay: 450 },
];

export const IMessageSignupPage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col">
      {/* Nav */}
      <nav className="px-6 py-5 flex items-center justify-between max-w-6xl mx-auto w-full">
        <span className="text-lg font-semibold tracking-tight text-white">Evia</span>
        <a href="/login" className="text-sm text-white/50 hover:text-white/80 transition-colors">Log in</a>
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col lg:flex-row items-center gap-16 lg:gap-24 px-6 py-12 max-w-6xl mx-auto w-full">

        {/* Left — copy + form */}
        <div className="flex-1 space-y-8 max-w-lg">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/60 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
            iMessage · RCS · SMS
          </div>

          <div className="space-y-4">
            <h1 className="text-5xl md:text-6xl font-bold leading-[1.05] tracking-tight">
              Meet Evia, your family's{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-blue-300">
                care contact.
              </span>
            </h1>
            <p className="text-xl text-white/60 leading-relaxed">
              Care for your loved one, handled through texts. No app. No login. Just text.
            </p>
          </div>

          {/* Feature list */}
          <ul className="space-y-3">
            {[
              'Finds and interviews caregivers for you',
              'Books and confirms every visit',
              'Texts you after each care session',
              'Handles cancellations and replacements',
            ].map((item) => (
              <li key={item} className="flex items-center gap-3 text-white/70 text-sm">
                <span className="w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                  <svg className="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                {item}
              </li>
            ))}
          </ul>

          {/* CTAs */}
          <div className="space-y-3">
            <button
              onClick={() => navigate('/start?role=client')}
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold rounded-xl text-base transition-all duration-150 flex items-center justify-between px-5"
            >
              <span>Find a caregiver</span>
              <span className="text-blue-200">→</span>
            </button>
            <button
              onClick={() => navigate('/start?role=caregiver')}
              className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 text-white font-semibold rounded-xl text-base transition-all duration-150 flex items-center justify-between px-5"
            >
              <span>Become a caregiver</span>
              <span className="text-white/40">→</span>
            </button>
            <p className="text-white/25 text-xs leading-relaxed text-center">
              By continuing, you agree to receive care updates from Evia via text.
              Reply STOP anytime. Msg &amp; data rates may apply.
            </p>
          </div>
        </div>

        {/* Right — iPhone mockup */}
        <div className="flex-shrink-0 flex justify-center">
          <div className="relative">
            {/* Phone frame */}
            <div
              className="relative bg-[#1c1c1e] rounded-[3rem] shadow-2xl overflow-hidden"
              style={{ width: 300, height: 600, border: '3px solid #2a2a2c', boxShadow: '0 0 0 1px #111, 0 40px 80px rgba(0,0,0,0.8)' }}
            >
              {/* Notch */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-7 bg-[#1c1c1e] rounded-b-2xl z-10 flex items-center justify-center">
                <div className="w-2 h-2 rounded-full bg-[#2a2a2c]"></div>
              </div>

              {/* Status bar */}
              <div className="flex items-center justify-between px-6 pt-10 pb-1">
                <span className="text-white text-xs font-semibold">9:41</span>
                <div className="flex items-center gap-1.5">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M1.5 8.5C5.5 4.5 18.5 4.5 22.5 8.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M5 12c3-3 11-3 14 0" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M8.5 15.5c2-2 5-2 7 0" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>
                  <svg className="w-4 h-2.5 text-white" fill="currentColor" viewBox="0 0 24 12"><rect x="1" y="1" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/><rect x="3" y="3" width="12" height="6" rx="1" fill="currentColor"/><path d="M21 4.5v3a1.5 1.5 0 000-3z" fill="currentColor"/></svg>
                </div>
              </div>

              {/* iMessage header */}
              <div className="flex flex-col items-center py-3 border-b border-white/5">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center mb-1">
                  <span className="text-white font-bold text-sm">C</span>
                </div>
                <p className="text-white text-sm font-semibold">Evia 💙</p>
                <p className="text-white/40 text-xs">CareConnecxx</p>
              </div>

              {/* Messages */}
              <div className="flex flex-col gap-2 px-3 pt-4 pb-3 overflow-hidden">
                {CONVERSATION.map((msg, i) => (
                  <div key={i} className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] px-3.5 py-2.5 text-xs leading-relaxed ${
                        msg.from === 'cara'
                          ? 'bg-[#3a3a3c] text-white rounded-2xl rounded-tl-sm'
                          : 'bg-[#0e7afb] text-white rounded-2xl rounded-tr-sm'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                ))}

                {/* Typing indicator */}
                <div className="flex justify-start">
                  <div className="bg-[#3a3a3c] rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                    <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                    <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                  </div>
                </div>
              </div>

              {/* Input bar */}
              <div className="absolute bottom-0 left-0 right-0 px-3 pb-4 pt-2 bg-[#1c1c1e] border-t border-white/5 flex items-center gap-2">
                <div className="flex-1 bg-[#2c2c2e] rounded-full px-4 py-2 text-white/20 text-xs">
                  Message
                </div>
                <div className="w-8 h-8 rounded-full bg-[#0e7afb] flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M2 21L23 12 2 3v7l15 2-15 2z"/>
                  </svg>
                </div>
              </div>
            </div>

            {/* Glow effect */}
            <div className="absolute inset-0 rounded-[3rem] bg-blue-500/5 blur-2xl -z-10 scale-110"></div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-6 text-center text-white/20 text-xs max-w-6xl mx-auto w-full border-t border-white/5">
        © 2026 CareConnecxx · Santa Clara County · Privacy · Terms
      </footer>
    </div>
  );
};

export default IMessageSignupPage;
