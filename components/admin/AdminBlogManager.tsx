import React, { useState, useEffect, useRef } from 'react';
import {
  Plus, Edit2, Trash2, Eye, EyeOff, ArrowLeft,
  Clock, Tag, Upload, X, Save, FileText, Globe,
  ChevronDown, ChevronUp, Image as ImageIcon,
} from 'lucide-react';
import { blogService, BlogPost } from '../../services/blogService';
import firebase from '../../lib/firebase';

const CATEGORIES = [
  'Senior Care', 'Caregiver Tips', 'Dementia Care', 'Safety', 'Respite Care',
  'Hiring', 'Finance', 'Health', 'Family',
];

const emptyPost = (): Omit<BlogPost, 'id' | 'createdAt' | 'updatedAt'> => ({
  title: '',
  slug: '',
  metaDescription: '',
  category: 'Senior Care',
  readTime: 5,
  publishDate: new Date().toISOString().split('T')[0],
  status: 'draft',
  intro: '',
  sections: [{ heading: '', body: '' }],
  ctaHeading: '',
  ctaBody: '',
  heroImageUrl: '',
  authorName: 'Evia Team',
});

type View = 'list' | 'form';

async function uploadHeroImage(file: File, slug: string): Promise<string> {
  // @ts-ignore — firebase compat
  const storage = firebase.storage ? firebase.storage() : null;
  if (!storage) throw new Error('Storage not configured');
  const ext = file.name.split('.').pop();
  const ref = storage.ref(`blog/hero/${slug}-${Date.now()}.${ext}`);
  await ref.put(file);
  return await ref.getDownloadURL();
}

