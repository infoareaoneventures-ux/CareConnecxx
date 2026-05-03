import React, { useState, useEffect } from 'react';
import { 
  Plus, Search, Mail, Phone, User, Star, Users, CheckCircle, X, 
  MoreVertical, Edit2, Trash2, Loader2, Award
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { CareCoordinator } from '../../types';
import { dbService } from '../../services/api';
import { AddToastFunction } from '../../types';

interface CoordinatorManagementProps {
  onShowToast: AddToastFunction;
}

export const CoordinatorManagement: React.FC<CoordinatorManagementProps> = ({
  onShowToast
}) => {
  const [coordinators, setCoordinators] = useState<CareCoordinator[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCoordinator, setEditingCoordinator] = useState<CareCoordinator | null>(null);
  
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    title: '',
    bio: '',
    specialties: [] as string[],
    languages: [] as string[]
  });

  useEffect(() => {
    loadCoordinators();
  }, []);

  const loadCoordinators = async () => {
    setLoading(true);
    try {
      const data = await dbService.getCareCoordinators();
      setCoordinators(data);
    } catch (error) {
      console.error('Failed to load coordinators:', error);
      onShowToast('Failed to load coordinators', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    try {
      await dbService.createCareCoordinator({
        ...formData,
        isActive: true
      });
      onShowToast('Care coordinator created successfully', 'success');
      setShowCreateModal(false);
      resetForm();
      loadCoordinators();
    } catch (error) {
      console.error('Failed to create coordinator:', error);
      onShowToast('Failed to create coordinator', 'error');
    }
  };

  const handleUpdate = async () => {
    if (!editingCoordinator) return;
    
    try {
      await dbService.updateCareCoordinator(editingCoordinator.id, formData);
      onShowToast('Care coordinator updated successfully', 'success');
      setEditingCoordinator(null);
      resetForm();
      loadCoordinators();
    } catch (error) {
      console.error('Failed to update coordinator:', error);
      onShowToast('Failed to update coordinator', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to deactivate this coordinator?')) return;
    
    try {
      await dbService.updateCareCoordinator(id, { isActive: false });
      onShowToast('Care coordinator deactivated', 'success');
      loadCoordinators();
    } catch (error) {
      console.error('Failed to deactivate coordinator:', error);
      onShowToast('Failed to deactivate coordinator', 'error');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      email: '',
      phone: '',
      title: '',
      bio: '',
      specialties: [],
      languages: []
    });
  };

  const openEditModal = (coordinator: CareCoordinator) => {
    setEditingCoordinator(coordinator);
    setFormData({
      name: coordinator.name,
      email: coordinator.email,
      phone: coordinator.phone || '',
      title: coordinator.title || '',
      bio: coordinator.bio || '',
      specialties: coordinator.specialties || [],
      languages: coordinator.languages || []
    });
    setShowCreateModal(true);
  };

  const filteredCoordinators = coordinators.filter(c => 
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.title?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeCoordinators = filteredCoordinators.filter(c => c.isActive);
  const inactiveCoordinators = filteredCoordinators.filter(c => !c.isActive);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="relative w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search coordinators..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
        <Button onClick={() => {
          setEditingCoordinator(null);
          resetForm();
          setShowCreateModal(true);
        }}>
          <Plus className="w-4 h-4 mr-2" />
          Add Coordinator
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 border border-slate-200">
          <p className="text-sm text-slate-500">Total Coordinators</p>
          <p className="text-2xl font-bold text-slate-900">{coordinators.length}</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-200">
          <p className="text-sm text-slate-500">Active</p>
          <p className="text-2xl font-bold text-green-600">{activeCoordinators.length}</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-200">
          <p className="text-sm text-slate-500">Total Clients Assigned</p>
          <p className="text-2xl font-bold text-blue-600">
            {coordinators.reduce((sum, c) => sum + (c.assignedClients?.length || 0), 0)}
          </p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-200">
          <p className="text-sm text-slate-500">Completed Matches</p>
          <p className="text-2xl font-bold text-blue-600">
            {coordinators.reduce((sum, c) => sum + (c.completedMatches || 0), 0)}
          </p>
        </div>
      </div>

      {/* Active Coordinators */}
      <div>
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Active Coordinators</h3>
        {activeCoordinators.length === 0 ? (
          <div className="text-center py-12 bg-slate-50 rounded-xl">
            <User className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">No active coordinators</p>
            <Button 
              variant="outline" 
              className="mt-4"
              onClick={() => setShowCreateModal(true)}
            >
              Add Your First Coordinator
            </Button>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeCoordinators.map(coordinator => (
              <div key={coordinator.id} className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-primary-100 rounded-full flex items-center justify-center">
                      {coordinator.photoURL ? (
                        <img 
                          src={coordinator.photoURL} 
                          alt={coordinator.name}
                          className="w-full h-full rounded-full object-cover"
                        />
                      ) : (
                        <span className="text-primary-700 font-semibold">
                          {coordinator.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-900">{coordinator.name}</h4>
                      <p className="text-sm text-slate-500">{coordinator.title || 'Care Coordinator'}</p>
                    </div>
                  </div>
                  <div className="relative group">
                    <button className="p-2 hover:bg-slate-100 rounded-lg">
                      <MoreVertical className="w-4 h-4 text-slate-400" />
                    </button>
                    <div className="absolute right-0 mt-1 w-32 bg-white rounded-lg shadow-lg border border-slate-200 hidden group-hover:block z-10">
                      <button
                        onClick={() => openEditModal(coordinator)}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <Edit2 className="w-4 h-4" />
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(coordinator.id)}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                        Deactivate
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 mb-4">
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <Mail className="w-4 h-4 text-slate-400" />
                    {coordinator.email}
                  </div>
                  {coordinator.phone && (
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <Phone className="w-4 h-4 text-slate-400" />
                      {coordinator.phone}
                    </div>
                  )}
                </div>

                {coordinator.specialties && coordinator.specialties.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-4">
                    {coordinator.specialties.map(specialty => (
                      <Badge key={specialty} variant="secondary" className="text-xs">
                        {specialty}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2 pt-4 border-t border-slate-100">
                  <div className="text-center">
                    <p className="text-lg font-semibold text-slate-900">
                      {coordinator.assignedClients?.length || 0}
                    </p>
                    <p className="text-xs text-slate-500">Clients</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-semibold text-slate-900">
                      {coordinator.activeMatchAssignments || 0}
                    </p>
                    <p className="text-xs text-slate-500">Active</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-semibold text-slate-900">
                      {coordinator.completedMatches || 0}
                    </p>
                    <p className="text-xs text-slate-500">Completed</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Inactive Coordinators */}
      {inactiveCoordinators.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Inactive Coordinators</h3>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {inactiveCoordinators.map(coordinator => (
              <div key={coordinator.id} className="bg-slate-50 rounded-xl border border-slate-200 p-5 opacity-60">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 bg-slate-200 rounded-full flex items-center justify-center">
                    <span className="text-slate-500 font-semibold">
                      {coordinator.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <h4 className="font-semibold text-slate-700">{coordinator.name}</h4>
                    <Badge variant="secondary">Inactive</Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold text-slate-900">
                  {editingCoordinator ? 'Edit Coordinator' : 'Add Care Coordinator'}
                </h3>
                <button 
                  onClick={() => {
                    setShowCreateModal(false);
                    setEditingCoordinator(null);
                    resetForm();
                  }}
                  className="p-2 hover:bg-slate-100 rounded-full"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Full Name *
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Sarah Johnson"
                    className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Email *
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="sarah@careconnex.com"
                    className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Phone
                  </label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    placeholder="(555) 123-4567"
                    className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Title
                  </label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="e.g., Senior Care Coordinator"
                    className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Bio
                  </label>
                  <textarea
                    value={formData.bio}
                    onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                    placeholder="Brief description of experience and approach..."
                    rows={3}
                    className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Specialties (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={formData.specialties.join(', ')}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      specialties: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                    })}
                    placeholder="Dementia care, Post-surgery recovery, Parkinson's..."
                    className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Languages (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={formData.languages.join(', ')}
                    onChange={(e) => setFormData({ 
                      ...formData, 
                      languages: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                    })}
                    placeholder="English, Spanish, Mandarin..."
                    className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>

                <div className="flex gap-3 pt-4">
                  <Button 
                    variant="secondary" 
                    fullWidth
                    onClick={() => {
                      setShowCreateModal(false);
                      setEditingCoordinator(null);
                      resetForm();
                    }}
                  >
                    Cancel
                  </Button>
                  <Button 
                    fullWidth
                    onClick={editingCoordinator ? handleUpdate : handleCreate}
                    disabled={!formData.name || !formData.email}
                  >
                    {editingCoordinator ? 'Save Changes' : 'Create Coordinator'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
