import React, { useEffect, useState } from 'react';
import { Star, MapPin, ArrowRight, CheckCircle, Clock, Heart, Shield, MessageSquare } from 'lucide-react';
import { ViewType } from '../../types';
import { db } from '../../lib/firebase';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';

interface FeaturedCaregiversSectionProps {
    onNavigate: (view: ViewType) => void;
}

interface FeaturedCaregiver {
    id: string;
    name: string;
    location: string;
    rating: number;
    reviewCount: number;
    yearsExp: number;
    specialties: string[];
    imageUrl?: string;
    photo?: string;
    travelRadius?: number;
    verified?: boolean;
    backgroundCheckStatus?: string;
}

function CaregiverInitialsAvatar({ name, className }: { name: string; className?: string }) {
    const initials = name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
    return (
        <div className={`${className} flex items-center justify-center bg-gradient-to-br from-primary-100 to-primary-200`}>
            <span className="text-3xl font-bold text-primary-600 select-none">{initials}</span>
        </div>
    );
}

function CaregiverPhoto({ cg }: { cg: FeaturedCaregiver }) {
    const [errored, setErrored] = useState(false);
    const src = cg.imageUrl || cg.photo;
    if (src && !errored) {
        return <img src={src} alt={cg.name} className="w-full h-full object-cover" onError={() => setErrored(true)} />;
    }
    return <CaregiverInitialsAvatar name={cg.name} className="w-full h-full" />;
}

