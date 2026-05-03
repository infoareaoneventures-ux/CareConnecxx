import React, { useState, useEffect } from 'react';
import { aiService } from '../../services/ai';

interface RateSuggestionProps {
    location: string;
    skills: string[];
    certifications?: string[];
    currentRate: number;
    onRateChange: (rate: number) => void;
}

export const RateSuggestion: React.FC<RateSuggestionProps> = ({
    location,
    skills,
    certifications = [],
    currentRate,
    onRateChange
}) => {
    const [suggestedRate, setSuggestedRate] = useState<number | null>(null);
    const [explanation, setExplanation] = useState<string>('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (skills.length > 0 && location) {
            fetchRateSuggestion();
        }
    }, [skills, location, certifications]);

    const fetchRateSuggestion = async () => {
        setLoading(true);
        try {
            const result = await aiService.suggestRate({
                location,
                skills,
                certifications
            });

            setSuggestedRate(result.suggestedRate);
            setExplanation(result.explanation);
        } catch (error) {
            console.error('Error fetching rate suggestion:', error);
            // Fallback
            const baseRate = 25;
            const skillBonus = skills.length * 2;
            const certBonus = certifications.length * 3;
            const suggested = baseRate + skillBonus + certBonus;

            setSuggestedRate(suggested);
            setExplanation(`Based on your ${skills.length} skills and ${certifications.length} certifications in ${location}, we suggest $${suggested}/hr as a competitive rate.`);
        } finally {
            setLoading(false);
        }
    };

    const getRateComparison = () => {
        if (!suggestedRate) return null;

        const diff = currentRate - suggestedRate;
        const percentage = Math.abs((diff / suggestedRate) * 100);

        if (Math.abs(diff) < 2) {
            return { label: 'Perfect!', color: 'text-green-600', icon: '✓' };
        } else if (diff > 0) {
            return { label: `${percentage.toFixed(0)}% above market`, color: 'text-primary-600', icon: '↑' };
        } else {
            return { label: `${percentage.toFixed(0)}% below market`, color: 'text-blue-600', icon: '↓' };
        }
    };

    const comparison = getRateComparison();

    return (
        <div className="space-y-4">
            <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-2">
                    Set Your Hourly Rate
                </h3>
                <p className="text-sm text-slate-600 mb-4">
                    We'll suggest a competitive rate based on your skills and location.
                </p>
            </div>

            {loading ? (
                <div className="p-6 bg-slate-50 rounded-lg text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
                    <p className="text-sm text-slate-600 mt-2">Analyzing market rates...</p>
                </div>
            ) : suggestedRate ? (
                <div className="p-6 bg-gradient-to-br from-primary-50 to-blue-50 rounded-lg border-2 border-primary-200">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <p className="text-sm text-slate-600">AI-Suggested Rate</p>
                            <p className="text-3xl font-bold text-primary-600">${suggestedRate}/hr</p>
                        </div>
                        <div className="text-4xl">🤖</div>
                    </div>
                    <p className="text-sm text-slate-700">{explanation}</p>
                </div>
            ) : null}

            <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">
                    Your Hourly Rate
                </label>
                <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-lg">$</span>
                    <input
                        type="number"
                        value={currentRate}
                        onChange={(e) => onRateChange(Number(e.target.value))}
                        min="10"
                        max="200"
                        step="1"
                        className="w-full pl-10 pr-4 py-3 text-lg border-2 border-slate-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500">/hr</span>
                </div>

                {comparison && (
                    <div className={`flex items-center gap-2 text-sm ${comparison.color}`}>
                        <span>{comparison.icon}</span>
                        <span className="font-medium">{comparison.label}</span>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
                <div className="p-3 bg-slate-50 rounded-lg">
                    <p className="text-xs text-slate-600">Low</p>
                    <p className="text-lg font-semibold text-slate-800">${suggestedRate ? suggestedRate - 5 : 20}</p>
                </div>
                <div className="p-3 bg-primary-50 rounded-lg border-2 border-primary-300">
                    <p className="text-xs text-primary-600">Market</p>
                    <p className="text-lg font-semibold text-primary-800">${suggestedRate || 25}</p>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg">
                    <p className="text-xs text-slate-600">High</p>
                    <p className="text-lg font-semibold text-slate-800">${suggestedRate ? suggestedRate + 5 : 30}</p>
                </div>
            </div>

            <div className="p-4 bg-blue-50 rounded-lg">
                <p className="text-sm text-blue-800">
                    💡 <strong>Tip:</strong> Setting a competitive rate increases your chances of getting booked. You can always adjust it later!
                </p>
            </div>
        </div>
    );
};
