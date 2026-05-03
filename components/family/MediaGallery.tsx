import React, { useState, useEffect, useCallback } from 'react';
import { 
  X, 
  ChevronLeft, 
  ChevronRight, 
  Download, 
  Heart, 
  MessageCircle, 
  Share2, 
  Play,
  Pause,
  Loader2,
  Camera,
  Calendar,
  User
} from 'lucide-react';
import { dbService } from '../../services/api';
import { storageService } from '../../services/storageService';
import { Button } from '../ui/Button';
import { AddToastFunction } from '../../types';

interface MediaItem {
  id: string;
  url: string;
  type: 'image' | 'video';
  thumbnailUrl?: string;
  caption?: string;
  uploadedAt: string;
  caregiverName: string;
  caregiverId: string;
  appointmentId: string;
  likes?: number;
  comments?: Comment[];
}

interface Comment {
  id: string;
  authorName: string;
  text: string;
  timestamp: string;
}

interface MediaGalleryProps {
  clientId: string;
  onShowToast: AddToastFunction;
}

interface GroupedMedia {
  date: string;
  items: MediaItem[];
}

/**
 * Media Gallery Component
 * Families can view photos/videos uploaded by caregivers
 * HIPAA-compliant with audit logging
 */
export const MediaGallery: React.FC<MediaGalleryProps> = ({
  clientId,
  onShowToast
}) => {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'timeline'>('grid');
  const [filterCaregiver, setFilterCaregiver] = useState<string>('all');

  useEffect(() => {
    const loadMedia = async () => {
      try {
        setLoading(true);
        const items = await dbService.getMediaForClient(clientId);
        setMedia(items);
      } catch (error) {
        console.error('Failed to load media:', error);
        onShowToast('Failed to load media updates', 'error');
      } finally {
        setLoading(false);
      }
    };

    loadMedia();

    // Subscribe to real-time updates
    const unsubscribe = dbService.subscribeToMediaUpdates(clientId, (newItem) => {
      setMedia(prev => [newItem, ...prev]);
      onShowToast(`New update from ${newItem.caregiverName}!`, 'info');
    });

    return () => unsubscribe();
  }, [clientId, onShowToast]);

  const groupMediaByDate = useCallback((): GroupedMedia[] => {
    const groups: Record<string, MediaItem[]> = {};
    
    const filtered = filterCaregiver === 'all' 
      ? media 
      : media.filter(m => m.caregiverId === filterCaregiver);

    for (const item of filtered) {
      const date = new Date(item.uploadedAt).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      
      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(item);
    }

    return Object.entries(groups)
      .map(([date, items]) => ({ date, items }))
      .sort((a, b) => new Date(b.items[0].uploadedAt).getTime() - new Date(a.items[0].uploadedAt).getTime());
  }, [media, filterCaregiver]);

  const uniqueCaregivers = Array.from(
    new Map(media.map(m => [m.caregiverId, m.caregiverName])).entries()
  );

  const handleDownload = async (item: MediaItem) => {
    try {
      await storageService.downloadMedia(item.url, `${item.type}_${item.id}`);
      onShowToast('Download started', 'success');
    } catch (error) {
      onShowToast('Download failed', 'error');
    }
  };

  const handleShare = async (item: MediaItem) => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Care Update',
          text: item.caption || `Update from ${item.caregiverName}`,
          url: window.location.href
        });
      } else {
        await navigator.clipboard.writeText(window.location.href);
        onShowToast('Link copied to clipboard', 'success');
      }
    } catch (error) {
      console.error('Share failed:', error);
    }
  };

  const handleLike = async (itemId: string) => {
    try {
      await dbService.likeMedia(itemId);
      setMedia(prev => prev.map(m => 
        m.id === itemId ? { ...m, likes: (m.likes || 0) + 1 } : m
      ));
    } catch (error) {
      console.error('Like failed:', error);
    }
  };

  const handleAddComment = async () => {
    if (!selectedItem || !commentText.trim()) return;

    try {
      const comment = await dbService.addComment({
        mediaId: selectedItem.id,
        text: commentText.trim(),
        timestamp: new Date().toISOString()
      });

      setMedia(prev => prev.map(m => 
        m.id === selectedItem.id 
          ? { ...m, comments: [...(m.comments || []), comment] }
          : m
      ));
      setCommentText('');
    } catch (error) {
      onShowToast('Failed to add comment', 'error');
    }
  };

  const navigateMedia = (direction: 'prev' | 'next') => {
    const flatMedia = groupMediaByDate().flatMap(g => g.items);
    const newIndex = direction === 'next' 
      ? Math.min(selectedIndex + 1, flatMedia.length - 1)
      : Math.max(selectedIndex - 1, 0);
    
    setSelectedIndex(newIndex);
    setSelectedItem(flatMedia[newIndex]);
    setIsPlaying(false);
  };

  const groupedMedia = groupMediaByDate();

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
      </div>
    );
  }

  if (media.length === 0) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-3xl p-12 text-center">
        <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Camera className="w-10 h-10 text-slate-400" />
        </div>
        <h3 className="text-xl font-bold text-slate-900 mb-2">No Updates Yet</h3>
        <p className="text-slate-500 max-w-sm mx-auto">
          Your caregivers will share photos and videos here during their shifts. You'll be notified when new updates are available.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Care Updates</h2>
          <p className="text-slate-500">Photos and videos from caregivers</p>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Caregiver Filter */}
          <select
            value={filterCaregiver}
            onChange={(e) => setFilterCaregiver(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-500"
          >
            <option value="all">All Caregivers</option>
            {uniqueCaregivers.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>

          {/* View Mode Toggle */}
          <div className="flex bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                viewMode === 'grid' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'
              }`}
            >
              Grid
            </button>
            <button
              onClick={() => setViewMode('timeline')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                viewMode === 'timeline' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'
              }`}
            >
              Timeline
            </button>
          </div>
        </div>
      </div>

      {/* Media Count */}
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Camera className="w-4 h-4" />
        <span>{media.length} update{media.length !== 1 ? 's' : ''}</span>
        {filterCaregiver !== 'all' && (
          <>
            <span>•</span>
            <span>Filtered by caregiver</span>
          </>
        )}
      </div>

      {/* Grid View */}
      {viewMode === 'grid' && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {groupedMedia.flatMap(group => group.items).map((item, index) => (
            <div
              key={item.id}
              onClick={() => {
                setSelectedItem(item);
                setSelectedIndex(index);
              }}
              className="group relative aspect-square bg-slate-100 rounded-2xl overflow-hidden cursor-pointer hover:shadow-lg transition-all"
            >
              {item.type === 'video' ? (
                <>
                  <img
                    src={item.thumbnailUrl || item.url}
                    alt="Video thumbnail"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                    <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center">
                      <Play className="w-6 h-6 text-slate-900 ml-1" />
                    </div>
                  </div>
                </>
              ) : (
                <img
                  src={item.url}
                  alt={item.caption || 'Care update'}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                />
              )}
              
              {/* Hover Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="absolute bottom-0 left-0 right-0 p-3">
                  <p className="text-white text-sm font-medium truncate">{item.caregiverName}</p>
                  <p className="text-white/70 text-xs">
                    {new Date(item.uploadedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>

              {/* Type Badge */}
              {item.type === 'video' && (
                <div className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded-full">
                  Video
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Timeline View */}
      {viewMode === 'timeline' && (
        <div className="space-y-8">
          {groupedMedia.map((group) => (
            <div key={group.date}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-primary-100 rounded-full flex items-center justify-center">
                  <Calendar className="w-5 h-5 text-primary-600" />
                </div>
                <h3 className="font-bold text-slate-900">{group.date}</h3>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 ml-5 pl-5 border-l-2 border-slate-200">
                {group.items.map((item, index) => (
                  <div
                    key={item.id}
                    onClick={() => {
                      setSelectedItem(item);
                      setSelectedIndex(index);
                    }}
                    className="group relative aspect-video bg-slate-100 rounded-xl overflow-hidden cursor-pointer hover:shadow-md transition-all"
                  >
                    {item.type === 'video' ? (
                      <>
                        <img
                          src={item.thumbnailUrl || item.url}
                          alt="Video thumbnail"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <div className="w-10 h-10 bg-white/90 rounded-full flex items-center justify-center">
                            <Play className="w-5 h-5 text-slate-900 ml-0.5" />
                          </div>
                        </div>
                      </>
                    ) : (
                      <img
                        src={item.url}
                        alt={item.caption || 'Care update'}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      />
                    )}
                    
                    <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
                      <p className="text-white text-xs font-medium">{item.caregiverName}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {selectedItem && (
        <div className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center animate-fade-in">
          {/* Close Button */}
          <button
            onClick={() => {
              setSelectedItem(null);
              setIsPlaying(false);
            }}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-10"
          >
            <X className="w-6 h-6 text-white" />
          </button>

          {/* Navigation */}
          <button
            onClick={() => navigateMedia('prev')}
            disabled={selectedIndex === 0}
            className="absolute left-4 p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-full transition-colors"
          >
            <ChevronLeft className="w-8 h-8 text-white" />
          </button>
          
          <button
            onClick={() => navigateMedia('next')}
            disabled={selectedIndex === groupedMedia.flatMap(g => g.items).length - 1}
            className="absolute right-4 p-2 bg-white/10 hover:bg-white/20 disabled:opacity-30 rounded-full transition-colors"
          >
            <ChevronRight className="w-8 h-8 text-white" />
          </button>

          {/* Content */}
          <div className="max-w-5xl max-h-[90vh] flex flex-col">
            {/* Media */}
            <div className="flex-1 flex items-center justify-center p-4">
              {selectedItem.type === 'video' ? (
                <div className="relative">
                  <video
                    src={selectedItem.url}
                    controls
                    className="max-h-[70vh] max-w-full rounded-lg"
                    poster={selectedItem.thumbnailUrl}
                  />
                </div>
              ) : (
                <img
                  src={selectedItem.url}
                  alt={selectedItem.caption || 'Care update'}
                  className="max-h-[70vh] max-w-full object-contain rounded-lg"
                />
              )}
            </div>

            {/* Info Panel */}
            <div className="bg-slate-900/80 backdrop-blur-sm p-4 rounded-t-2xl">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary-500 rounded-full flex items-center justify-center">
                    <User className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <p className="font-semibold text-white">{selectedItem.caregiverName}</p>
                    <p className="text-sm text-slate-400">
                      {new Date(selectedItem.uploadedAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleLike(selectedItem.id)}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
                  >
                    <Heart className={`w-5 h-5 ${selectedItem.likes ? 'text-red-500 fill-current' : 'text-white'}`} />
                  </button>
                  <button
                    onClick={() => handleDownload(selectedItem)}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
                  >
                    <Download className="w-5 h-5 text-white" />
                  </button>
                  <button
                    onClick={() => handleShare(selectedItem)}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
                  >
                    <Share2 className="w-5 h-5 text-white" />
                  </button>
                </div>
              </div>

              {/* Caption */}
              {selectedItem.caption && (
                <p className="text-white mb-4">{selectedItem.caption}</p>
              )}

              {/* Comments */}
              <div className="border-t border-slate-700 pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <MessageCircle className="w-4 h-4 text-slate-400" />
                  <span className="text-sm text-slate-400">
                    {selectedItem.comments?.length || 0} comments
                  </span>
                </div>
                
                {/* Comment List */}
                <div className="space-y-2 mb-3 max-h-32 overflow-y-auto">
                  {selectedItem.comments?.map(comment => (
                    <div key={comment.id} className="flex gap-2 text-sm">
                      <span className="font-semibold text-slate-300">{comment.authorName}:</span>
                      <span className="text-slate-400">{comment.text}</span>
                    </div>
                  ))}
                </div>

                {/* Add Comment */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Add a comment..."
                    className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:ring-2 focus:ring-primary-500"
                    onKeyPress={(e) => e.key === 'Enter' && handleAddComment()}
                  />
                  <Button
                    size="sm"
                    onClick={handleAddComment}
                    disabled={!commentText.trim()}
                  >
                    Post
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

export default MediaGallery;
