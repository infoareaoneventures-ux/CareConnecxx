import React from 'react';
import { Users, Heart, ChevronRight, Activity } from 'lucide-react';
import { ViewType } from '../types';

interface LoginPageProps {
    onNavigate: (view: ViewType) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onNavigate }) => {
    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col">
            {/* Header */}
            <header className="bg-white border-b border-slate-100">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center h-16">
                        <button 
                            onClick={() => onNavigate('landing')}
                            className="flex items-center space-x-2 cursor-pointer"
                        >
                            <div className="bg-primary-600 p-2 rounded-xl shadow-lg shadow-primary-200/50">
                                <Activity className="text-white w-5 h-5" />
                            </div>
                            <span className="text-xl font-bold text-slate-900 tracking-tight">CareConnex</span>
                        </button>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-grow flex items-center justify-center p-4">
                <div className="w-full max-w-md">
                    <div className="bg-white rounded-3xl shadow-xl p-8 sm:p-10">
                        <h1 className="text-3xl font-bold text-center text-slate-900 mb-2">Welcome Back</h1>
                        <p className="text-slate-500 text-center mb-8">Please choose your account type to sign in</p>

                        <div className="space-y-4">
                            <button
                                onClick={() => onNavigate('client-login')}
                                className="w-full p-5 rounded-xl border-2 border-slate-100 hover:border-primary-500 hover:bg-primary-50 transition-all flex items-center group"
                            >
                                <div className="bg-primary-100 p-3 rounded-full text-primary-600 group-hover:bg-primary-600 group-hover:text-white transition-colors">
                                    <Users className="w-6 h-6" />
                                </div>
                                <div className="ml-4 text-left">
                                    <h3 className="font-bold text-slate-900 group-hover:text-primary-700">Family / Client</h3>
                                    <p className="text-sm text-slate-500">Find and manage care for your loved ones</p>
                                </div>
                                <ChevronRight className="ml-auto text-slate-300 group-hover:text-primary-500" />
                            </button>

                            <button
                                onClick={() => onNavigate('caregiver-login')}
                                className="w-full p-5 rounded-xl border-2 border-slate-100 hover:border-accent-500 hover:bg-accent-50 transition-all flex items-center group"
                            >
                                <div className="bg-accent-100 p-3 rounded-full text-accent-600 group-hover:bg-accent-500 group-hover:text-white transition-colors">
                                    <Heart className="w-6 h-6" />
                                </div>
                                <div className="ml-4 text-left">
                                    <h3 className="font-bold text-slate-900 group-hover:text-accent-700">Caregiver</h3>
                                    <p className="text-sm text-slate-500">Manage jobs, schedule, and payouts</p>
                                </div>
                                <ChevronRight className="ml-auto text-slate-300 group-hover:text-accent-500" />
                            </button>
                        </div>

                        <div className="mt-8 text-center">
                            <p className="text-slate-500 text-sm">
                                Don't have an account?{' '}
                                <button 
                                    onClick={() => onNavigate('client-signup')}
                                    className="text-primary-600 font-medium hover:underline"
                                >
                                    Get started
                                </button>
                            </p>
                        </div>
                    </div>
                </div>
            </main>

            {/* Footer */}
            <footer className="bg-white border-t border-slate-100 py-6">
                <div className="max-w-7xl mx-auto px-4 text-center">
                    <p className="text-slate-400 text-sm">
                        © {new Date().getFullYear()} CareConnex. All rights reserved.
                    </p>
                </div>
            </footer>
        </div>
    );
};
