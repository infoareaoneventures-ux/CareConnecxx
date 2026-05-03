import React, { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { aiService } from '../../services/ai';
import { AddToastFunction } from '../../types';

interface ShiftAssistantProps {
    onShowToast: AddToastFunction;
}

export const ShiftAssistant: React.FC<ShiftAssistantProps> = ({ onShowToast }) => {
    const [shiftNote, setShiftNote] = useState('');
    const [isGeneratingNote, setIsGeneratingNote] = useState(false);

    const generateShiftNote = async () => {
        if (!shiftNote.trim()) {
            return;
        }

        setIsGeneratingNote(true);
        try {
            const polished = await aiService.generateShiftNote(shiftNote);
            setShiftNote(polished);
            onShowToast("Shift note polished by Gemini AI", 'success');
        } catch (e) {
            onShowToast("Failed to generate note", 'error');
        } finally {
            setIsGeneratingNote(false);
        }
    };

    const handleSaveNote = async () => {
        if (!shiftNote) return;
        onShowToast("Shift note saved to patient record.", 'success');
        setShiftNote('');
    };

    return (
        <div className="mb-8 border border-primary-100 bg-primary-50 rounded-2xl p-6">
            <div className="flex items-center mb-4">
                <div className="bg-primary-600 p-2 rounded-lg mr-3">
                    <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                    <h3 className="text-lg font-bold text-primary-900">Shift Assistant (Gemini AI)</h3>
                    <p className="text-sm text-primary-700">Type rough notes, get professional logs.</p>
                </div>
            </div>

            <div className="relative">
                <textarea
                    className="w-full p-4 rounded-xl border border-primary-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent min-h-[100px] text-slate-700 resize-none bg-white"
                    placeholder="e.g. 'ate 50% lunch, bp 120/80, good mood'..."
                    value={shiftNote}
                    onChange={(e) => setShiftNote(e.target.value)}
                />
                {!shiftNote ? (
                    <button
                        className="absolute top-3 right-3 text-slate-300 pointer-events-none"
                    >
                        <Sparkles className="w-4 h-4" />
                    </button>
                ) : (
                    <div className="flex justify-end mt-2 gap-2">
                        <button
                            onClick={generateShiftNote}
                            disabled={isGeneratingNote}
                            className="bg-primary-100 text-primary-800 px-3 py-1 rounded-lg text-sm font-medium hover:bg-primary-200 transition-colors flex items-center border border-primary-200"
                        >
                            {isGeneratingNote ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                            Refine with AI
                        </button>
                        <Button size="sm" onClick={handleSaveNote}>Save Entry</Button>
                    </div>
                )}
            </div>
        </div>
    );
};
