import React, { useState } from 'react';
import { Copy, Check, Share2 } from 'lucide-react';

interface GetRecommendationsSidebarProps {
  caregiverUid: string;
}

export const GetRecommendationsSidebar: React.FC<GetRecommendationsSidebarProps> = ({ caregiverUid }) => {
  const [copied, setCopied] = useState(false);
  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/caregiver/${caregiverUid}`
    : `/caregiver/${caregiverUid}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignored */
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5">
      <p className="font-bold text-slate-900 mb-1">Get Recommendations</p>
      <p className="text-xs text-slate-500 mb-3">
        Build up your profile by sending the link below to families who know your work.
      </p>
      <div className="flex items-stretch rounded-lg bg-slate-50 border border-slate-200 overflow-hidden">
        <input
          readOnly
          value={shareUrl}
          className="flex-1 text-xs text-slate-700 bg-transparent px-2 py-2 outline-none truncate"
        />
        <button
          onClick={copy}
          className="px-3 text-slate-500 hover:text-slate-800 border-l border-slate-200 bg-white flex items-center gap-1 text-xs font-semibold"
          title="Copy link"
        >
          {copied ? <Check className="w-4 h-4 text-primary-600" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <a
        href={shareUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-semibold"
      >
        <Share2 className="w-3.5 h-3.5" /> Preview your public profile
      </a>
    </div>
  );
};
