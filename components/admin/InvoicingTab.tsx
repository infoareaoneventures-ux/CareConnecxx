import React, { useState, useEffect } from 'react';
import { useCareConnex } from '../../context/CareConnexContext';
import { db, functions } from '../../lib/firebase';
import { Invoice } from '../../types';
import { Plus, Eye, Edit, Trash2, Send, Download, CheckCircle, XCircle } from 'lucide-react';

export const InvoicingTab = () => {
    const { addToast, currentUser } = useCareConnex();
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [clients, setClients] = useState<any[]>([]);
    const [caregivers, setCaregivers] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [view, setView] = useState<'list' | 'create' | 'detail'>('list');
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

    // Form state
    const [formData, setFormData] = useState({
        clientId: '',
        caregiverId: '',
        carePeriodStart: '',
        carePeriodEnd: '',
        dueDate: '',
        notes: '',
    });
    
    const [lineItems, setLineItems] = useState([
        { date: '', hours: 0, rate: 0, tasks: '', notes: '' }
    ]);

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        setLoading(true);
        try {
            const invoicesSnapshot = await db!.collection('invoices').orderBy('createdAt', 'desc').get();
            const invList = invoicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Invoice[];
            setInvoices(invList);

            // Fetch all users and filter client-side to debug
            const clientsSnapshot = await db!.collection('users').get();
            const allUsers = clientsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            console.log('All users fetched:', allUsers);
            const clientUsers = allUsers.filter((u: any) => u.role === 'client' || u.userType === 'client');
            console.log('Filtered clients:', clientUsers);
            setClients(clientUsers);

            const caregiversSnapshot = await db!.collection('caregivers').get();
            setCaregivers(caregiversSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        } catch (error) {
            console.error('Error fetching data', error);
        }
        setLoading(false);
    };

    const calculateTotals = () => {
        const validItems = lineItems.filter(item => item.hours > 0 && item.rate > 0);
        const subtotal = validItems.reduce((acc, item) => acc + (item.hours * item.rate), 0);
        const taxes = subtotal * 0.05;
        const fees = subtotal * 0.02;
        return { subtotal, taxes, fees, total: subtotal + taxes + fees };
    };

    const handleCreateInvoice = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!functions) {
            addToast('Firebase Functions not initialized. Please refresh.', 'error');
            return;
        }
        setLoading(true);
        try {
            const createInvoiceFn = functions.httpsCallable('createInvoice');
            
            const payload = {
                clientId: formData.clientId,
                caregiverId: formData.caregiverId,
                carePeriod: { start: formData.carePeriodStart, end: formData.carePeriodEnd },
                dueDate: formData.dueDate,
                notes: formData.notes,
                lineItems: lineItems.map(item => ({
                    ...item,
                    tasks: item.tasks.split(',').map(t => t.trim()).filter(Boolean)
                }))
            };

            await createInvoiceFn(payload);
            setView('list');
            fetchData();
        } catch (error) {
            console.error('Error creating invoice', error);
            addToast('Failed to create invoice. Please try again.', 'error');
        }
        setLoading(false);
    };

    const handleDelete = async (id: string) => {
        if (!currentUser || currentUser.userType !== 'admin') {
            addToast('Unauthorized: Admin access required', 'error');
            return;
        }
        if (!confirm('Are you sure you want to delete this invoice?')) return;
        try {
            await db!.collection('invoices').doc(id).delete();
            fetchData();
            addToast('Invoice deleted', 'success');
        } catch (error) {
            console.error(error);
            addToast('Failed to delete invoice', 'error');
        }
    };

    const handleResend = async (id: string) => {
        if (!functions) {
            addToast('Firebase Functions not initialized. Please refresh.', 'error');
            return;
        }
        try {
            const sendEmailFn = functions.httpsCallable('sendInvoiceEmail');
            await sendEmailFn({ invoiceId: id });
            addToast('Invoice email sent!', 'success');
        } catch (error) {
            console.error(error);
            addToast('Failed to send email. Please try again.', 'error');
        }
    };

    return (
        <div className="space-y-6">
            {view === 'list' && (
                <div>
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-xl font-bold text-slate-900">Invoices</h3>
                        <button 
                            onClick={() => setView('create')}
                            className="bg-primary-600 text-white px-4 py-2 rounded-lg flex items-center hover:bg-primary-700"
                        >
                            <Plus className="w-4 h-4 mr-2" />
                            Create Invoice
                        </button>
                    </div>

                    <div className="overflow-x-auto bg-white rounded-xl shadow-sm border border-slate-200">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm">
                                    <th className="p-4 font-semibold">Invoice #</th>
                                    <th className="p-4 font-semibold">Client</th>
                                    <th className="p-4 font-semibold">Caregiver</th>
                                    <th className="p-4 font-semibold">Amount</th>
                                    <th className="p-4 font-semibold">Status</th>
                                    <th className="p-4 font-semibold">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {invoices.map(inv => (
                                    <tr key={inv.id} className="border-b border-slate-100 hover:bg-slate-50">
                                        <td className="p-4 font-medium">{inv.invoiceNumber}</td>
                                        <td className="p-4">{inv.clientName}</td>
                                        <td className="p-4">{inv.caregiverName}</td>
                                        <td className="p-4 font-bold">${inv.total?.toFixed(2)}</td>
                                        <td className="p-4">
                                            <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                                                inv.status === 'approved' ? 'bg-green-100 text-green-700' :
                                                inv.status === 'pending' ? 'bg-accent-100 text-accent-700' :
                                                inv.status === 'paid' ? 'bg-blue-100 text-blue-700' :
                                                'bg-red-100 text-red-700'
                                            }`}>
                                                {inv.status.toUpperCase()}
                                            </span>
                                        </td>
                                        <td className="p-4 flex space-x-2">
                                            <button onClick={() => { setSelectedInvoice(inv); setView('detail'); }} className="p-1 text-slate-400 hover:text-primary-600">
                                                <Eye className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => handleResend(inv.id)} className="p-1 text-slate-400 hover:text-blue-600" title="Resend Email">
                                                <Send className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => handleDelete(inv.id)} className="p-1 text-slate-400 hover:text-red-600">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {invoices.length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="p-8 text-center text-slate-500">No invoices found.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {view === 'create' && (
                <div className="bg-white p-6 rounded-xl border border-slate-200">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-xl font-bold">Create New Invoice</h3>
                        <button onClick={() => setView('list')} className="text-slate-500 hover:text-slate-700">Cancel</button>
                    </div>

                    <form onSubmit={handleCreateInvoice} className="space-y-6">
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium mb-1">Client</label>
                                <select required value={formData.clientId} onChange={e => setFormData({...formData, clientId: e.target.value})} className="w-full p-2 border rounded-lg">
                                    <option value="">Select Client</option>
                                    {clients.map(c => <option key={c.id} value={c.id}>{c.name || c.displayName || (c.firstName ? c.firstName + ' ' + c.lastName : 'Unknown Client')}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1">Caregiver</label>
                                <select required value={formData.caregiverId} onChange={e => setFormData({...formData, caregiverId: e.target.value})} className="w-full p-2 border rounded-lg">
                                    <option value="">Select Caregiver</option>
                                    {caregivers.map(c => <option key={c.id} value={c.id}>{c.name || c.displayName || (c.firstName ? c.firstName + ' ' + c.lastName : 'Unknown Caregiver')}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1">Care Period Start</label>
                                <input type="date" required value={formData.carePeriodStart} onChange={e => setFormData({...formData, carePeriodStart: e.target.value})} className="w-full p-2 border rounded-lg" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1">Care Period End</label>
                                <input type="date" required value={formData.carePeriodEnd} onChange={e => setFormData({...formData, carePeriodEnd: e.target.value})} className="w-full p-2 border rounded-lg" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1">Due Date</label>
                                <input type="date" required value={formData.dueDate} onChange={e => setFormData({...formData, dueDate: e.target.value})} className="w-full p-2 border rounded-lg" />
                            </div>
                        </div>

                        <div>
                            <h4 className="font-bold mb-2">Line Items</h4>
                            {lineItems.map((item, idx) => (
                                <div key={idx} className="flex gap-2 items-start mb-2 border p-3 rounded-lg bg-slate-50">
                                    <input type="date" required value={item.date} onChange={e => { const newItems = [...lineItems]; newItems[idx].date = e.target.value; setLineItems(newItems); }} className="p-2 border rounded w-32" />
                                    <input type="number" required placeholder="Hours" value={item.hours} onChange={e => { const newItems = [...lineItems]; newItems[idx].hours = Number(e.target.value); setLineItems(newItems); }} className="p-2 border rounded w-24" />
                                    <input type="number" required placeholder="Rate" value={item.rate} onChange={e => { const newItems = [...lineItems]; newItems[idx].rate = Number(e.target.value); setLineItems(newItems); }} className="p-2 border rounded w-24" />
                                    <input type="text" placeholder="Tasks (comma separated)" value={item.tasks} onChange={e => { const newItems = [...lineItems]; newItems[idx].tasks = e.target.value; setLineItems(newItems); }} className="p-2 border rounded flex-1" />
                                    <button type="button" onClick={() => setLineItems(lineItems.filter((_, i) => i !== idx))} className="p-2 text-red-500 hover:bg-red-50 rounded">X</button>
                                </div>
                            ))}
                            <button type="button" onClick={() => setLineItems([...lineItems, { date: '', hours: 0, rate: 0, tasks: '', notes: '' }])} className="text-primary-600 font-bold text-sm">+ Add Line Item</button>
                        </div>

                        <div className="bg-slate-100 p-4 rounded-lg flex justify-between items-center">
                            <div>
                                <p className="text-sm">Subtotal: ${calculateTotals().subtotal.toFixed(2)}</p>
                                <p className="text-sm">Taxes (5%): ${calculateTotals().taxes.toFixed(2)}</p>
                                <p className="text-sm">Fees (2%): ${calculateTotals().fees.toFixed(2)}</p>
                            </div>
                            <div className="text-2xl font-bold">Total: ${calculateTotals().total.toFixed(2)}</div>
                        </div>

                        <button disabled={loading} type="submit" className="w-full bg-primary-600 text-white font-bold py-3 rounded-lg hover:bg-primary-700 disabled:opacity-50">
                            {loading ? 'Creating...' : 'Create & Send Invoice'}
                        </button>
                    </form>
                </div>
            )}

            {view === 'detail' && selectedInvoice && (
                <div className="bg-white p-6 rounded-xl border border-slate-200">
                    <button onClick={() => setView('list')} className="mb-4 text-slate-500 hover:text-slate-700">&larr; Back to Invoices</button>
                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <h2 className="text-2xl font-bold">Invoice {selectedInvoice.invoiceNumber}</h2>
                            <p className="text-slate-500">Status: <strong className="uppercase">{selectedInvoice.status}</strong></p>
                        </div>
                        {selectedInvoice.pdfUrl && (
                            <a href={selectedInvoice.pdfUrl} target="_blank" rel="noreferrer" className="bg-slate-100 p-2 rounded flex items-center hover:bg-slate-200">
                                <Download className="w-4 h-4 mr-2" /> View PDF
                            </a>
                        )}
                    </div>
                    <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
                        <div>
                            <p><strong>Client:</strong> {selectedInvoice.clientName}</p>
                            <p><strong>Caregiver:</strong> {selectedInvoice.caregiverName}</p>
                            <p><strong>Care Period:</strong> {selectedInvoice.carePeriod.start} to {selectedInvoice.carePeriod.end}</p>
                        </div>
                        <div>
                            <p><strong>Date Issued:</strong> {new Date(selectedInvoice.createdAt).toLocaleDateString()}</p>
                            <p><strong>Due Date:</strong> {new Date(selectedInvoice.dueDate).toLocaleDateString()}</p>
                        </div>
                    </div>
                    <div className="border-t pt-4">
                        <h4 className="font-bold mb-2">Line Items</h4>
                        <table className="w-full mb-4">
                            <thead>
                                <tr className="border-b text-left">
                                    <th className="py-2">Date</th>
                                    <th className="py-2">Tasks</th>
                                    <th className="py-2 text-right">Hours</th>
                                    <th className="py-2 text-right">Rate</th>
                                    <th className="py-2 text-right">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                {selectedInvoice.lineItems.map((item, i) => (
                                    <tr key={i} className="border-b">
                                        <td className="py-2">{item.date}</td>
                                        <td className="py-2 text-slate-500 text-xs">{item.tasks?.join(', ')}</td>
                                        <td className="py-2 text-right">{item.hours}</td>
                                        <td className="py-2 text-right">${item.rate}/hr</td>
                                        <td className="py-2 text-right">${(item.hours * item.rate).toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <div className="flex justify-end text-right space-y-1">
                            <div>
                                <p>Subtotal: ${selectedInvoice.subtotal.toFixed(2)}</p>
                                <p>Taxes: ${selectedInvoice.taxes.toFixed(2)}</p>
                                <p>Fees: ${selectedInvoice.fees.toFixed(2)}</p>
                                <p className="text-xl font-bold mt-2">Total: ${selectedInvoice.total.toFixed(2)}</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
