import React, { useState } from 'react';
import { CAREGIVER_SKILLS, CaregiverSkill } from '../../types';

interface SkillsSelectorProps {
    selectedSkills: string[];
    onSkillsChange: (skills: string[]) => void;
}

export const SkillsSelector: React.FC<SkillsSelectorProps> = ({
    selectedSkills,
    onSkillsChange
}) => {
    const toggleSkill = (skill: string) => {
        if (selectedSkills.includes(skill)) {
            onSkillsChange(selectedSkills.filter(s => s !== skill));
        } else {
            onSkillsChange([...selectedSkills, skill]);
        }
    };

    return (
        <div className="space-y-4">
            <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-2">
                    Select Your Skills & Services
                </h3>
                <p className="text-sm text-slate-600 mb-4">
                    Choose all the services you're comfortable providing. This helps us match you with the right clients.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {CAREGIVER_SKILLS.map((skill) => {
                    const isSelected = selectedSkills.includes(skill);

                    return (
                        <button
                            key={skill}
                            type="button"
                            onClick={() => toggleSkill(skill)}
                            className={`
                p-4 rounded-lg border-2 text-left transition-all
                ${isSelected
                                    ? 'border-primary-500 bg-primary-50 text-primary-900'
                                    : 'border-slate-200 bg-white text-slate-700 hover:border-primary-300'
                                }
              `}
                        >
                            <div className="flex items-center justify-between">
                                <span className="font-medium">{skill}</span>
                                {isSelected && (
                                    <svg className="w-5 h-5 text-primary-600" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                    </svg>
                                )}
                            </div>
                        </button>
                    );
                })}
            </div>

            {selectedSkills.length > 0 && (
                <div className="mt-4 p-4 bg-primary-50 rounded-lg">
                    <p className="text-sm text-primary-800">
                        <strong>{selectedSkills.length}</strong> skill{selectedSkills.length !== 1 ? 's' : ''} selected
                    </p>
                </div>
            )}
        </div>
    );
};
