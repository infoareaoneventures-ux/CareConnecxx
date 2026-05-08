import { db } from '../lib/firebase';

export interface BlogPost {
  id?: string;
  slug: string;
  title: string;
  metaDescription: string;
  category: string;
  readTime: number;
  publishDate: string;
  status: 'draft' | 'published';
  intro: string;
  sections: { heading: string; body: string }[];
  ctaHeading: string;
  ctaBody: string;
  heroImageUrl?: string;
  authorName?: string;
  createdAt?: string;
  updatedAt?: string;
}

const COLLECTION = 'blog_posts';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

export const blogService = {
  async getAll(): Promise<BlogPost[]> {
    const snap = await db.collection(COLLECTION).orderBy('publishDate', 'desc').get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as BlogPost));
  },

  async getPublished(): Promise<BlogPost[]> {
    const snap = await db
      .collection(COLLECTION)
      .where('status', '==', 'published')
      .orderBy('publishDate', 'desc')
      .get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as BlogPost));
  },

  async getBySlug(slug: string): Promise<BlogPost | null> {
    const snap = await db
      .collection(COLLECTION)
      .where('slug', '==', slug)
      .where('status', '==', 'published')
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() } as BlogPost;
  },

  async create(post: Omit<BlogPost, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const now = new Date().toISOString();
    const slug = post.slug || slugify(post.title);
    const ref = await db.collection(COLLECTION).add({
      ...post,
      slug,
      createdAt: now,
      updatedAt: now,
    });
    return ref.id;
  },

  async update(id: string, updates: Partial<BlogPost>): Promise<void> {
    await db.collection(COLLECTION).doc(id).update({
      ...updates,
      updatedAt: new Date().toISOString(),
    });
  },

  async delete(id: string): Promise<void> {
    await db.collection(COLLECTION).doc(id).delete();
  },

  async toggleStatus(id: string, current: 'draft' | 'published'): Promise<void> {
    const next = current === 'published' ? 'draft' : 'published';
    await db.collection(COLLECTION).doc(id).update({
      status: next,
      updatedAt: new Date().toISOString(),
    });
  },

  slugify,
};
