import React from 'react';
import { ArrowLeft, Home, Search } from 'lucide-react';
import { ViewType } from '../types';
import { Button } from './ui/Button';
import { SEO } from './SEO';
import { useCareConnex } from '../context/CareConnexContext';

interface NotFoundProps {
  onNavigate: (view: ViewType) => void;
}

export const NotFound: React.FC<NotFoundProps> = ({ onNavigate }) => {
  const { currentUser } = useCareConnex();
  // Where a signed-in visitor's dashboard is; a visitor who isn't signed in gets the home page instead.
  const dashboardPath =
    currentUser?.userType === 'client' ? '/client/dashboard'
    : currentUser?.userType === 'admin' ? '/admin'
    : currentUser ? '/care-provider/dashboard'
    : null;
  const signedIn = dashboardPath !== null;
  return (
    <div className="min-h-screen bg-paper-50 flex items-center justify-center px-4">
      <SEO
        title="Page Not Found"
        description="Sorry, the page you're looking for doesn't exist. Return to Evia home or search for care providers."
        noindex={true}
      />
      
      <div className="max-w-md w-full text-center">
        <div className="mb-8">
          <div className="text-9xl font-display font-semibold text-ink-400 mb-4">404</div>
          <h1 className="text-3xl font-display font-semibold text-ink-900 tracking-[-0.02em] mb-4">
            Page Not Found
          </h1>
          <p className="text-ink-600 text-lg mb-8">
            Sorry, we couldn't find the page you're looking for. It might have been moved or deleted.
          </p>
        </div>

        <div className="space-y-4">
          <Button
            onClick={() => (dashboardPath ? window.location.assign(dashboardPath) : onNavigate('landing'))}
            fullWidth
            size="lg"
            className="flex items-center justify-center"
          >
            <Home className="w-5 h-5 mr-2" />
            {signedIn ? 'Go to my dashboard' : 'Go to the home page'}
          </Button>

          {!signedIn && (
          <Button
            variant="secondary"
            onClick={() => onNavigate('client-signup')}
            fullWidth
            size="lg"
            className="flex items-center justify-center"
          >
            <Search className="w-5 h-5 mr-2" />
            Find a care provider
          </Button>
          )}

          <button
            onClick={() => window.history.back()}
            className="inline-flex items-center min-h-[44px] text-ink-600 hover:text-ink-900 font-medium transition-colors mt-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Go Back
          </button>
        </div>

      </div>
    </div>
  );
};
