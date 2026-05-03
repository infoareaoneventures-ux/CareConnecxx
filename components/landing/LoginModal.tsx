import React from 'react';
import { X, Users, Heart, ChevronRight } from 'lucide-react';
import { ViewType } from '../../types';

interface LoginModalProps {
    onNavigate: (view: ViewType) => void;
    onClose: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onNavigate, onClose }) => {
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
            <div className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl p-6 sm:p-8 max-h-[90vh] overflow-y-auto animate-slide-in">
                <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"><X size={24} /></button>
                <h2 className="text-2xl font-bold text-center text-slate-900 mb-2">Welcome Back</h2>
                <p className="text-slate-500 text-center mb-8">Please choose your account type</p>

                <div className="space-y-4">
                    <button
                        onClick={() => onNavigate('client-login')}
                        className="w-full p-4 rounded-xl border-2 border-slate-100 hover:border-primary-500 hover:bg-primary-50 transition-all flex items-center group"
                    >
                        <div className="bg-primary-100 p-3 rounded-full text-primary-600 group-hover:bg-primary-600 group-hover:text-white transition-colors">
                            <Users className="w-6 h-6" />
                        </div>
                        <div className="ml-4 text-left">
                            <h3 className="font-bold text-slate-900 group-hover:text-primary-700">Family / Client</h3>
                            <p className="text-xs text-slate-500">Find and manage care</p>
                        </div>
                        <ChevronRight className="ml-auto text-slate-300 group-hover:text-primary-500" />
                    </button>

                    <button
                        onClick={() => onNavigate('caregiver-login')}
                        className="w-full p-4 rounded-xl border-2 border-slate-100 hover:border-accent-500 hover:bg-accent-50 transition-all flex items-center group"
                    >
                        <div className="bg-accent-100 p-3 rounded-full text-accent-600 group-hover:bg-accent-500 group-hover:text-white transition-colors">
                            <Heart className="w-6 h-6" />
                        </div>
                        <div className="ml-4 text-left">
                            <h3 className="font-bold text-slate-900 group-hover:text-accent-700">Caregiver</h3>
                            <p className="text-xs text-slate-500">Manage jobs and payouts</p>
                        </div>
                        <ChevronRight className="ml-auto text-slate-300 group-hover:text-accent-500" />
                    </button>
                </div>
            </div>
        </div>
    );
};