export const AdminBlogManager: React.FC = () => {
  const [view, setView] = useState<View>('list');
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingPost, setEditingPost] = useState<BlogPost | null>(null);
  const [form, setForm] = useState(emptyPost());
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [heroFile, setHeroFile] = useState<File | null>(null);
  const [heroPreview, setHeroPreview] = useState<string>('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadPosts();
  }, []);

  async function loadPosts() {
    setLoading(true);
    try {
      const all = await blogService.getAll();
      setPosts(all);
    } catch {
      showToast('Failed to load posts', 'error');
    } finally {
      setLoading(false);
    }
  }

  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function openNew() {
    setEditingPost(null);
    setForm(emptyPost());
    setHeroFile(null);
    setHeroPreview('');
    setView('form');
  }

  function openEdit(post: BlogPost) {
    setEditingPost(post);
    const { id, createdAt, updatedAt, ...rest } = post;
    setForm(rest);
    setHeroFile(null);
    setHeroPreview(post.heroImageUrl || '');
    setView('form');
  }

  function handleField<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'title' && !editingPost) {
        next.slug = blogService.slugify(value as string);
      }
      return next;
    });
  }

  function handleSection(index: number, field: 'heading' | 'body', value: string) {
    setForm(prev => {
      const sections = [...prev.sections];
      sections[index] = { ...sections[index], [field]: value };
      return { ...prev, sections };
    });
  }

  function addSection() {
    setForm(prev => ({ ...prev, sections: [...prev.sections, { heading: '', body: '' }] }));
  }

  function removeSection(index: number) {
    setForm(prev => ({ ...prev, sections: prev.sections.filter((_, i) => i !== index) }));
  }

  function moveSection(index: number, dir: -1 | 1) {
    setForm(prev => {
      const sections = [...prev.sections];
      const target = index + dir;
      if (target < 0 || target >= sections.length) return prev;
      [sections[index], sections[target]] = [sections[target], sections[index]];
      return { ...prev, sections };
    });
  }

  function handleHeroFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setHeroFile(file);
    setHeroPreview(URL.createObjectURL(file));
  }

  async function handleSave() {
    if (!form.title.trim()) { showToast('Title is required', 'error'); return; }
    if (!form.intro.trim()) { showToast('Intro is required', 'error'); return; }

    setSaving(true);
    try {
      let heroImageUrl = form.heroImageUrl || '';

      if (heroFile) {
        setUploadingImage(true);
        try {
          heroImageUrl = await uploadHeroImage(heroFile, form.slug || blogService.slugify(form.title));
        } finally {
          setUploadingImage(false);
        }
      }

      const data = { ...form, heroImageUrl };

      if (editingPost?.id) {
        await blogService.update(editingPost.id, data);
        showToast('Post updated');
      } else {
        await blogService.create(data);
        showToast('Post created');
      }

      await loadPosts();
      setView('list');
    } catch (err) {
      showToast('Failed to save post', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus(post: BlogPost) {
    if (!post.id) return;
    try {
      await blogService.toggleStatus(post.id, post.status);
      setPosts(prev => prev.map(p => p.id === post.id
        ? { ...p, status: p.status === 'published' ? 'draft' : 'published' }
        : p
      ));
      showToast(post.status === 'published' ? 'Moved to draft' : 'Published');
    } catch {
      showToast('Failed to update status', 'error');
    }
  }

  async function handleDelete(id: string) {
    try {
      await blogService.delete(id);
      setPosts(prev => prev.filter(p => p.id !== id));
      setDeleteConfirm(null);
      showToast('Post deleted');
    } catch {
      showToast('Failed to delete post', 'error');
    }
  }

  const published = posts.filter(p => p.status === 'published');
  const drafts = posts.filter(p => p.status === 'draft');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shrink-0">
        {view === 'list' ? (
          <>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Blog Manager</h2>
              <p className="text-xs text-slate-400 mt-0.5">{published.length} published &middot; {drafts.length} draft</p>
            </div>
            <button
              onClick={openNew}
              className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" /> New Post
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setView('list')}
              className="flex items-center gap-2 text-slate-600 hover:text-slate-900 text-sm font-medium transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              All Posts
            </button>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${form.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                {form.status === 'published' ? 'Published' : 'Draft'}
              </span>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                <Save className="w-4 h-4" />
                {saving ? (uploadingImage ? 'Uploading image…' : 'Saving…') : 'Save Post'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {view === 'list' ? (
          <div className="p-6 space-y-6">
            {loading ? (
              <div className="text-center py-20 text-slate-400">Loading posts…</div>
            ) : posts.length === 0 ? (
              <div className="text-center py-20">
                <FileText className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                <p className="text-slate-400 text-sm mb-4">No blog posts yet</p>
                <button
                  onClick={openNew}
                  className="inline-flex items-center gap-2 bg-primary-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-primary-700"
                >
                  <Plus className="w-4 h-4" /> Write your first post
                </button>
              </div>
            ) : (
              <>
                {drafts.length > 0 && (
                  <section>
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Drafts ({drafts.length})</h3>
                    <PostList posts={drafts} onEdit={openEdit} onToggle={handleToggleStatus} onDelete={setDeleteConfirm} />
                  </section>
                )}
                {published.length > 0 && (
                  <section>
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Published ({published.length})</h3>
                    <PostList posts={published} onEdit={openEdit} onToggle={handleToggleStatus} onDelete={setDeleteConfirm} />
                  </section>
                )}
              </>
            )}
          </div>
        ) : (
          <PostForm
            form={form}
            heroPreview={heroPreview}
            fileRef={fileRef}
            onField={handleField}
            onSection={handleSection}
            onAddSection={addSection}
            onRemoveSection={removeSection}
            onMoveSection={moveSection}
            onHeroFileChange={handleHeroFileChange}
            onClearHero={() => { setHeroFile(null); setHeroPreview(''); handleField('heroImageUrl', ''); }}
          />
        )}
      </div>

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="font-bold text-slate-900 mb-2">Delete post?</h3>
            <p className="text-sm text-slate-500 mb-5">This action cannot be undone.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 ${toast.type === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
};

const PostList: React.FC<{
  posts: BlogPost[];
  onEdit: (p: BlogPost) => void;
  onToggle: (p: BlogPost) => void;
  onDelete: (id: string) => void;
}> = ({ posts, onEdit, onToggle, onDelete }) => (
  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
    {posts.map((post, i) => (
      <div
        key={post.id}
        className={`flex items-center gap-4 px-5 py-4 ${i !== posts.length - 1 ? 'border-b border-slate-100' : ''} hover:bg-slate-50/50 transition-colors`}
      >
        {post.heroImageUrl ? (
          <img src={post.heroImageUrl} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0 border border-slate-100" />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
            <ImageIcon className="w-5 h-5 text-slate-300" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-900 text-sm truncate">{post.title}</p>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <Tag className="w-3 h-3" />{post.category}
            </span>
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <Clock className="w-3 h-3" />{post.readTime} min
            </span>
            <span className="text-xs text-slate-400">{post.publishDate}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => onToggle(post)}
            title={post.status === 'published' ? 'Move to draft' : 'Publish'}
            className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors ${post.status === 'published' ? 'bg-green-50 text-green-700 hover:bg-green-100' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
          >
            {post.status === 'published' ? <><Globe className="w-3.5 h-3.5" /> Published</> : <><EyeOff className="w-3.5 h-3.5" /> Draft</>}
          </button>
          <button
            onClick={() => onEdit(post)}
            className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
            title="Edit"
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(post.id!)}
            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    ))}
  </div>
);

const PostForm: React.FC<{
  form: Omit<BlogPost, 'id' | 'createdAt' | 'updatedAt'>;
  heroPreview: string;
  fileRef: React.RefObject<HTMLInputElement>;
  onField: <K extends keyof Omit<BlogPost, 'id' | 'createdAt' | 'updatedAt'>>(key: K, value: any) => void;
  onSection: (index: number, field: 'heading' | 'body', value: string) => void;
  onAddSection: () => void;
  onRemoveSection: (i: number) => void;
  onMoveSection: (i: number, dir: -1 | 1) => void;
  onHeroFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClearHero: () => void;
}> = ({ form, heroPreview, fileRef, onField, onSection, onAddSection, onRemoveSection, onMoveSection, onHeroFileChange, onClearHero }) => (
  <div className="max-w-3xl mx-auto p-6 space-y-8">

    {/* Status toggle */}
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 block">Post Status</label>
      <div className="flex gap-3">
        {(['draft', 'published'] as const).map(s => (
          <button
            key={s}
            onClick={() => onField('status', s)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${form.status === s
              ? s === 'published' ? 'bg-green-50 border-green-300 text-green-700' : 'bg-amber-50 border-amber-300 text-amber-700'
              : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
            }`}
          >
            {s === 'published' ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
    </div>

    {/* Hero image */}
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 block">Hero Image</label>
      {heroPreview ? (
        <div className="relative">
          <img src={heroPreview} alt="Hero preview" className="w-full h-48 object-cover rounded-lg border border-slate-200" />
          <button
            onClick={onClearHero}
            className="absolute top-2 right-2 bg-white border border-slate-200 rounded-lg p-1 shadow-sm hover:bg-red-50 hover:border-red-200 transition-colors"
          >
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2.5 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-primary-400 hover:text-primary-600 hover:bg-primary-50/30 w-full justify-center transition-colors"
          >
            <Upload className="w-4 h-4" /> Upload image
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onHeroFileChange} />
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-slate-100" />
            <span className="text-xs text-slate-400">or</span>
            <div className="flex-1 h-px bg-slate-100" />
          </div>
          <input
            type="url"
            value={form.heroImageUrl || ''}
            onChange={e => onField('heroImageUrl', e.target.value)}
            placeholder="Paste image URL…"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      )}
    </div>

    {/* Core metadata */}
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">Post Details</label>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Title *</label>
        <input
          value={form.title}
          onChange={e => onField('title', e.target.value)}
          placeholder="e.g. 10 Signs Your Parent Needs In-Home Care"
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          URL Slug
          <span className="ml-2 text-xs text-slate-400 font-normal">Auto-generated from title</span>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 shrink-0">/blog/</span>
          <input
            value={form.slug}
            onChange={e => onField('slug', e.target.value)}
            placeholder="your-post-slug"
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 font-mono"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Meta Description</label>
        <textarea
          value={form.metaDescription}
          onChange={e => onField('metaDescription', e.target.value)}
          rows={2}
          maxLength={160}
          placeholder="Brief description for search engines (max 160 chars)…"
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
        />
        <p className="text-xs text-slate-400 text-right mt-1">{form.metaDescription.length}/160</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
          <select
            value={form.category}
            onChange={e => onField('category', e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
          >
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Read Time (min)</label>
          <input
            type="number"
            min={1}
            max={60}
            value={form.readTime}
            onChange={e => onField('readTime', Number(e.target.value))}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Publish Date</label>
          <input
            type="date"
            value={form.publishDate}
            onChange={e => onField('publishDate', e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Author Name</label>
          <input
            value={form.authorName || ''}
            onChange={e => onField('authorName', e.target.value)}
            placeholder="Evia Team"
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>
    </div>

    {/* Intro */}
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <label className="block text-sm font-medium text-slate-700 mb-1">Introduction *</label>
      <p className="text-xs text-slate-400 mb-3">Opening paragraph displayed below the title and used in article previews.</p>
      <textarea
        value={form.intro}
        onChange={e => onField('intro', e.target.value)}
        rows={4}
        placeholder="Start with the core insight or question this article answers…"
        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y"
      />
    </div>

    {/* Sections */}
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Article Sections</label>
        <button
          onClick={onAddSection}
          className="flex items-center gap-1.5 text-xs font-semibold text-primary-600 hover:text-primary-700 bg-primary-50 hover:bg-primary-100 px-3 py-1.5 rounded-lg transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Add Section
        </button>
      </div>

      {form.sections.map((sec, i) => (
        <div key={i} className="border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Section {i + 1}</span>
            <div className="flex items-center gap-1">
              <button disabled={i === 0} onClick={() => onMoveSection(i, -1)} className="p-1 text-slate-300 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                <ChevronUp className="w-4 h-4" />
              </button>
              <button disabled={i === form.sections.length - 1} onClick={() => onMoveSection(i, 1)} className="p-1 text-slate-300 hover:text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                <ChevronDown className="w-4 h-4" />
              </button>
              {form.sections.length > 1 && (
                <button onClick={() => onRemoveSection(i)} className="p-1 text-slate-300 hover:text-red-500 transition-colors ml-1">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          <input
            value={sec.heading}
            onChange={e => onSection(i, 'heading', e.target.value)}
            placeholder={`Section heading…`}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <textarea
            value={sec.body}
            onChange={e => onSection(i, 'body', e.target.value)}
            rows={5}
            placeholder="Section body text. Separate paragraphs with a blank line. Use **bold text** for emphasis."
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y"
          />
        </div>
      ))}
    </div>

    {/* CTA */}
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
      <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">Call to Action</label>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">CTA Heading</label>
        <input
          value={form.ctaHeading}
          onChange={e => onField('ctaHeading', e.target.value)}
          placeholder="e.g. Find the Right Caregiver Today"
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">CTA Body</label>
        <textarea
          value={form.ctaBody}
          onChange={e => onField('ctaBody', e.target.value)}
          rows={2}
          placeholder="Support text under the CTA heading…"
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
        />
      </div>
    </div>

    {/* Bottom save button */}
    <div className="pb-8" />
  </div>
);
