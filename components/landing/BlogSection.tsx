import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock, Tag } from 'lucide-react';
import { blogArticles } from '../../utils/blogData';

export const BlogSection: React.FC = () => {
  const featured = blogArticles.slice(0, 3);

  return (
    <section className="py-20 bg-paper-50 border-t hairline">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-end justify-between mb-12">
          <div>
            <h2 className="font-display text-3xl md:text-4xl font-semibold text-ink-900 tracking-[-0.02em]">Senior care guides</h2>
            <p className="text-ink-600 mt-3 max-w-xl">
              Expert articles to help Bay Area families navigate in-home care decisions.
            </p>
          </div>
          <Link
            to="/blog"
            className="hidden md:flex items-center gap-2 text-ink-600 hover:text-ink-900 font-medium text-sm transition-colors"
          >
            View all articles <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {featured.map(article => (
            <Link
              key={article.slug}
              to={`/blog/${article.slug}`}
              className="block bg-white rounded-2xl border border-slate-200 overflow-hidden hover:border-primary-200 hover:shadow-md transition-all group"
            >
              <div className="p-6">
                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-50 text-primary-700 text-xs font-semibold">
                    <Tag className="w-3 h-3" />
                    {article.category}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-slate-400">
                    <Clock className="w-3 h-3" />
                    {article.readTime} min
                  </span>
                </div>
                <h3 className="font-bold text-slate-900 leading-snug mb-3 group-hover:text-primary-700 transition-colors">
                  {article.title}
                </h3>
                <p className="text-sm text-slate-500 leading-relaxed line-clamp-2">{article.intro.slice(0, 120)}…</p>
                <div className="mt-4 flex items-center gap-1 text-primary-600 text-sm font-semibold">
                  Read <ArrowRight className="w-3.5 h-3.5" />
                </div>
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-8 text-center md:hidden">
          <Link
            to="/blog"
            className="inline-flex items-center gap-2 text-primary-600 font-semibold text-sm"
          >
            View all guides <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>
  );
};
