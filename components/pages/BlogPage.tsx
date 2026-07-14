import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Clock, Tag, ArrowRight } from 'lucide-react';
import { BloomMark } from '../ui/BloomMark';
import { ViewType } from '../../types';
import { SEO } from '../SEO';
import { Footer } from '../landing/Footer';
import { blogArticles, getBlogArticle, BlogArticle } from '../../utils/blogData';
import { blogService, BlogPost } from '../../services/blogService';
import { Button } from '../ui/Button';

interface BlogPageProps {
  onNavigate: (view: ViewType) => void;
}

function firestorePostToArticle(post: BlogPost): BlogArticle {
  return {
    slug: post.slug,
    title: post.title,
    metaDescription: post.metaDescription,
    category: post.category,
    readTime: post.readTime,
    publishDate: post.publishDate,
    intro: post.intro,
    sections: post.sections,
    ctaHeading: post.ctaHeading,
    ctaBody: post.ctaBody,
    heroImageUrl: post.heroImageUrl,
    authorName: post.authorName,
  };
}

export const BlogPage: React.FC<BlogPageProps> = ({ onNavigate }) => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [firestorePosts, setFirestorePosts] = useState<BlogPost[]>([]);

  useEffect(() => {
    blogService.getPublished().then(setFirestorePosts).catch(() => {});
  }, []);

  const staticSlugs = new Set(blogArticles.map(a => a.slug));
  const firestoreArticles = firestorePosts
    .filter(p => !staticSlugs.has(p.slug))
    .map(firestorePostToArticle);
  const allArticles = [...blogArticles, ...firestoreArticles].sort(
    (a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime()
  );

  const article = slug
    ? (getBlogArticle(slug) ?? firestoreArticles.find(a => a.slug === slug) ?? null)
    : null;

  if (slug && !article) {
    return (
      <div className="min-h-screen bg-paper-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-ink-600 mb-4">Article not found.</p>
          <Button onClick={() => navigate('/blog')}>Back to Blog</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper-50 font-sans">
      {article ? (
        <ArticleView article={article} allArticles={allArticles} onNavigate={onNavigate} />
      ) : (
        <BlogIndex articles={allArticles} onNavigate={onNavigate} />
      )}
    </div>
  );
};

const BlogIndex: React.FC<{ articles: BlogArticle[]; onNavigate: (view: ViewType) => void }> = ({ articles, onNavigate }) => {
  const navigate = useNavigate();

  return (
    <>
      <SEO
        title="Senior Care Resources & Guides"
        description="Expert articles on senior care costs, dementia care, hiring caregivers, and respite care in the Bay Area. Free guides for Santa Clara County families."
        keywords="senior care guide, dementia care Bay Area, in-home care San Jose, respite care Santa Clara County"
      />

      <header className="sticky top-0 z-50 bg-paper-50/95 backdrop-blur-sm border-b hairline">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
          <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
            <BloomMark className="text-ink-900 w-5 h-5" />
            <span className="font-display text-xl font-semibold text-ink-900">Evia</span>
          </div>
          <Button size="sm" onClick={() => onNavigate('client-signup')}>Find Care</Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="mb-12">
          <p className="text-sm font-semibold text-ink-400 uppercase tracking-widest mb-3">Resources</p>
          <h1 className="font-display text-4xl md:text-5xl font-semibold text-ink-900 tracking-[-0.02em] mb-4">Senior Care Guides</h1>
          <p className="text-xl text-ink-600 max-w-2xl">
            Practical guidance for Bay Area families navigating in-home senior care — from hiring your first caregiver to managing advanced dementia at home.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {articles.map(article => (
            <Link
              key={article.slug}
              to={`/blog/${article.slug}`}
              className="block bg-white border hairline rounded-2xl overflow-hidden hover:shadow-md transition-all group"
            >
              <div className="p-7">
                <div className="flex items-center gap-3 mb-4">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-paper-100 border hairline text-ink-600 text-xs font-semibold">
                    <Tag className="w-3 h-3" />
                    {article.category}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-ink-400">
                    <Clock className="w-3 h-3" />
                    {article.readTime} min read
                  </span>
                </div>
                <h2 className="font-display text-xl font-semibold text-ink-900 mb-3 leading-snug transition-colors">
                  {article.title}
                </h2>
                <p className="text-ink-600 text-sm leading-relaxed line-clamp-3">
                  {article.intro}
                </p>
                <div className="mt-5 flex items-center gap-1.5 text-ink-600 group-hover:text-ink-900 text-sm font-medium transition-colors">
                  Read article <ArrowRight className="w-4 h-4" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </main>

      <Footer onNavigate={onNavigate} />
    </>
  );
};

const ArticleView: React.FC<{ article: BlogArticle; allArticles: BlogArticle[]; onNavigate: (view: ViewType) => void }> = ({ article, allArticles, onNavigate }) => {
  const navigate = useNavigate();

  return (
    <>
      <SEO
        title={article.title}
        description={article.metaDescription}
        schema={{
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: article.title,
          description: article.metaDescription,
          author: { '@type': 'Organization', name: 'Evia' },
          publisher: {
            '@type': 'Organization',
            name: 'Evia',
            logo: { '@type': 'ImageObject', url: 'https://www.eviacares.com/icon-512.png' }
          },
          datePublished: article.publishDate,
          dateModified: article.publishDate,
          mainEntityOfPage: { '@type': 'WebPage', '@id': `https://www.eviacares.com/blog/${article.slug}` }
        }}
      />

      <header className="sticky top-0 z-50 bg-paper-50/95 backdrop-blur-sm border-b hairline">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
          <div className="flex items-center gap-3">
            <Link
              to="/blog"
              className="flex items-center gap-1.5 text-ink-600 hover:text-ink-900 text-sm font-medium transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Blog
            </Link>
            <span className="text-ink-400">|</span>
            <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
              <BloomMark className="text-ink-900 w-4 h-4" />
              <span className="font-display text-lg font-semibold text-ink-900">Evia</span>
            </div>
          </div>
          <Button size="sm" onClick={() => onNavigate('client-signup')}>Find Care</Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {/* Article header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-5">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-paper-100 border hairline text-ink-600 text-xs font-semibold">
              <Tag className="w-3 h-3" />
              {article.category}
            </span>
            <span className="flex items-center gap-1 text-xs text-ink-400">
              <Clock className="w-3 h-3" />
              {article.readTime} min read
            </span>
          </div>
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-ink-900 tracking-[-0.02em] leading-tight mb-5">
            {article.title}
          </h1>
          <p className="text-lg text-ink-600 leading-relaxed border-l-2 hairline pl-5">
            {article.intro}
          </p>
        </div>

        {/* Article body */}
        <div className="prose prose-slate max-w-none">
          {article.sections.map((section, i) => (
            <section key={i} className="mb-10">
              <h2 className="font-display text-xl font-semibold text-ink-900 tracking-[-0.02em] mb-4">{section.heading}</h2>
              <div className="text-ink-600 leading-relaxed space-y-4">
                {section.body.split('\n\n').map((para, j) => {
                  if (para.startsWith('**') && para.includes(':**')) {
                    const parts = para.split('\n');
                    return (
                      <div key={j} className="space-y-2">
                        {parts.map((line, k) => {
                          const boldMatch = line.match(/^\*\*(.+?)\*\*:?\s*(.*)/);
                          if (boldMatch) {
                            return (
                              <p key={k}>
                                <strong className="text-ink-900">{boldMatch[1]}:</strong>{boldMatch[2] ? ` ${boldMatch[2]}` : ''}
                              </p>
                            );
                          }
                          return line ? <p key={k}>{line}</p> : null;
                        })}
                      </div>
                    );
                  }
                  return <p key={j}>{para}</p>;
                })}
              </div>
            </section>
          ))}
        </div>

        {/* CTA box */}
        <div className="mt-12 bg-white border hairline rounded-3xl p-8 text-center shadow-sm">
          <h3 className="font-display text-2xl font-semibold text-ink-900 tracking-[-0.02em] mb-3">{article.ctaHeading}</h3>
          <p className="text-ink-600 mb-6 max-w-lg mx-auto">{article.ctaBody}</p>
          <Button size="lg" onClick={() => onNavigate('client-signup')}>
            Get Started Free
          </Button>
        </div>

        {/* More articles */}
        <div className="mt-14">
          <h3 className="font-display text-lg font-semibold text-ink-900 mb-5">More resources</h3>
          <div className="space-y-3">
            {allArticles
              .filter(a => a.slug !== article.slug)
              .slice(0, 3)
              .map(a => (
                <Link
                  key={a.slug}
                  to={`/blog/${a.slug}`}
                  className="w-full text-left flex items-start gap-4 p-4 rounded-xl bg-white border hairline hover:shadow-sm transition-all group"
                >
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-paper-100 border hairline text-ink-600 text-xs font-medium mt-0.5 flex-shrink-0">
                    {a.category}
                  </span>
                  <span className="text-ink-600 group-hover:text-ink-900 font-medium text-sm leading-snug transition-colors">
                    {a.title}
                  </span>
                  <ArrowRight className="w-4 h-4 text-ink-400 group-hover:text-ink-900 flex-shrink-0 mt-0.5 ml-auto transition-colors" />
                </Link>
              ))}
          </div>
        </div>
      </main>

      <Footer onNavigate={onNavigate} />
    </>
  );
};