export const FeaturedCaregiversSection: React.FC<FeaturedCaregiversSectionProps> = ({ onNavigate }) => {
    const [caregivers, setCaregivers] = useState<FeaturedCaregiver[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!db) { setLoading(false); return; }
        db.collection('publicCaregiverProfiles')
            .where('verified', '==', true)
            .orderBy('rating', 'desc')
            .limit(3)
            .get()
            .then(snap => {
                const list: FeaturedCaregiver[] = snap.docs.map(doc => {
                    const d = doc.data() as any;
                    const firstName = d.firstName || d.name?.split(' ')[0] || '';
                    const lastName = d.lastName || d.name?.split(' ').slice(1).join(' ') || '';
                    const fullName = d.name || `${firstName} ${lastName}`.trim();
                    return {
                        id: doc.id,
                        name: fullName,
                        location: d.city || d.location?.city || 'Nearby',
                        // No default rating: a caregiver nobody has reviewed shows "No reviews yet" (founder, 2026-09-30).
                        rating: (d.reviewCount || 0) > 0 ? (d.rating || 0) : 0,
                        reviewCount: d.reviewCount || 0,
                        yearsExp: d.experience || d.yearsExperience || 0,
                        specialties: (d.skills || d.specializations || d.specialties || []).slice(0, 3),
                        imageUrl: d.imageUrl || d.profilePhoto,
                        photo: d.photo,
                        travelRadius: d.travelRadius || d.serviceRadius || 10,
                        verified: true,
                        backgroundCheckStatus: d.backgroundCheckStatus || 'clear',
                    };
                });
                setCaregivers(list);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return (
            <section className="py-24 bg-white">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="grid md:grid-cols-3 gap-8">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="bg-white rounded-[1.5rem] border border-slate-100 h-64 animate-pulse" />
                        ))}
                    </div>
                </div>
            </section>
        );
    }

    if (caregivers.length === 0) return null;

    return (
        <section className="py-24 bg-white">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

                {/* Header */}
                <div className="text-center max-w-2xl mx-auto mb-16">
                    <h2 className="font-display text-4xl md:text-[42px] font-semibold text-ink-900 mb-4 tracking-[-0.02em]">
                        Meet our caregivers
                    </h2>
                    <p className="text-lg text-ink-600">
                        Real people, thoroughly vetted, ready to help your loved one.
                    </p>
                </div>

                {/* Cards */}
                <div className="grid md:grid-cols-3 gap-8">
                    {caregivers.map((cg, i) => (
                        <div
                            key={cg.id}
                            className="bg-white rounded-[1.5rem] border border-slate-100 hover:border-slate-300 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col relative group cursor-pointer"
                            onClick={() => onNavigate('client-signup')}
                        >
                            <div className="p-5 flex-1 flex flex-col">
                                {/* Top row: photo + name + badges */}
                                <div className="flex items-start gap-4 mb-5">
                                    <div className="w-20 h-20 rounded-full bg-slate-200 overflow-hidden flex items-center justify-center flex-shrink-0 shadow-inner group-hover:ring-4 ring-primary-50 transition-all">
                                        <CaregiverPhoto cg={cg} />
                                    </div>

                                    <div className="flex-1 min-w-0 pt-1">
                                        <h3 className="text-[22px] font-bold text-slate-900 group-hover:text-primary-600 transition-colors truncate mb-1 leading-tight">{cg.name}</h3>

                                        <div className="flex items-center gap-0.5 mb-2.5">
                                            {[...Array(5)].map((_, idx) => (
                                                <Star key={idx} className={`w-[18px] h-[18px] ${idx < Math.floor(cg.rating) ? 'text-teal-500 fill-current' : 'text-slate-200'}`} />
                                            ))}
                                            {cg.reviewCount > 0
                                                ? <span className="text-sm font-medium text-slate-500 ml-1.5">({cg.reviewCount})</span>
                                                : <span className="text-sm text-slate-400 ml-1.5">No reviews yet</span>}
                                        </div>

                                        <CaregiverVerificationBadges verified={cg.verified} backgroundCheckStatus={cg.backgroundCheckStatus} />
                                    </div>
                                </div>

                                {/* Details */}
                                <div className="space-y-3.5 mb-5 mt-1">
                                    {cg.yearsExp > 0 && (
                                        <div className="flex items-center gap-3.5 text-slate-700">
                                            <Heart className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
                                            <span className="text-[17px]">{cg.yearsExp} years experience</span>
                                        </div>
                                    )}
                                    {cg.location && (
                                        <div className="flex items-center gap-3.5 text-slate-700">
                                            <MapPin className="w-6 h-6 text-slate-600 flex-shrink-0 stroke-[1.5]" />
                                            <span className="text-[17px]">{cg.location}</span>
                                        </div>
                                    )}
                                </div>

                                {/* Skills */}
                                {cg.specialties.length > 0 && (
                                    <div className="flex flex-wrap gap-2 mb-6 mt-1">
                                        {cg.specialties.map((skill, j) => (
                                            <span key={j} className="px-3.5 py-1.5 bg-slate-100 border border-slate-200 text-slate-800 text-[13px] font-medium rounded-[1rem]">
                                                {skill}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                <div className="border-t border-slate-200 pt-4 pb-2 flex items-center justify-between mt-auto">
                                    <div className="flex-1 text-center border-r border-slate-200 pr-2 pb-1">
                                        <div className="flex items-center justify-center gap-1.5 text-slate-500 mb-1">
                                            <MessageSquare className="w-3.5 h-3.5" />
                                            <span className="text-[10px] font-bold uppercase tracking-[0.08em]">Responds in</span>
                                        </div>
                                        <p className="text-[16px] text-slate-900 tracking-tight">{i === 1 ? '1 hour' : '30 minutes'}</p>
                                    </div>
                                    <div className="flex-1 text-center pl-2 pb-1">
                                        <div className="flex items-center justify-center gap-1.5 text-slate-500 mb-1">
                                            <Clock className="w-3.5 h-3.5" />
                                            <span className="text-[10px] font-bold uppercase tracking-[0.08em]">Verified</span>
                                        </div>
                                        <p className="text-[16px] text-slate-900 tracking-tight">Background checked</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Bottom CTA */}
                <div className="text-center mt-12">
                    <button
                        onClick={() => onNavigate('client-signup')}
                        className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 font-bold transition-colors text-base"
                    >
                        Browse all caregivers
                        <ArrowRight className="w-5 h-5" />
                    </button>
                </div>
            </div>
        </section>
    );
};
