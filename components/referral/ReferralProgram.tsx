import React, { useState, useEffect } from 'react';
import { Gift, Copy, Check, Share2, Mail, MessageCircle, Users, DollarSign } from 'lucide-react';
import { Button } from '../ui/Button';
import { dbService, authService } from '../../services/api';
import { AddToastFunction } from '../../types';

interface ReferralProgramProps {
  userId: string;
  userType: 'client' | 'caregiver';
  onShowToast: AddToastFunction;
}

interface ReferralStats {
  totalReferrals: number;
  successfulReferrals: number;
  pendingReferrals: number;
  totalEarnings: number;
  referralCode: string;
}

interface Referral {
  id: string;
  referredName: string;
  referredEmail: string;
  status: 'pending' | 'successful';
  date: string;
  reward?: number;
}

/**
 * Referral Program Component
 * Allows users to invite friends and earn rewards
 */
export const ReferralProgram: React.FC<ReferralProgramProps> = ({
  userId,
  userType,
  onShowToast
}) => {
  const [stats, setStats] = useState<ReferralStats>({
    totalReferrals: 0,
    successfulReferrals: 0,
    pendingReferrals: 0,
    totalEarnings: 0,
    referralCode: ''
  });
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    loadReferralData();
  }, [userId]);

  const loadReferralData = async () => {
    try {
      const [referralStats, referralList] = await Promise.all([
        dbService.getReferralStats(userId),
        dbService.getReferrals(userId)
      ]);
      
      setStats(referralStats);
      setReferrals(referralList as any);
    } catch (error) {
      console.error('Failed to load referral data:', error);
    } finally {
      setLoading(false);
    }
  };

  const referralLink = `${window.location.origin}/signup?ref=${stats.referralCode}&type=${userType}`;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onShowToast('Referral link copied!', 'success');
    } catch (error) {
      onShowToast('Failed to copy link', 'error');
    }
  };

  const sendEmailInvite = async () => {
    if (!emailInput || !emailInput.includes('@')) {
      onShowToast('Please enter a valid email', 'error');
      return;
    }

    setSending(true);
    try {
      await dbService.sendReferralInvite(userId, emailInput, userType);
      onShowToast('Invitation sent!', 'success');
      setEmailInput('');
    } catch (error) {
      onShowToast('Failed to send invitation', 'error');
    } finally {
      setSending(false);
    }
  };

  const shareVia = async (platform: 'whatsapp' | 'sms' | 'email') => {
    const message = `Join me on CareConnex! Use my referral code ${stats.referralCode} and we both get $25 credit. ${referralLink}`;
    
    switch (platform) {
      case 'whatsapp':
        window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
        break;
      case 'sms':
        window.open(`sms:?body=${encodeURIComponent(message)}`, '_blank');
        break;
      case 'email':
        window.open(`mailto:?subject=Join CareConnex&body=${encodeURIComponent(message)}`, '_blank');
        break;
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* Header */}
      <div className="text-center mb-10">
        <div className="w-20 h-20 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Gift className="w-10 h-10 text-primary-600" />
        </div>
        <h2 className="text-3xl font-bold text-slate-900 mb-2">Refer & Earn</h2>
        <p className="text-slate-500">
          Invite friends to CareConnex and earn <strong>$25</strong> for each person who completes their first booking
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-10">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 text-center">
          <div className="text-3xl font-bold text-slate-900">{stats.totalReferrals}</div>
          <div className="text-sm text-slate-500">Total Referrals</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 text-center">
          <div className="text-3xl font-bold text-emerald-600">{stats.successfulReferrals}</div>
          <div className="text-sm text-slate-500">Successful</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 text-center">
          <div className="text-3xl font-bold text-accent-600">{stats.pendingReferrals}</div>
          <div className="text-sm text-slate-500">Pending</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 text-center">
          <div className="text-3xl font-bold text-primary-600">${stats.totalEarnings}</div>
          <div className="text-sm text-slate-500">Earned</div>
        </div>
      </div>

      {/* Referral Link */}
      <div className="bg-gradient-to-r from-primary-500 to-primary-600 rounded-2xl p-8 text-white mb-10">
        <h3 className="text-xl font-bold mb-4">Your Referral Link</h3>
        <div className="flex gap-3 mb-6">
          <div className="flex-1 bg-white/20 rounded-xl px-4 py-3 text-white font-mono text-sm truncate">
            {referralLink}
          </div>
          <button
            onClick={copyToClipboard}
            className="bg-white text-primary-600 px-6 py-3 rounded-xl font-semibold hover:bg-primary-50 transition-colors flex items-center gap-2"
          >
            {copied ? <><Check className="w-5 h-5" /> Copied</> : <><Copy className="w-5 h-5" /> Copy</>}
          </button>
        </div>

        {/* Share Buttons */}
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => shareVia('whatsapp')}
            className="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
          >
            <MessageCircle className="w-5 h-5" /> WhatsApp
          </button>
          <button
            onClick={() => shareVia('sms')}
            className="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
          >
            <Mail className="w-5 h-5" /> SMS
          </button>
          <button
            onClick={() => shareVia('email')}
            className="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
          >
            <Share2 className="w-5 h-5" /> Email
          </button>
        </div>
      </div>

      {/* Email Invite */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-10">
        <h3 className="text-lg font-bold text-slate-900 mb-4">Send Email Invite</h3>
        <div className="flex gap-3">
          <input
            type="email"
            placeholder="Enter email address"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            className="flex-1 px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none"
          />
          <Button
            onClick={sendEmailInvite}
            disabled={sending}
            className="px-6"
          >
            {sending ? 'Sending...' : 'Send Invite'}
          </Button>
        </div>
      </div>

      {/* Referrals List */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Users className="w-5 h-5 text-primary-600" /> Your Referrals
          </h3>
        </div>
        
        {referrals.length === 0 ? (
          <div className="p-8 text-center text-slate-500">
            <Users className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No referrals yet. Share your link to get started!</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left p-4 font-semibold text-slate-700">Name</th>
                <th className="text-left p-4 font-semibold text-slate-700">Date</th>
                <th className="text-left p-4 font-semibold text-slate-700">Status</th>
                <th className="text-right p-4 font-semibold text-slate-700">Reward</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((referral) => (
                <tr key={referral.id} className="border-t border-slate-100">
                  <td className="p-4">
                    <div className="font-medium text-slate-900">{referral.referredName}</div>
                    <div className="text-sm text-slate-500">{referral.referredEmail}</div>
                  </td>
                  <td className="p-4 text-slate-600">
                    {new Date(referral.date).toLocaleDateString()}
                  </td>
                  <td className="p-4">
                    <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium ${
                      referral.status === 'successful'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-accent-100 text-accent-700'
                    }`}>
                      {referral.status === 'successful' ? (
                        <><Check className="w-4 h-4" /> Completed</>
                      ) : (
                        'Pending'
                      )}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    {referral.reward ? (
                      <span className="font-bold text-emerald-600">+${referral.reward}</span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* How It Works */}
      <div className="mt-10 bg-slate-50 rounded-2xl p-6">
        <h3 className="text-lg font-bold text-slate-900 mb-4">How It Works</h3>
        <div className="grid md:grid-cols-3 gap-6">
          <div className="text-center">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Share2 className="w-6 h-6 text-primary-600" />
            </div>
            <h4 className="font-semibold text-slate-900 mb-1">1. Share</h4>
            <p className="text-sm text-slate-500">Share your unique referral link with friends and family</p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Users className="w-6 h-6 text-primary-600" />
            </div>
            <h4 className="font-semibold text-slate-900 mb-1">2. They Join</h4>
            <p className="text-sm text-slate-500">They sign up and complete their first care booking</p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <DollarSign className="w-6 h-6 text-primary-600" />
            </div>
            <h4 className="font-semibold text-slate-900 mb-1">3. You Earn</h4>
            <p className="text-sm text-slate-500">Both of you get $25 credit applied to your accounts</p>
          </div>
        </div>
      </div>
    </div>
  );
};
