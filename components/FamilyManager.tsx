
import React, { useState, useEffect } from 'react';
import { Users, Plus, Mail, Phone, Check, X } from 'lucide-react';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { dbService, authService } from '../services/api';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { AddToastFunction, FamilyMember } from '../types';

interface FamilyManagerProps {
  onShowToast: AddToastFunction;
}

export const FamilyManager: React.FC<FamilyManagerProps> = ({ onShowToast }) => {
  const [email,   setEmail]   = useState('');
  const [phone,   setPhone]   = useState('');
  const [loading, setLoading] = useState(false);
  const [members, setMembers] = useState<FamilyMember[]>([]);

  useEffect(() => {
    const user = authService.getCurrentUser();
    if (!user) return;
    dbService.getFamilyMembers(user.uid)
      .then((fetched: FamilyMember[]) => {
        // Always show the current user as admin at the top
        const self: FamilyMember = {
          id: user.uid,
          name: user.displayName || 'You',
          email: user.email || '',
          role: 'admin',
          status: 'active'
        };
        const others = fetched.filter(m => m.id !== user.uid && m.email !== user.email);
        setMembers([self, ...others]);
      })
      .catch(() => {
        const user2 = authService.getCurrentUser();
        if (user2) {
          setMembers([{ id: user2.uid, name: user2.displayName || 'You', email: user2.email || '', role: 'admin', status: 'active' }]);
        }
      });
  }, []);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const user = authService.getCurrentUser();

    try {
      if (user) {
        const normalizedPhone = phone.replace(/\D/g, '');
        const e164Phone = normalizedPhone.length === 10
          ? `+1${normalizedPhone}`
          : normalizedPhone.length > 10 ? `+${normalizedPhone}` : undefined;

        const newMember = await dbService.inviteFamilyMember(user.uid, email, e164Phone);
        const updatedMembers = [...members, newMember];
        setMembers(updatedMembers);
        onShowToast(`Invitation sent to ${email}`, 'success');
        setEmail('');
        setPhone('');

        // If we now have 2+ members with phones, create/update the iMessage group
        const phonedMembers = updatedMembers.filter(m => m.phone);
        if (phonedMembers.length >= 2) {
          try {
            const fn = httpsCallable(getFunctions(), 'createFamilyGroup');
            await fn({ seniorId: user.uid });
          } catch {
            // Non-blocking — group creation failure shouldn't surface to user
          }
        }
      }
    } catch {
      onShowToast('Failed to invite member', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6">
        <h3 className="font-bold text-slate-900 mb-2 flex items-center">
            <Users className="w-5 h-5 mr-2 text-primary-600" /> Family Access
        </h3>
        <p className="text-sm text-slate-500 mb-6">
            Invite family members to view the Care Plan, see updates, or manage billing.
        </p>

        <form onSubmit={handleInvite} className="space-y-3 mb-8">
          <div className="flex gap-2">
            <div className="flex-grow">
              <Input
                label=""
                placeholder="Email address"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mb-0"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-grow">
              <Input
                label=""
                placeholder="Phone number (optional — for iMessage updates)"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mb-0"
              />
            </div>
            <Button type="submit" disabled={!email || loading} className="h-[50px]">
              {loading ? 'Sending...' : <><Plus className="w-4 h-4 mr-2" /> Invite</>}
            </Button>
          </div>
        </form>

        <div className="space-y-4">
            {members.map((m) => (
                <div key={m.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <div className="flex items-center gap-3">
                        <div className="bg-white p-2 rounded-full border border-slate-200">
                            <Mail className="w-4 h-4 text-slate-400" />
                        </div>
                        <div>
                          <p className="font-bold text-sm text-slate-800">{m.email}</p>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500 capitalize">{m.role}</span>
                            {m.phone && (
                              <span className="text-xs text-teal-600 flex items-center gap-0.5">
                                <Phone className="w-2.5 h-2.5" /> iMessage
                              </span>
                            )}
                          </div>
                        </div>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full font-bold uppercase ${
                        m.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-accent-100 text-accent-700'
                    }`}>
                        {m.status}
                    </span>
                </div>
            ))}
        </div>
    </div>
  );
};
