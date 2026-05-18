import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, MessageCircle, Star, Award, MapPin, Calendar, Clock, Shield, Heart, MessageSquare, Mail, Headphones } from 'lucide-react';
import { CaregiverVerificationBadges } from '../shared/CaregiverVerificationBadges';
import { Button } from '../ui/Button';
import { ClientNavigation } from './ClientNavigation';
import { useCareConnex } from '../../context/CareConnexContext';
import { db } from '../../lib/firebase';
import { authService } from '../../services/api';
import { IdentityGateModal } from './IdentityGateModal';
import { chatService } from '../../services/chatService';

interface Caregiver {
  id: string;
  name: string;
  imageUrl?: string;
  rating: number;
  yearsExperience: number;
  hourlyRate: number;
  isTopRated?: boolean;
  specialties?: string[];
  location?: string;
  nextShift?: string;
}

interface CareConnexTeamMember {
  id: string;
  name: string;
  role: string;
  imageUrl?: string;
  phone?: string;
  email?: string;
}

export const MyCareTeam: React.FC = () => {
  const navigate = useNavigate();
  const { addToast } = useCareConnex();
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [careConnexTeam, setCareConnexTeam] = useState<CareConnexTeamMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showIdentityGate, setShowIdentityGate] = useState(false);
  const [pendingMessageTarget, setPendingMessageTarget] = useState<{ id: string; name: string } | null>(null);
  const [identityStatus, setIdentityStatus] = useState<string>('not_started');

  useEffect(() => {
    let isMounted = true;
    const loadTeam = async () => {
      try {
        const uid = authService.getCurrentUser()?.uid;
        if (!uid) { setIsLoading(false); return; }

        // Find caregivers the client has confirmed appointments with
        const apptSnap = await db.collection('appointments')
          .where('clientId', '==', uid)
          .where('status', 'in', ['confirmed', 'completed', 'in-progress'])
          .orderBy('isoDate', 'desc')
          .limit(50)
          .get();

        // Collect unique caregiver IDs
        const caregiverMap = new Map<string, { id: string; nextShift?: string }>();
        apptSnap.docs.forEach(doc => {
          const d = doc.data();
          if (d.caregiverId && !caregiverMap.has(d.caregiverId)) {
            caregiverMap.set(d.caregiverId, {
              id: d.caregiverId,
              nextShift: d.status === 'confirmed' ? `${d.date || ''} ${d.time || ''}`.trim() : undefined,
            });
          }
        });

        // Fetch caregiver profiles
        const caregiverList: Caregiver[] = [];
        for (const [cgId, meta] of caregiverMap) {
          const cgDoc = await db.collection('caregivers').doc(cgId).get();
          if (!cgDoc.exists) continue;
          const d = cgDoc.data()!;
          const fullName = d.name || `${d.firstName || ''} ${d.lastName || ''}`.trim() || 'Caregiver';
          const city = d.city || '';
          const state = d.state || '';
          caregiverList.push({
            id: cgId,
            name: fullName,
            imageUrl: d.photoURL || d.imageUrl,
            rating: d.rating ?? 0,
            yearsExperience: d.yearsExperience ?? 0,
            hourlyRate: d.hourlyRate ?? 0,
            isTopRated: (d.rating ?? 0) >= 4.8,
            specialties: d.specializations || d.specialties || [],
            location: city ? `${city}${state ? `, ${state}` : ''}` : (d.location || ''),
            nextShift: meta.nextShift,
          });
        }

        // CareConnex support team (loaded from Firestore or default)
        let teamList: CareConnexTeamMember[] = [];
        const teamSnap = await db.collection('teamMembers').where('isActive', '==', true).get();
        if (!teamSnap.empty) {
          teamSnap.docs.forEach(doc => {
            const d = doc.data();
            teamList.push({ id: doc.id, name: d.name, role: d.role, imageUrl: d.imageUrl, phone: d.phone, email: d.email });
          });
        } else {
          // Default support contact
          teamList = [{
            id: 'support',
            name: 'CareConnex Support',
            role: 'Care Coordination Team',
            phone: '',
            email: 'support@careconnex.com',
          }];
        }

        if (!isMounted) return;
        setCaregivers(caregiverList);
        setCareConnexTeam(teamList);
      } catch (err) {
        console.error('Error loading care team:', err);
        if (isMounted) addToast('Could not load your care team. Please refresh.', 'error');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    loadTeam();
    return () => { isMounted = false; };
  }, []);

  // Load identity check status
  useEffect(() => {
    const uid = authService.getCurrentUser()?.uid;
    if (!uid || !db) return;
    let isMounted = true;
    db.collection('users').doc(uid).get()
      .then(doc => {
        if (!isMounted) return;
        setIdentityStatus((doc.data() as any)?.identityCheckStatus || 'not_started');
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, []);

  const bypass = import.meta.env.VITE_BYPASS_ONBOARDING === 'true';

  const handleMessage = async (caregiverId: string, caregiverName: string) => {
    if (!bypass && identityStatus !== 'verified') {
      setPendingMessageTarget({ id: caregiverId, name: caregiverName });
      setShowIdentityGate(true);
      return;
    }
    try {
      const currentUid = authService.getCurrentUser()?.uid;
      const currentName = authService.getCurrentUser()?.displayName
        || authService.getCurrentUser()?.email?.split('@')[0]
        || 'Client';
      if (currentUid) {
        const roomId = await chatService.getOrCreateChatRoom(currentUid, currentName, caregiverId, caregiverName);
        navigate(`/client/inbox?room=${roomId}`);
      } else {
        navigate('/client/inbox');
      }
    } catch {
      navigate('/client/inbox');
    }
  };

  const handleCall = (caregiverName: string) => {
    addToast(`Calling ${caregiverName}...`, 'info');
    // In production, this would initiate a call
  };

  const handleTeamMemberCall = (phone: string, name: string) => {
    window.location.href = `tel:${phone}`;
    addToast(`Calling ${name}...`, 'info');
  };

  const handleTeamMemberEmail = (email: string, name: string) => {
    window.location.href = `mailto:${email}`;
    addToast(`Opening email to ${name}...`, 'info');
  };

  const renderStars = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    
    return (
      <div className="flex items-center space-x-0.5">
        {[...Array(5)].map((_, i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${
              i < fullStars
                ? 'text-yellow-400 fill-yellow-400'
                : i === fullStars && hasHalfStar
                ? 'text-yellow-400 fill-yellow-400/50'
                : 'text-gray-300'
            }`}
          />
        ))}
        <span className="ml-1 text-sm font-semibold text-gray-700">{rating}</span>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ClientNavigation />
        <div className="flex items-center justify-center h-[calc(100vh-64px)]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <ClientNavigation />
      
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-32">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">My Care Team</h1>
          <p className="text-gray-600 mt-2">
            Your dedicated caregivers who provide compassionate care for your loved ones
          </p>
        </div>

        {/* CareConnex Team Section */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">CareConnex Team</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {careConnexTeam.map((member) => (
              <div
                key={member.id}
                className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 flex items-center space-x-4 hover:shadow-md transition-shadow"
              >
                {/* Profile Photo */}
                <img
                  src={member.imageUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(member.name)}&background=random`}
                  alt={member.name}
                  className="w-14 h-14 rounded-full object-cover border-2 border-white shadow-sm"
                />
                
                {/* Name and Role */}
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900">{member.name}</h3>
                  <p className="text-sm text-primary-600">{member.role}</p>
                </div>

                {/* Action Buttons */}
                <div className="flex space-x-2">
                  {member.phone && (
                    <button
                      onClick={() => handleTeamMemberCall(member.phone!, member.name)}
                      className="p-2 rounded-full bg-primary-50 text-primary-600 hover:bg-primary-100 transition-colors"
                      title={`Call ${member.name}`}
                    >
                      <Phone className="w-5 h-5" />
                    </button>
                  )}
                  {member.email && (
                    <button
                      onClick={() => handleTeamMemberEmail(member.email!, member.name)}
                      className="p-2 rounded-full bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors"
                      title={`Email ${member.name}`}
                    >
                      <Mail className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Caregiver Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {caregivers.map((caregiver) => (
            <div
              key={caregiver.id}
              className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
            >
              <div className="p-6">
                {/* Top Section: Photo and Basic Info */}
                <div className="flex items-start space-x-4">
                  {/* Profile Photo */}
                  <div className="relative">
                    <img
                      src={caregiver.imageUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(caregiver.name)}&background=random`}
                      alt={caregiver.name}
                      className="w-20 h-20 rounded-full object-cover border-4 border-white shadow-md"
                    />
                    {caregiver.isTopRated && (
                      <div className="absolute -bottom-1 -right-1 bg-gradient-to-r from-yellow-400 to-accent-500 text-white text-xs font-bold px-2 py-0.5 rounded-full shadow-sm">
                        Top rated
                      </div>
                    )}
                  </div>

                  {/* Name and Details */}
                  <div className="flex-1">
                    <h2 className="text-xl font-bold text-gray-900">{caregiver.name}</h2>
                    <p className="text-sm text-gray-500 mb-2">Caregiver</p>

                    {/* Rating */}
                    {renderStars(caregiver.rating)}
                    <CaregiverVerificationBadges verified={(caregiver as any).verified} backgroundCheckStatus={(caregiver as any).backgroundCheckStatus} className="mt-2" />
                  </div>
                </div>

                {/* Stats Row */}
                <div className="flex items-center space-x-6 mt-5 pt-4 border-t border-gray-100">
                  <div className="flex items-center space-x-2">
                    <Calendar className="w-4 h-4 text-primary-600" />
                    <span className="text-sm text-gray-600">
                      <span className="font-semibold text-gray-900">{caregiver.yearsExperience}</span> years exp.
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-lg font-bold text-primary-600">${caregiver.hourlyRate}</span>
                    <span className="text-sm text-gray-500">/hr</span>
                  </div>
                </div>

                {/* Specialties */}
                {caregiver.specialties && caregiver.specialties.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-4">
                    {caregiver.specialties.map((specialty) => (
                      <span
                        key={specialty}
                        className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-primary-50 text-primary-700"
                      >
                        <Shield className="w-3 h-3 mr-1" />
                        {specialty}
                      </span>
                    ))}
                  </div>
                )}

                {/* Next Shift */}
                {caregiver.nextShift && (
                  <div className="flex items-center space-x-2 mt-4 text-sm text-gray-600">
                    <Clock className="w-4 h-4 text-gray-400" />
                    <span>Next shift: <span className="font-medium text-gray-900">{caregiver.nextShift}</span></span>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex space-x-3 mt-6">
                  <Button
                    onClick={() => handleMessage(caregiver.id, caregiver.name)}
                    className="flex-1 bg-primary-600 hover:bg-primary-700 text-white"
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Message
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleCall(caregiver.name)}
                    className="flex-1 border-gray-300 text-gray-700 hover:bg-gray-50"
                  >
                    <Phone className="w-4 h-4 mr-2" />
                    Call
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Empty State */}
        {caregivers.length === 0 && (
          <div className="text-center py-16">
            <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Heart className="w-10 h-10 text-gray-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No caregivers assigned yet</h3>
            <p className="text-gray-600 mb-6">Your care team will appear here once caregivers are assigned to you.</p>
            <Button onClick={() => navigate('/client/dashboard')}>
              Back to Dashboard
            </Button>
          </div>
        )}

        {/* Info Card */}
        <div className="mt-8 bg-gradient-to-r from-primary-50 to-blue-50 rounded-2xl p-6 border border-primary-100">
          <div className="flex items-start space-x-4">
            <div className="w-10 h-10 bg-primary-100 rounded-xl flex items-center justify-center flex-shrink-0">
              <Award className="w-5 h-5 text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">Quality Care You Can Trust</h3>
              <p className="text-sm text-gray-600">
                All our caregivers are thoroughly vetted, background-checked, and continuously trained 
                to provide the highest quality care for your loved ones.
              </p>
            </div>
          </div>
        </div>
      {showIdentityGate && (
        <IdentityGateModal
          onClose={() => { setShowIdentityGate(false); setPendingMessageTarget(null); }}
          onGetVerified={() => {
            setShowIdentityGate(false);
            navigate('/client/account');
            addToast('Complete identity verification in Account Settings', 'info');
          }}
        />
      )}
      </main>
    </div>
  );
};

export default MyCareTeam;
