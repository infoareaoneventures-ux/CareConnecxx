import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, Clock, DollarSign, CheckCircle, ChevronLeft, ChevronRight, Download, CreditCard, User, FileText } from 'lucide-react';
import { auth, db } from '../lib/firebase';
import firebase from 'firebase/compat/app';
import { ClientNavigation } from './client/ClientNavigation';

interface Visit {
  id: string;
  caregiverName: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number; // hours
  hourlyRate: number;
  totalPay: number;
  status: 'pending' | 'confirmed' | 'paid';
  tasksCompleted: string[];
}

interface WeekData {
  startDate: string;
  endDate: string;
  visits: Visit[];
  totalHours: number;
  totalPay: number;
}

export default function WeeklySummary() {
  const navigate = useNavigate();
  const [currentWeek, setCurrentWeek] = useState(new Date());
  const [weekData, setWeekData] = useState<WeekData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedVisit, setSelectedVisit] = useState<Visit | null>(null);

  useEffect(() => {
    fetchWeekData();
  }, [currentWeek]);

  const fetchWeekData = async () => {
    try {
      const fauth = auth;
      const fdb = db;
      if (!fauth || !fdb) {
        navigate('/login');
        return;
      }
      const user = fauth.currentUser;
      if (!user) {
        navigate('/login');
        return;
      }

      // Calculate week start (Sunday) and end (Saturday)
      const startOfWeek = new Date(currentWeek);
      startOfWeek.setDate(currentWeek.getDate() - currentWeek.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      endOfWeek.setHours(23, 59, 59, 999);

      const startStr = startOfWeek.toISOString().split('T')[0];
      const endStr = endOfWeek.toISOString().split('T')[0];

      // Query real appointments for the week
      const snap = await fdb.collection('appointments')
        .where('clientId', '==', user.uid)
        .where('status', 'in', ['completed', 'confirmed', 'pending_payment'])
        .get();

      const visits: Visit[] = snap.docs
        .map(doc => {
          const d = doc.data();
          return {
            id: doc.id,
            caregiverName: d.caregiverName || 'Caregiver',
            date: d.isoDate || d.date || '',
            startTime: d.time || d.startTime || '',
            endTime: d.endTime || '',
            duration: typeof d.duration === 'number' ? d.duration : 0,
            hourlyRate: d.cost && d.duration ? Math.round(d.cost / d.duration) : 0,
            totalPay: d.cost || 0,
            status: d.paymentStatus === 'paid' ? 'paid' : d.status === 'completed' ? 'confirmed' : 'pending',
            tasksCompleted: d.tasksCompleted || []
          } as Visit;
        })
        .filter(v => v.date >= startStr && v.date <= endStr);

      const totalHours = visits.reduce((sum, v) => sum + v.duration, 0);
      const totalPay = visits.reduce((sum, v) => sum + v.totalPay, 0);

      setWeekData({
        startDate: startStr,
        endDate: endStr,
        visits,
        totalHours,
        totalPay
      });
    } catch (error) {
      console.error('Error fetching week data:', error);
    } finally {
      setLoading(false);
    }
  };

  const navigateWeek = (direction: 'prev' | 'next') => {
    setCurrentWeek(prev => {
      const newDate = new Date(prev);
      if (direction === 'prev') {
        newDate.setDate(prev.getDate() - 7);
      } else {
        newDate.setDate(prev.getDate() + 7);
      }
      return newDate;
    });
  };

  const handleMarkAsPaid = async (visitId: string) => {
    try {
      const fdb = db;
      if (!fdb) return;
      // Update in Firestore
      await fdb.collection('appointments').doc(visitId).update({
        paymentStatus: 'paid',
        paidAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Update local state
      setWeekData(prev => {
        if (!prev) return null;
        return {
          ...prev,
          visits: prev.visits.map(v => 
            v.id === visitId ? { ...v, status: 'paid' } : v
          )
        };
      });
    } catch (error) {
      console.error('Error marking as paid:', error);
    }
  };

  const getStatusColor = (status: Visit['status']) => {
    switch (status) {
      case 'paid': return 'bg-green-100 text-green-700 border-green-200';
      case 'confirmed': return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'pending': return 'bg-accent-100 text-accent-700 border-accent-200';
      default: return 'bg-slate-100 text-slate-700';
    }
  };

  const formatDateRange = () => {
    if (!weekData) return '';
    const start = new Date(weekData.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const end = new Date(weekData.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${start} - ${end}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <ClientNavigation />
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-slate-900">Weekly Summary</h1>
          <p className="text-slate-500">Review and manage caregiver payments</p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Week Navigation */}
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => navigateWeek('prev')}
            className="p-2 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="text-center">
            <h2 className="text-xl font-bold text-slate-900">{formatDateRange()}</h2>
            <p className="text-sm text-slate-500">Pay Period</p>
          </div>
          <button
            onClick={() => navigateWeek('next')}
            className="p-2 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>

        {/* Summary Cards */}
        {weekData && (
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-5 h-5 text-primary-600" />
                <span className="text-sm text-slate-500">Total Hours</span>
              </div>
              <p className="text-2xl font-bold text-slate-900">{weekData.totalHours}</p>
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-5 h-5 text-primary-600" />
                <span className="text-sm text-slate-500">Visits</span>
              </div>
              <p className="text-2xl font-bold text-slate-900">{weekData.visits.length}</p>
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-5 h-5 text-primary-600" />
                <span className="text-sm text-slate-500">Total Pay</span>
              </div>
              <p className="text-2xl font-bold text-primary-600">${weekData.totalPay}</p>
            </div>
          </div>
        )}

        {/* Visits List */}
        <div className="space-y-4">
          <h3 className="text-lg font-bold text-slate-900">Visit Details</h3>
          
          {weekData?.visits.length === 0 ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-12 text-center">
              <Calendar className="w-12 h-12 mx-auto mb-4 text-slate-300" />
              <p className="text-slate-500">No visits this week</p>
            </div>
          ) : (
            weekData?.visits.map(visit => (
              <div
                key={visit.id}
                className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-primary-100 flex items-center justify-center">
                      <User className="w-6 h-6 text-primary-600" />
                    </div>
                    <div>
                      <h4 className="font-bold text-slate-900">{visit.caregiverName}</h4>
                      <p className="text-sm text-slate-500">
                        {new Date(visit.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-sm font-medium border ${getStatusColor(visit.status)}`}>
                    {visit.status.charAt(0).toUpperCase() + visit.status.slice(1)}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="p-3 bg-slate-50 rounded-xl">
                    <p className="text-xs text-slate-500 mb-1">Time</p>
                    <p className="font-medium text-slate-900">{visit.startTime} - {visit.endTime}</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-xl">
                    <p className="text-xs text-slate-500 mb-1">Duration</p>
                    <p className="font-medium text-slate-900">{visit.duration} hrs</p>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-xl">
                    <p className="text-xs text-slate-500 mb-1">Rate</p>
                    <p className="font-medium text-slate-900">${visit.hourlyRate}/hr</p>
                  </div>
                </div>

                <div className="flex items-center justify-between p-4 bg-accent-50 rounded-xl mb-4">
                  <div>
                    <p className="text-sm text-slate-500">Total Pay</p>
                    <p className="text-xl font-bold text-primary-600">${visit.totalPay}</p>
                  </div>
                  {visit.status === 'confirmed' && (
                    <button
                      onClick={() => handleMarkAsPaid(visit.id)}
                      className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors flex items-center gap-2"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Mark as Paid
                    </button>
                  )}
                  {visit.status === 'paid' && (
                    <span className="flex items-center gap-1 text-green-600 text-sm font-medium">
                      <CheckCircle className="w-4 h-4" />
                      Payment Confirmed
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {visit.tasksCompleted.map((task, idx) => (
                    <span key={idx} className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded">
                      {task}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Actions */}
        <div className="mt-8 flex gap-4">
          <button className="flex-1 py-3 border border-slate-200 rounded-xl font-medium text-slate-700 hover:bg-slate-50 transition-colors flex items-center justify-center gap-2">
            <Download className="w-5 h-5" />
            Download Summary
          </button>
          <button 
            onClick={() => navigate('/client/payments')}
            className="flex-1 py-3 bg-primary-600 text-white rounded-xl font-medium hover:bg-primary-700 transition-colors flex items-center justify-center gap-2"
          >
            <CreditCard className="w-5 h-5" />
            View All Payments
          </button>
        </div>
      </main>
    </div>
  );
}
