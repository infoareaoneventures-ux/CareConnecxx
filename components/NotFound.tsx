import React from 'react';
import { ArrowLeft, Home, Search } from 'lucide-react';
import { ViewType } from '../types';
import { Button } from './ui/Button';
import { SEO } from './SEO';

interface NotFoundProps {
  onNavigate: (view: ViewType) => void;
}

export const NotFound: React.FC<NotFoundProps> = ({ onNavigate }) => {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <SEO
        title="Page Not Found"
        description="Sorry, the page you're looking for doesn't exist. Return to CareConnex home or search for caregivers."
        noindex={true}
      />
      
      <div className="max-w-md w-full text-center">
        <div className="mb-8">
          <div className="text-9xl font-bold text-slate-200 mb-4">404</div>
          <h1 className="text-3xl font-bold text-slate-900 mb-4">
            Page Not Found
          </h1>
          <p className="text-slate-600 text-lg mb-8">
            Sorry, we couldn't find the page you're looking for. It might have been moved or deleted.
          </p>
        </div>

        <div className="space-y-4">
          <Button
            onClick={() => onNavigate('landing')}
            fullWidth
            size="lg"
            className="flex items-center justify-center"
          >
            <Home className="w-5 h-5 mr-2" />
            Go Back Home
          </Button>

          <Button
            variant="secondary"
            onClick={() => onNavigate('client-signup')}
            fullWidth
            size="lg"
            className="flex items-center justify-center"
          >
            <Search className="w-5 h-5 mr-2" />
            Find a Caregiver
          </Button>

          <button
            onClick={() => window.history.back()}
            className="inline-flex items-center text-slate-600 hover:text-primary-600 transition-colors mt-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Go Back
          </button>
        </div>

        <div className="mt-12 pt-8 border-t border-slate-200">
          <p className="text-sm text-slate-500">
            Need help?{' '}
            <button
              onClick={() => onNavigate('landing')}
              className="text-primary-600 hover:text-primary-700 font-medium"
            >
              Go to Dashboard
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};
