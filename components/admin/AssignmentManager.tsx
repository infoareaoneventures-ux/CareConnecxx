import React, { useState, useEffect } from 'react';
import {
  Users, UserCheck, Search, X, Check,
  Mail, Briefcase
} from 'lucide-react';
import firebase, { db } from '../../lib/firebase';

interface Client {
  id: string;
  name: string;
  email: string;
  phone?: string;
  address?: string;
  status: 'pending' | 'active' | 'inactive';
  assignedCoordinatorId?: string;
  assignedCaregiverIds?: string[];
  careNeeds?: string[];
  createdAt?: string;
}

interface CareCoordinator {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  assignedClients?: number;
  imageUrl?: string;
}

interface Caregiver {
  id: string;
  name: string;
  email: string;
  phone?: string;
  rating: number;
  yearsExperience: number;
  specialties?: string[];
  isAvailable: boolean;
  assignedClients?: number;
  imageUrl?: string;
}

interface AssignmentModalProps {
  client: Client;
  type: 'coordinator' | 'caregiver';
  onClose: () => void;
  onAssign: (clientId: string, assigneeId: string) => Promise<void>;
  coordinators?: CareCoordinator[];
  caregivers?: Caregiver[];
}

const AssignmentModal: React.FC<AssignmentModalProps> = ({ 
  client, type, onClose, onAssign, coordinators, caregivers 
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);

  const items = type === 'coordinator' ? coordinators : caregivers;
  const filteredItems = items?.filter(item => 
    item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleAssign = async () => {
    if (!selectedId) return;
    setIsAssigning(true);
    try {
      await onAssign(client.id, selectedId);
      onClose();
    } catch (error) {
      console.error('Assignment failed:', error);
    } finally {
      setIsAssigning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-900">
              Assign {type === 'coordinator' ? 'Care Coordinator' : 'Caregiver'}
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              for {client.name}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="p-6 flex-1 overflow-hidden flex flex-col">
          {/* Search */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={`Search ${type}s...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>

          {/* List */}
          <div className="flex-1 overflow-auto space-y-2">
            {filteredItems?.map((item) => (
              <div
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                  selectedId === item.id
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className="flex items-center gap-4">
                  <img
                    src={item.imageUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(item.name)}&background=random`}
                    alt={item.name}
                    className="w-12 h-12 rounded-full object-cover"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-slate-900">{item.name}</h4>
                      {'rating' in item && (
                        <span className="text-sm text-accent-500">★ {item.rating}</span>
                      )}
                    </div>
                    <p className="text-sm text-slate-500">{item.email}</p>
                    <div className="flex items-center gap-4 mt-1 text-xs text-slate-400">
                      {'role' in item && <span>{item.role}</span>}
                      {'yearsExperience' in item && <span>{item.yearsExperience} years exp.</span>}
                      {'assignedClients' in item && item.assignedClients !== undefined && (
                        <span>{item.assignedClients} clients</span>
                      )}
                    </div>
                    {'specialties' in item && item.specialties && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {item.specialties.slice(0, 3).map((spec, i) => (
                          <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">
                            {spec}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {selectedId === item.id && (
                    <Check className="w-5 h-5 text-primary-600" />
                  )}
                </div>
              </div>
            ))}
            {filteredItems?.length === 0 && (
              <p className="text-center text-slate-500 py-8">No {type}s found</p>
            )}
          </div>
        </div>

        <div className="p-6 border-t border-slate-100 flex justify-end gap-3">
          <button 
            onClick={onClose}
            className="px-4 py-2 border border-slate-200 rounded-lg text-slate-600 font-medium hover:bg-slate-50"
          >
            Cancel
          </button>
          <button 
            onClick={handleAssign}
            disabled={!selectedId || isAssigning}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isAssigning ? 'Assigning...' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const AssignmentManager: React.FC = () => {
  const [clients, setClients] = useState<Client[]>([]);
  const [coordinators, setCoordinators] = useState<CareCoordinator[]>([]);
  const [caregivers, setCaregivers] = useState<Caregiver[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [assignmentModal, setAssignmentModal] = useState<{
    client: Client;
    type: 'coordinator' | 'caregiver';
  } | null>(null);

  useEffect(() => {
    if (!db) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const [usersSnap, caregiversSnap] = await Promise.all([
          db!.collection('users').get(),
          db!.collection('caregivers').get(),
        ]);

        if (cancelled) return;

        const allUsers = usersSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

        const realClients: Client[] = allUsers
          .filter(u => u.userType === 'client')
          .map(u => ({
            id: u.id,
            name: u.displayName || u.name || u.firstName || 'Unnamed',
            email: u.email || '',
            phone: u.phone,
            address: [u.city, u.state].filter(Boolean).join(', ') || u.address,
            status: u.isBanned ? 'inactive' : (u.subscriptionActive ? 'active' : 'pending'),
            assignedCoordinatorId: u.assignedCoordinatorId,
            assignedCaregiverIds: u.assignedCaregiverIds || [],
            careNeeds: u.careNeeds || [],
            createdAt: u.createdAt,
          }));

        const realCoordinators: CareCoordinator[] = allUsers
          .filter(u => u.userType === 'coordinator')
          .map(u => ({
            id: u.id,
            name: u.displayName || u.name || 'Unnamed',
            email: u.email || '',
            phone: u.phone,
            role: u.title || 'Care Coordinator',
            imageUrl: u.photoURL || u.imageUrl,
            assignedClients: realClients.filter(cl => cl.assignedCoordinatorId === u.id).length,
          }));

        const realCaregivers: Caregiver[] = caregiversSnap.docs.map(d => {
          const data = d.data() as any;
          return {
            id: d.id,
            name: data.name || 'Unnamed',
            email: data.email || '',
            phone: data.phone,
            rating: typeof data.rating === 'number' ? data.rating : 0,
            yearsExperience: data.experience || data.yearsExperience || 0,
            specialties: data.skills || data.specialties || [],
            isAvailable: data.profileVisibility !== 'hidden',
            imageUrl: data.imageUrl || data.photo,
            assignedClients: realClients.filter(cl => cl.assignedCaregiverIds?.includes(d.id)).length,
          };
        });

        setClients(realClients);
        setCoordinators(realCoordinators);
        setCaregivers(realCaregivers);
      } catch (err) {
        console.error('Failed to load assignment data:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const handleAssignCoordinator = async (clientId: string, coordinatorId: string) => {
    if (!db) return;
    const previousCoordinatorId = clients.find(c => c.id === clientId)?.assignedCoordinatorId;
    await db.collection('users').doc(clientId).update({ assignedCoordinatorId: coordinatorId });
    setClients(prev => prev.map(c =>
      c.id === clientId ? { ...c, assignedCoordinatorId: coordinatorId } : c
    ));
    setCoordinators(prev => prev.map(cc => {
      if (cc.id === coordinatorId) {
        return { ...cc, assignedClients: (cc.assignedClients || 0) + 1 };
      }
      if (cc.id === previousCoordinatorId) {
        return { ...cc, assignedClients: Math.max(0, (cc.assignedClients || 1) - 1) };
      }
      return cc;
    }));
  };

  const handleAssignCaregiver = async (clientId: string, caregiverId: string) => {
    if (!db) return;
    await db.collection('users').doc(clientId).update({
      assignedCaregiverIds: firebase.firestore.FieldValue.arrayUnion(caregiverId),
    });
    setClients(prev => prev.map(c =>
      c.id === clientId
        ? { ...c, assignedCaregiverIds: [...(c.assignedCaregiverIds || []), caregiverId] }
        : c
    ));
    setCaregivers(prev => prev.map(cg =>
      cg.id === caregiverId
        ? { ...cg, assignedClients: (cg.assignedClients || 0) + 1 }
        : cg
    ));
  };

  const handleRemoveCaregiver = async (clientId: string, caregiverId: string) => {
    if (!db) return;
    await db.collection('users').doc(clientId).update({
      assignedCaregiverIds: firebase.firestore.FieldValue.arrayRemove(caregiverId),
    });
    setClients(prev => prev.map(c =>
      c.id === clientId
        ? { ...c, assignedCaregiverIds: c.assignedCaregiverIds?.filter(id => id !== caregiverId) }
        : c
    ));
    setCaregivers(prev => prev.map(cg =>
      cg.id === caregiverId
        ? { ...cg, assignedClients: Math.max(0, (cg.assignedClients || 1) - 1) }
        : cg
    ));
  };

  const getAssignedCoordinator = (coordinatorId?: string) => {
    return coordinators.find(c => c.id === coordinatorId);
  };

  const getAssignedCaregivers = (caregiverIds?: string[]) => {
    return caregivers.filter(cg => caregiverIds?.includes(cg.id));
  };

  const filteredClients = clients.filter(client =>
    client.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    client.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Search */}
      <div className="flex items-center justify-between">
        <div className="relative w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search clients..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
        <div className="flex items-center gap-4 text-sm text-slate-500">
          <span className="flex items-center gap-2">
            <Users className="w-4 h-4" />
            {clients.length} Clients
          </span>
          <span className="flex items-center gap-2">
            <UserCheck className="w-4 h-4" />
            {coordinators.length} Coordinators
          </span>
          <span className="flex items-center gap-2">
            <Briefcase className="w-4 h-4" />
            {caregivers.length} Caregivers
          </span>
        </div>
      </div>

      {/* Clients Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Client</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Care Coordinator</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Assigned Caregivers</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase px-6 py-4">Status</th>
              <th className="text-right text-xs font-semibold text-slate-500 uppercase px-6 py-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredClients.map((client) => {
              const assignedCoordinator = getAssignedCoordinator(client.assignedCoordinatorId);
              const assignedCaregivers = getAssignedCaregivers(client.assignedCaregiverIds);

              return (
                <tr key={client.id} className="hover:bg-slate-50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                        <span className="text-primary-700 font-semibold text-sm">
                          {client.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">{client.name}</p>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <Mail className="w-3 h-3" />
                          {client.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {assignedCoordinator ? (
                      <div className="flex items-center gap-2">
                        <img
                          src={assignedCoordinator.imageUrl}
                          alt={assignedCoordinator.name}
                          className="w-8 h-8 rounded-full object-cover"
                        />
                        <div>
                          <p className="text-sm font-medium text-slate-900">{assignedCoordinator.name}</p>
                          <p className="text-xs text-slate-500">{assignedCoordinator.role}</p>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAssignmentModal({ client, type: 'coordinator' })}
                        className="text-sm text-primary-600 hover:text-primary-700 font-medium"
                      >
                        + Assign Coordinator
                      </button>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="space-y-2">
                      {assignedCaregivers.length > 0 ? (
                        assignedCaregivers.map(cg => (
                          <div key={cg.id} className="flex items-center gap-2">
                            <img
                              src={cg.imageUrl}
                              alt={cg.name}
                              className="w-6 h-6 rounded-full object-cover"
                            />
                            <span className="text-sm text-slate-700">{cg.name}</span>
                            <button
                              onClick={() => handleRemoveCaregiver(client.id, cg.id)}
                              className="text-slate-400 hover:text-red-500"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))
                      ) : (
                        <span className="text-sm text-slate-400">No caregivers assigned</span>
                      )}
                      <button
                        onClick={() => setAssignmentModal({ client, type: 'caregiver' })}
                        className="text-sm text-primary-600 hover:text-primary-700 font-medium block"
                      >
                        + Add Caregiver
                      </button>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                      client.status === 'active' 
                        ? 'bg-green-50 text-green-700 border border-green-200'
                        : client.status === 'pending'
                        ? 'bg-accent-50 text-accent-700 border border-accent-200'
                        : 'bg-slate-50 text-slate-700 border border-slate-200'
                    }`}>
                      {client.status.charAt(0).toUpperCase() + client.status.slice(1)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    {assignedCoordinator && (
                      <button
                        onClick={() => setAssignmentModal({ client, type: 'coordinator' })}
                        className="text-sm text-slate-500 hover:text-primary-600"
                      >
                        Change
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredClients.length === 0 && (
          <div className="text-center py-12">
            <Users className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">No clients found</p>
          </div>
        )}
      </div>

      {/* Assignment Modal */}
      {assignmentModal && (
        <AssignmentModal
          client={assignmentModal.client}
          type={assignmentModal.type}
          onClose={() => setAssignmentModal(null)}
          onAssign={assignmentModal.type === 'coordinator' ? handleAssignCoordinator : handleAssignCaregiver}
          coordinators={coordinators}
          caregivers={caregivers}
        />
      )}
    </div>
  );
};

export default AssignmentManager;
