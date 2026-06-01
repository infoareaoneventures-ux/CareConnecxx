import React, { useEffect, useState } from 'react';
import { Zap, Calendar, Loader2 } from 'lucide-react';
import { db } from '../../lib/firebase';

interface PayoutRecord {
    id: string;
    amount: number;
    grossAmount?: number;
    fee: number;
    type: 'instant' | 'standard';
    status: string;
    createdAt: string;
    arrivalDate?: string | null;
}

interface PayoutHistoryProps {
    uid: string;
}

export const PayoutHistory: React.FC<PayoutHistoryProps> = ({ uid }) => {
    const [payouts, setPayouts] = useState<PayoutRecord[] | null>(null);

    useEffect(() => {
        if (!uid || !db) return;
        const unsub = db.collection('caregivers').doc(uid).collection('payouts')
            .orderBy('createdAt', 'desc')
            .limit(25)
            .onSnapshot(
                snap => {
                    setPayouts(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
                },
                err => {
                    console.error('PayoutHistory subscription failed:', err);
                    setPayouts([]);
                },
            );
        return () => unsub();
    }, [uid]);

    if (payouts === null) {
        return (
            <div className="bg-white border border-slate-200 rounded-2xl p-5 flex items-center justify-center text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading payouts...
            </div>
        );
    }

    if (payouts.length === 0) {
        return (
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
                <p className="font-bold text-slate-900 mb-1">Payout history</p>
                <p className="text-sm text-slate-500">No payouts yet. Completed appointments will appear here once you cash out.</p>
            </div>
        );
    }

    return (
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <p className="font-bold text-slate-900 mb-3">Payout history</p>
            <ul className="divide-y divide-slate-100">
                {payouts.map(p => {
                    const created = p.createdAt ? new Date(p.createdAt) : null;
                    const arrival = p.arrivalDate ? new Date(p.arrivalDate) : null;
                    const Icon = p.type === 'instant' ? Zap : Calendar;
                    const iconClass = p.type === 'instant' ? 'text-blue-600 bg-blue-100' : 'text-blue-600 bg-blue-100';
                    return (
                        <li key={p.id} className="py-3 flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${iconClass}`}>
                                <Icon className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-slate-900 capitalize">
                                    {p.type} payout
                                    <span className="ml-2 text-xs font-normal text-slate-500">{p.status}</span>
                                </p>
                                <p className="text-xs text-slate-500">
                                    {created ? created.toLocaleDateString() : '—'}
                                    {arrival && ` · arrives ${arrival.toLocaleDateString()}`}
                                    {p.fee > 0 && ` · fee $${p.fee.toFixed(2)}`}
                                </p>
                            </div>
                            <div className="text-right">
                                <p className="text-sm font-bold text-slate-900">${p.amount.toFixed(2)}</p>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};
