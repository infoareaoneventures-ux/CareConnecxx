
import React, { useState, useEffect, useRef } from 'react';
import { User, Settings, CreditCard, LogOut, ChevronLeft, Shield, Home, Loader2, X, Plus, Lock, Trash2, Users } from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Badge } from './ui/Badge';
import { AvatarUpload } from './ui/AvatarUpload';
import { ViewType, AddToastFunction, Senior } from '../types';
import { authService, dbService } from '../services/api';
import { FamilyManager } from './FamilyManager';
import { ClientNavigation } from './client/ClientNavigation';

interface ClientProfileProps {
  onNavigate: (view: ViewType) => void;
  onShowToast: AddToastFunction;
}

export const ClientProfile: React.FC<ClientProfileProps> = ({ onNavigate, onShowToast }) => {
  const [activeTab, setActiveTab] = useState<'profile' | 'family' | 'security'>('profile');
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Partial<Senior> & { email?: string, phone?: string }>({
    name: '',
    email: '',
    location: '',
    imageUrl: '',
    needs: []
  });
  
  const [newNeed, setNewNeed] = useState('');
  const [isAddingNeed, setIsAddingNeed] = useState(false);
  
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const currentUser = authService.getCurrentUser();

  // U3: dirty-guard so the live senior-profile listener (below) never clobbers
  // unsaved edits. Any field edit marks dirty; a successful save clears it.
  const dirtyRef = useRef(false);
  const editProfile = (patch: Partial<typeof profile>) => {
    dirtyRef.current = true;
    setProfile(prev => ({ ...prev, ...patch }));
  };

  useEffect(() => {
    const fetchProfile = async () => {
      if (currentUser) {
        const data = await dbService.getSeniorProfile(currentUser.uid);
        if (data) {
          setProfile({
            ...data,
            email: currentUser.email || '',
            phone: (data as any).phone || '(555) 123-4567'
          });
        }
      } else {
        onNavigate('client-login');
        return;
      }
      setLoading(false);
    };

    fetchProfile();
  }, [currentUser]);

  // U3: Live senior-profile listener. Cara's intake writes (care needs,
  // location, etc.) reflect here without a reload. Applies snapshots only when
  // the form is not dirty, so unsaved edits are never overwritten (KTD-4).
  useEffect(() => {
    if (!currentUser) return;
    const unsubscribe = dbService.subscribeToSeniorProfile(currentUser.uid, (data) => {
      if (!data || dirtyRef.current) return; // hold while editing / on unavailable
      setProfile(prev => ({
        ...prev,
        ...(data as any),
        email: currentUser.email || prev.email || '',
        phone: (data as any).phone || prev.phone,
      }));
    });
    return () => unsubscribe();
  }, [currentUser?.uid]);

  const handleLogout = async () => {
    await authService.logout();
    onShowToast("Logged out successfully", 'info');
    onNavigate('landing');
  };

  const handleSave = async () => {
    if (currentUser) {
       try {
         await dbService.updateUser('senior_profiles', currentUser.uid, {
           name: profile.name,
           location: profile.location,
           needs: profile.needs,
           phone: profile.phone,
           imageUrl: profile.imageUrl
         });
         dirtyRef.current = false; // saved — allow live snapshots to resume
         onShowToast("Profile changes saved to database", 'success');
       } catch (e) {
         onShowToast("Failed to save changes", 'error');
       }
    } else {
       onShowToast("Changes simulated (Demo Mode)", 'success');
    }
  };

  const handlePasswordChange = async () => {
    if (newPassword !== confirmPassword) {
      onShowToast("Passwords do not match", 'error');
      return;
    }
    try {
      await authService.updateUserPassword(newPassword);
      onShowToast("Password updated successfully", 'success');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      onShowToast("Failed to update password", 'error');
    }
  };

  const handleDeleteAccount = async () => {
    if (confirm("Are you sure you want to delete your account? This cannot be undone.")) {
      try {
        await authService.deleteUserAccount();
        onShowToast("Account deleted", 'info');
        onNavigate('landing');
      } catch (e) {
        onShowToast("Failed to delete account", 'error');
      }
    }
  };

  const handleImageUpdate = async (url: string) => {
    setProfile(prev => ({ ...prev, imageUrl: url }));
    // Auto-save photo immediately so it persists without requiring Save Changes
    if (currentUser) {
      try {
        await dbService.updateUser('senior_profiles', currentUser.uid, { imageUrl: url });
        onShowToast('Profile photo updated', 'success');
      } catch {
        onShowToast('Photo saved locally but failed to sync — try again', 'error');
      }
    }
  };

  const addNeed = () => {
    if (newNeed.trim()) {
      dirtyRef.current = true;
      setProfile(prev => ({
        ...prev,
        needs: [...(prev.needs || []), newNeed.trim()]
      }));
      setNewNeed('');
      setIsAddingNeed(false);
    }
  };

  const removeNeed = (index: number) => {
    dirtyRef.current = true;
    setProfile(prev => ({
      ...prev,
      needs: (prev.needs || []).filter((_, i) => i !== index)
    }));
  };

  if (loading) return <div className="flex justify-center p-10"><Loader2 className="animate-spin text-primary-600" /></div>;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      <div className="max-w-3xl mx-auto p-4 md:p-6 animate-slide-in">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center">
          <button 
            onClick={() => onNavigate('client')}
            className="p-2 -ml-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
            aria-label="Back to Dashboard"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <h1 className="text-2xl font-bold text-slate-900 ml-2">My Profile</h1>
        </div>
        <button 
            onClick={() => onNavigate('client')}
            className="text-sm font-semibold text-primary-600 hover:text-primary-700 hover:underline"
        >
            Go to Dashboard
        </button>
      </div>

      <div className="flex space-x-2 bg-slate-100 p-1 rounded-xl mb-6">
        <button 
          onClick={() => setActiveTab('profile')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'profile' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
        >
          Profile Details
        </button>
        <button 
          onClick={() => setActiveTab('family')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'family' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
        >
          Family Access
        </button>
        <button 
          onClick={() => setActiveTab('security')}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === 'security' ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
        >
          Security
        </button>
      </div>

      {activeTab === 'profile' && (
        <>
          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden mb-6">
            <div className="bg-primary-600 h-24 relative">
              <div className="absolute -bottom-10 left-6">
                <AvatarUpload
                    currentUrl={profile.imageUrl}
                    onImageSelected={handleImageUpdate}
                    userId={currentUser?.uid}
                    storageFolder="clients"
                />
              </div>
            </div>
            <div className="pt-14 px-6 pb-6">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">{profile.name}</h2>
                  <p className="text-slate-500 text-sm">Member since 2023</p>
                </div>
                <Badge variant="success">Premium Plan</Badge>
              </div>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                      label="Full Name"
                      value={profile.name}
                      onChange={(e) => editProfile({ name: e.target.value })}
                  />
                  <Input
                      label="Phone"
                      value={profile.phone}
                      onChange={(e) => editProfile({ phone: e.target.value })}
                  />
                </div>
                
                <Input 
                    label="Email" 
                    value={profile.email} 
                    disabled 
                    className="bg-slate-50 text-slate-500 cursor-not-allowed"
                />

                <Input
                    label="Location / Address"
                    value={profile.location}
                    onChange={(e) => editProfile({ location: e.target.value })}
                />
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">My Care Needs</label>
                  <div className="flex flex-wrap gap-2 items-center">
                    {profile.needs?.map((need, idx) => (
                        <Badge key={idx} variant="info" className="flex items-center gap-1 pr-1.5">
                          {need}
                          <button 
                            onClick={() => removeNeed(idx)}
                            className="hover:text-primary-900 hover:bg-primary-200 rounded-full p-0.5 transition-colors"
                          >
                            <X size={12} />
                          </button>
                        </Badge>
                    ))}
                    
                    {!isAddingNeed ? (
                      <button 
                        onClick={() => setIsAddingNeed(true)}
                        className="text-xs border border-dashed border-slate-300 text-slate-500 px-3 py-1 rounded-full hover:border-primary-500 hover:text-primary-600 transition-colors flex items-center"
                      >
                        <Plus size={12} className="mr-1" /> Add Need
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 animate-slide-in">
                        <input 
                          autoFocus
                          type="text" 
                          className="text-sm border border-slate-300 rounded-lg px-2 py-1 w-32 focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-200"
                          placeholder="e.g. Mobility"
                          value={newNeed}
                          onChange={(e) => setNewNeed(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addNeed()}
                        />
                        <Button size="sm" onClick={addNeed} className="py-1 px-2 h-auto text-xs rounded-lg">Add</Button>
                        <button onClick={() => setIsAddingNeed(false)} className="text-slate-400 hover:text-slate-600">
                          <X size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="pt-4">
                  <Button onClick={handleSave} fullWidth>Save Changes</Button>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden mb-6">
            <div className="p-6">
              <h3 className="font-bold text-slate-900 mb-4 flex items-center">
                <CreditCard className="w-5 h-5 mr-2 text-primary-600" /> Payment Methods
              </h3>
              <div className="flex items-center justify-between p-3 border border-slate-200 rounded-xl mb-3">
                <div className="flex items-center">
                  <div className="w-10 h-6 bg-slate-800 rounded mr-3"></div>
                  <span className="text-slate-700 font-medium">•••• 4242</span>
                </div>
                <span className="text-xs bg-slate-100 px-2 py-1 rounded text-slate-600">Default</span>
              </div>
              <Button variant="secondary" size="sm" fullWidth>Add New Card</Button>
            </div>
          </div>
        </>
      )}

      {activeTab === 'family' && (
          <FamilyManager onShowToast={onShowToast} />
      )}

      {activeTab === 'security' && (
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 mb-6">
           <h3 className="font-bold text-slate-900 mb-4 flex items-center">
             <Lock className="w-5 h-5 mr-2 text-primary-600" /> Security Settings
           </h3>
           
           <div className="space-y-4 mb-8 border-b border-slate-100 pb-8">
              <h4 className="text-sm font-bold text-slate-700">Change Password</h4>
              <Input 
                label="New Password" 
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <Input 
                label="Confirm Password" 
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              <Button onClick={handlePasswordChange} disabled={!newPassword}>Update Password</Button>
           </div>

           <div>
              <h4 className="text-sm font-bold text-red-600 mb-2">Danger Zone</h4>
              <p className="text-sm text-slate-500 mb-4">Deleting your account is permanent. All data will be wiped.</p>
              <button 
                onClick={handleDeleteAccount}
                className="flex items-center text-red-500 hover:text-red-700 font-medium border border-red-200 hover:bg-red-50 px-4 py-2 rounded-xl transition-all"
              >
                <Trash2 className="w-4 h-4 mr-2" /> Delete Account
              </button>
           </div>
        </div>
      )}

      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
         <button onClick={() => onNavigate('client')} className="w-full p-4 text-left flex items-center text-slate-700 hover:bg-slate-50 transition-colors font-medium border-b border-slate-100">
           <Home className="w-5 h-5 mr-3 text-slate-400" />
           Return to Dashboard
         </button>
         <button onClick={handleLogout} className="w-full p-4 text-left flex items-center text-red-500 hover:bg-red-50 transition-colors font-medium">
           <LogOut className="w-5 h-5 mr-3" />
           Log Out
         </button>
      </div>
      </div>
    </div>
  );
};
