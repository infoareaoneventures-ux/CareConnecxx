import React, { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, query, where, orderBy, onSnapshot, updateDoc, doc, addDoc } from 'firebase/firestore';
import { SupportTicket } from '../../types';

interface TicketManagerProps {
    onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

type TicketFilter = 'all' | 'open' | 'in-progress' | 'resolved';

export const TicketManager: React.FC<TicketManagerProps> = ({ onShowToast }) => {
    const [tickets, setTickets] = useState<SupportTicket[]>([]);
    const [filter, setFilter] = useState<TicketFilter>('all');
    const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const ticketsRef = collection(db, 'support_tickets');
        let q = query(ticketsRef, orderBy('createdAt', 'desc'));

        if (filter !== 'all') {
            q = query(ticketsRef, where('status', '==', filter), orderBy('createdAt', 'desc'));
        }

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const ticketData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            })) as SupportTicket[];
            setTickets(ticketData);
            setLoading(false);
        }, (error) => {
            console.error('Error loading tickets:', error);
            onShowToast('Failed to load support tickets', 'error');
            setLoading(false);
        });

        return () => unsubscribe();
    }, [filter, onShowToast]);

    const getPriorityColor = (priority?: string) => {
        switch (priority) {
            case 'urgent': return 'bg-red-100 text-red-800';
            case 'high': return 'bg-accent-100 text-accent-800';
            case 'medium': return 'bg-yellow-100 text-yellow-800';
            default: return 'bg-gray-100 text-gray-800';
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'resolved': return 'bg-green-100 text-green-800';
            case 'in-progress': return 'bg-blue-100 text-blue-800';
            default: return 'bg-gray-100 text-gray-800';
        }
    };

    const updateTicketStatus = async (ticketId: string, newStatus: string) => {
        try {
            await updateDoc(doc(db, 'support_tickets', ticketId), {
                status: newStatus,
                updatedAt: new Date().toISOString()
            });
            onShowToast('Ticket status updated', 'success');
        } catch (error) {
            console.error('Error updating ticket:', error);
            onShowToast('Failed to update ticket status', 'error');
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Filter Tabs */}
            <div className="flex space-x-2 border-b border-gray-200">
                {(['all', 'open', 'in-progress', 'resolved'] as TicketFilter[]).map((f) => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`px-4 py-2 font-medium text-sm capitalize transition-colors ${filter === f
                                ? 'border-b-2 border-blue-600 text-blue-600'
                                : 'text-gray-600 hover:text-gray-900'
                            }`}
                    >
                        {f.replace('-', ' ')}
                        <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-gray-100">
                            {f === 'all' ? tickets.length : tickets.filter(t => t.status === f).length}
                        </span>
                    </button>
                ))}
            </div>

            {/* Tickets List */}
            <div className="space-y-3">
                {tickets.length === 0 ? (
                    <div className="text-center py-12 text-gray-500">
                        <p className="text-lg">No tickets found</p>
                        <p className="text-sm mt-2">All {filter} tickets will appear here</p>
                    </div>
                ) : (
                    tickets.map((ticket) => (
                        <div
                            key={ticket.id}
                            onClick={() => setSelectedTicket(ticket)}
                            className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-md transition-shadow cursor-pointer"
                        >
                            <div className="flex items-start justify-between">
                                <div className="flex-1">
                                    <div className="flex items-center space-x-2 mb-2">
                                        <span className={`px-2 py-1 text-xs font-medium rounded ${getStatusColor(ticket.status)}`}>
                                            {ticket.status}
                                        </span>
                                        {ticket.priority && (
                                            <span className={`px-2 py-1 text-xs font-medium rounded ${getPriorityColor(ticket.priority)}`}>
                                                {ticket.priority}
                                            </span>
                                        )}
                                        <span className="px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800">
                                            {ticket.type}
                                        </span>
                                    </div>
                                    <h3 className="font-semibold text-gray-900 mb-1">
                                        {ticket.subject || 'No Subject'}
                                    </h3>
                                    <p className="text-sm text-gray-600 line-clamp-2 mb-2">
                                        {ticket.description}
                                    </p>
                                    <div className="flex items-center space-x-4 text-xs text-gray-500">
                                        <span>User: {ticket.userId}</span>
                                        <span>•</span>
                                        <span>{new Date(ticket.createdAt).toLocaleDateString()}</span>
                                    </div>
                                </div>
                                <div className="ml-4">
                                    <select
                                        value={ticket.status}
                                        onChange={(e) => {
                                            e.stopPropagation();
                                            updateTicketStatus(ticket.id!, e.target.value);
                                        }}
                                        className="text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        <option value="open">Open</option>
                                        <option value="in-progress">In Progress</option>
                                        <option value="resolved">Resolved</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Ticket Detail Modal */}
            {selectedTicket && (
                <TicketDetailModal
                    ticket={selectedTicket}
                    onClose={() => setSelectedTicket(null)}
                    onShowToast={onShowToast}
                />
            )}
        </div>
    );
};

// Ticket Detail Modal Component
interface TicketDetailModalProps {
    ticket: SupportTicket;
    onClose: () => void;
    onShowToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const TicketDetailModal: React.FC<TicketDetailModalProps> = ({ ticket, onClose, onShowToast }) => {
    const [adminResponse, setAdminResponse] = useState('');
    const [sending, setSending] = useState(false);

    const handleSendResponse = async () => {
        if (!adminResponse.trim()) {
            onShowToast('Please enter a response', 'error');
            return;
        }

        setSending(true);
        try {
            // Add response to ticket's responses subcollection
            await addDoc(collection(db, 'support_tickets', ticket.id!, 'responses'), {
                message: adminResponse,
                isAdmin: true,
                createdAt: new Date().toISOString(),
                adminName: 'Support Team'
            });

            // Update ticket status to in-progress if it was open
            if (ticket.status === 'open') {
                await updateDoc(doc(db, 'support_tickets', ticket.id!), {
                    status: 'in-progress',
                    updatedAt: new Date().toISOString()
                });
            }

            setAdminResponse('');
            onShowToast('Response sent successfully', 'success');
        } catch (error) {
            console.error('Error sending response:', error);
            onShowToast('Failed to send response', 'error');
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="p-6 border-b border-gray-200">
                    <div className="flex items-start justify-between">
                        <div>
                            <h2 className="text-2xl font-bold text-gray-900 mb-2">
                                {ticket.subject || 'Support Ticket'}
                            </h2>
                            <div className="flex items-center space-x-2">
                                <span className={`px-2 py-1 text-xs font-medium rounded ${ticket.status === 'resolved' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
                                    {ticket.status}
                                </span>
                                <span className="px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800">
                                    {ticket.type}
                                </span>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="text-gray-400 hover:text-gray-600 transition-colors"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Original Message */}
                    <div>
                        <h3 className="font-semibold text-gray-900 mb-2">Original Message</h3>
                        <div className="bg-gray-50 rounded-lg p-4">
                            <p className="text-gray-700 whitespace-pre-wrap">{ticket.description}</p>
                            <div className="mt-3 pt-3 border-t border-gray-200 text-sm text-gray-500">
                                <p>From: {ticket.userId}</p>
                                <p>Date: {new Date(ticket.createdAt).toLocaleString()}</p>
                            </div>
                        </div>
                    </div>

                    {/* Admin Response Form */}
                    <div>
                        <h3 className="font-semibold text-gray-900 mb-2">Admin Response</h3>
                        <textarea
                            value={adminResponse}
                            onChange={(e) => setAdminResponse(e.target.value)}
                            placeholder="Type your response to the user..."
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                            rows={4}
                        />
                        <button
                            onClick={handleSendResponse}
                            disabled={sending || !adminResponse.trim()}
                            className="mt-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {sending ? 'Sending...' : 'Send Response'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
