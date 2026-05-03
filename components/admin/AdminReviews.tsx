import React, { useState, useEffect } from 'react';
import { Star, Search, Trash2, RefreshCw, MessageSquare, ChevronDown, AlertCircle } from 'lucide-react';
import { adminService } from '../../services/api';
import { Review } from '../../types';

type ToastState = { msg: string; type: 'success' | 'error' } | null;

const formatCategoryLabel = (key: string) =>
  key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();

export const AdminReviews: React.FC = () => {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [ratingFilter, setRatingFilter] = useState<number | 'all'>('all');
  const [confirmDelete, setConfirmDelete] = useState<Review | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await adminService.getAllReviews();
      setReviews(data);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await adminService.deleteReview(confirmDelete.id);
      setReviews(prev => prev.filter(r => r.id !== confirmDelete.id));
      setConfirmDelete(null);
      showToast('Review deleted', 'success');
    } catch {
      showToast('Failed to delete review', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const filtered = reviews.filter(r => {
    const matchSearch = !search ||
      r.clientName?.toLowerCase().includes(search.toLowerCase()) ||
      r.caregiverName?.toLowerCase().includes(search.toLowerCase()) ||
      r.comment?.toLowerCase().includes(search.toLowerCase());
    const matchRating = ratingFilter === 'all' || Math.floor(r.rating) === ratingFilter;
    return matchSearch && matchRating;
  });

  const avgRating = reviews.length
    ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
    : '—';

  const starFill = (rating: number, i: number) => i <= Math.round(rating);
  const starColor = (rating: number) => {
    if (rating >= 4) return 'text-yellow-400 fill-yellow-400';
    if (rating >= 3) return 'text-orange-400 fill-orange-400';
    return 'text-red-400 fill-red-400';
  };
  const starEmpty = 'text-slate-200 fill-slate-200';

  const Stars = ({ rating }: { rating: number }) => (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} className={`w-3.5 h-3.5 ${starFill(rating, i) ? starColor(rating) : starEmpty}`} />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Stats */}
      <div className="grid grid-cols-7 gap-3 p-6 border-b border-slate-100">
        <div className="col-span-1 bg-slate-50 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-slate-900">{reviews.length}</p>
          <p className="text-xs text-slate-500 mt-0.5">Total</p>
        </div>
        <div className="col-span-1 bg-slate-50 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-yellow-500">{avgRating}</p>
          <p className="text-xs text-slate-500 mt-0.5">Average</p>
        </div>
        {[5, 4, 3, 2, 1].map(r => (
          <button
            key={r}
            onClick={() => setRatingFilter(ratingFilter === r ? 'all' : r)}
            className={`col-span-1 rounded-xl p-4 text-center border transition-colors ${ratingFilter === r ? 'border-primary-300 bg-primary-50' : 'bg-slate-50 border-transparent hover:border-slate-200'}`}
          >
            <p className="text-3xl font-bold text-slate-900">{reviews.filter(rv => Math.floor(rv.rating) === r).length}</p>
            <p className="text-xs text-slate-500 mt-0.5 flex items-center justify-center gap-0.5">
              <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />{r}
            </p>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by client, caregiver, or comment…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div className="relative">
          <select
            value={ratingFilter}
            onChange={e => setRatingFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="appearance-none pl-3 pr-8 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
          >
            <option value="all">All Ratings</option>
            {[5, 4, 3, 2, 1].map(r => <option key={r} value={r}>{r} Star</option>)}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        </div>
        <span className="text-xs text-slate-400 whitespace-nowrap">{filtered.length} review{filtered.length !== 1 ? 's' : ''}</span>
        <button onClick={load} className="p-2 rounded-lg hover:bg-slate-50 text-slate-500 border border-slate-200 transition-colors"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400 text-sm">Loading reviews…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-slate-400">
            <MessageSquare className="w-12 h-12 mb-3" />
            <p className="font-medium">No reviews found</p>
            <p className="text-sm mt-1">Try adjusting your search or rating filter</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(r => (
              <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-5 hover:shadow-sm transition-shadow">
                {/* Inline delete confirm */}
                {confirmDelete?.id === r.id ? (
                  <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
                    <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-red-800">Delete this review?</p>
                      <p className="text-xs text-red-600 mt-0.5">By {r.clientName} · {r.rating.toFixed(1)} stars. This cannot be undone.</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-white transition-colors">Cancel</button>
                      <button onClick={handleDelete} disabled={deleting} className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50 transition-colors">
                        {deleting ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2 flex-wrap">
                        <Stars rating={r.rating} />
                        <span className="font-semibold text-slate-900 text-sm">{r.rating.toFixed(1)}</span>
                        <span className="text-xs text-slate-400">
                          {r.date ? new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm mb-2">
                        <span className="font-medium text-slate-800">{r.clientName || 'Client'}</span>
                        <span className="text-slate-400">→</span>
                        <span className="font-medium text-primary-700">{r.caregiverName || 'Caregiver'}</span>
                      </div>
                      {r.comment && <p className="text-sm text-slate-600 leading-relaxed">{r.comment}</p>}
                      {r.categories && Object.keys(r.categories).length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {Object.entries(r.categories).map(([cat, val]) => (
                            <span key={cat} className="text-xs text-slate-500 bg-slate-50 px-2.5 py-0.5 rounded-full">
                              {formatCategoryLabel(cat)}: <span className="font-medium text-slate-700">{val}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {r.response && (
                        <div className="mt-3 pl-4 border-l-2 border-primary-200">
                          <p className="text-xs text-primary-600 font-medium mb-1">Caregiver Response</p>
                          <p className="text-sm text-slate-600 leading-relaxed">{r.response.text}</p>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setConfirmDelete(r)}
                      className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                      title="Delete review"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>{toast.msg}</div>
      )}
    </div>
  );
};
