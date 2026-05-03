import React from 'react';

const PressLogo: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
    <div className={`text-[#2d3748] opacity-80 hover:opacity-100 transition-opacity flex items-center justify-center grayscale ${className}`}>
        {children}
    </div>
);

export const StatsBar: React.FC = () => {
    return (
        <div className="bg-[#fdeef2] relative py-12 md:py-16 mt-8 mb-8">
            {/* Top Wave */}
            <div className="absolute top-0 left-0 w-full overflow-hidden leading-none" style={{ transform: 'translateY(-1px)' }}>
                <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="relative block w-full h-[20px] md:h-[40px]">
                    <path d="M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V0H0V27.35A600.21,600.21,0,0,0,321.39,56.44Z" className="fill-white"></path>
                </svg>
            </div>
            
            {/* Bottom Wave */}
            <div className="absolute bottom-0 left-0 w-full overflow-hidden leading-none" style={{ transform: 'translateY(1px) rotate(180deg)' }}>
                <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="relative block w-full h-[20px] md:h-[40px]">
                    <path d="M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V0H0V27.35A600.21,600.21,0,0,0,321.39,56.44Z" className="fill-white"></path>
                </svg>
            </div>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-12 relative z-20">
                <div className="flex flex-col xl:flex-row items-center justify-between gap-10 xl:gap-16">
                    <div className="flex-shrink-0">
                        <p className="text-xs md:text-sm font-bold tracking-widest text-[#4a5568] uppercase">Trusted By</p>
                    </div>
                    
                    <div className="flex flex-wrap justify-center xl:justify-between items-center w-full gap-8 md:gap-12 lg:gap-16">
                        <PressLogo>
                            <div className="font-sans font-black text-lg md:text-xl leading-none text-center tracking-tighter">GOOD<br/>MORNING<br/>AMERICA</div>
                        </PressLogo>
                        <PressLogo>
                            <div className="flex items-center gap-1.5 font-sans font-black text-xl md:text-2xl tracking-tighter">
                                <svg className="w-6 h-6 md:w-8 md:h-8" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm0-14a6 6 0 1 0 6 6 6 6 0 0 0-6-6z"/>
                                    <circle cx="12" cy="12" r="3"/>
                                </svg>
                                TODAY
                            </div>
                        </PressLogo>
                        <PressLogo>
                            <div className="font-serif font-bold text-xl md:text-2xl tracking-tight" style={{ fontFamily: '"Georgia", serif' }}>The New York Times</div>
                        </PressLogo>
                        <PressLogo>
                            <div className="font-serif font-bold text-lg md:text-xl tracking-tighter" style={{ fontFamily: '"Georgia", serif' }}>The Washington Post</div>
                        </PressLogo>
                        <PressLogo>
                            <div className="font-serif font-black text-2xl md:text-3xl tracking-tighter" style={{ fontFamily: '"Times New Roman", Times, serif' }}>Forbes</div>
                        </PressLogo>
                    </div>
                </div>
            </div>
        </div>
    );
};
