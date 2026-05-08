import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Activity, ArrowLeft, Clock, Tag, ArrowRight } from 'lucide-react';
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-600 mb-4">Article not found.</p>
          <Button onClick={() => navigate('/blog')}>Back to Blog</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white font-sans">
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

      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
          <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
            <div className="bg-primary-600 p-1.5 rounded-xl">
              <Activity className="text-white w-5 h-5" />
            </div>
            <span className="text-xl font-bold text-slate-900">CareConnex</span>
          </div>
          <Button size="sm" onClick={() => onNavigate('client-signup')}>Find Care</Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="mb-12">
          <p className="text-sm font-semibold text-primary-600 uppercase tracking-widest mb-3">Resources</p>
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">Senior Care Guides</h1>
          <p className="text-xl text-slate-500 max-w-2xl">
            Practical guidance for Bay Area families navigating in-home senior care — from hiring your first caregiver to managing advanced dementia at home.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {articles.map(article => (
            <Link
              key={article.slug}
              to={`/blog/${article.slug}`}
              className="block border border-slate-200 rounded-2xl overflow-hidden hover:border-primary-200 hover:shadow-md transition-all group"
            >
              <div className="p-7">
                <div className="flex items-center gap-3 mb-4">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-semibold">
                    <Tag className="w-3 h-3" />
                    {article.category}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-slate-400">
                    <Clock className="w-3 h-3" />
                    {article.readTime} min read
                  </span>
                </div>
                <h2 className="text-xl font-bold text-slate-900 mb-3 leading-snug group-hover:text-primary-700 transition-colors">
                  {article.title}
                </h2>
                <p className="text-slate-500 text-sm leading-relaxed line-clamp-3">
                  {article.intro}
                </p>
                <div className="mt-5 flex items-center gap-1.5 text-primary-600 text-sm font-semibold">
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
          author: { '@type': 'Organization', name: 'CareConnex' },
          publisher: {
            '@type': 'Organization',
            name: 'CareConnex',
            logo: { '@type': 'ImageObject', url: 'https://www.careconnex.com/icon-512.png' }
          },
          datePublished: article.publishDate,
          dateModified: article.publishDate,
          mainEntityOfPage: { '@type': 'WebPage', '@id': `https://www.careconnex.com/blog/${article.slug}` }
        }}
      />

      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-16">
          <div className="flex items-center gap-3">
            <Link
              to="/blog"
              className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 text-sm font-medium transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Blog
            </Link>
            <span className="text-slate-300">|</span>
            <div className="flex items-center space-x-2 cursor-pointer" onClick={() => onNavigate('landing')}>
              <div className="bg-primary-600 p-1.5 rounded-xl">
                <Activity className="text-white w-4 h-4" />
              </div>
              <span className="text-lg font-bold text-slate-900">CareConnex</span>
            </div>
          </div>
          <Button size="sm" onClick={() => onNavigate('client-signup')}>Find Care</Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        {/* Article header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-5">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-semibold">
              <Tag className="w-3 h-3" />
              {article.category}
            </span>
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <Clock className="w-3 h-3" />
              {article.readTime} min read
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 leading-tight mb-5">
            {article.title}
          </h1>
          <p className="text-lg text-slate-600 leading-relaxed border-l-4 border-primary-200 pl-5">
            {article.intro}
          </p>
        </div>

        {/* Article body */}
        <div className="prose prose-slate max-w-none">
          {article.sections.map((section, i) => (
            <section key={i} className="mb-10">
              <h2 className="text-xl font-bold text-slate-900 mb-4">{section.heading}</h2>
              <div className="text-slate-600 leading-relaxed space-y-4">
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
                                <strong className="text-slate-800">{boldMatch[1]}:</strong>{boldMatch[2] ? ` ${boldMatch[2]}` : ''}
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
        <div className="mt-12 bg-primary-50 border border-primary-100 rounded-2xl p-8 text-center">
          <h3 className="text-2xl font-bold text-slate-900 mb-3">{article.ctaHeading}</h3>
          <p className="text-slate-600 mb-6 max-w-lg mx-auto">{article.ctaBody}</p>
          <Button size="lg" onClick={() => onNavigate('client-signup')}>
            Get Started Free
          </Button>
        </div>

        {/* More articles */}
        <div className="mt-14">
          <h3 className="text-lg font-bold text-slate-900 mb-5">More resources</h3>
          <div className="space-y-3">
            {allArticles
              .filter(a => a.slug !== article.slug)
              .slice(0, 3)
              .map(a => (
                <Link
                  key={a.slug}
                  to={`/blog/${a.slug}`}
                  className="w-full text-left flex items-start gap-4 p-4 rounded-xl border border-slate-200 hover:border-primary-200 hover:bg-primary-50/30 transition-all group"
                >
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs font-medium mt-0.5 flex-shrink-0">
                    {a.category}
                  </span>
                  <span className="text-slate-700 group-hover:text-primary-700 font-medium text-sm leading-snug transition-colors">
                    {a.title}
                  </span>
                  <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-primary-400 flex-shrink-0 mt-0.5 ml-auto" />
                </Link>
              ))}
          </div>
        </div>
      </main>

      <Footer onNavigate={onNavigate} />
    </>
  );
};
