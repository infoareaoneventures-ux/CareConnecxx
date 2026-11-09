import React from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';

// Where a person lands after deleting their account (2026-11-09, fix plan Wave 2): the old flow left the
// page on "Deleting…" until it was reloaded, then showed the plain login page with no word that it worked.
const AccountDeletedPage: React.FC = () => (
  <main className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
    <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
      <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-4" aria-hidden="true" />
      <h1 className="text-xl font-bold text-slate-900 mb-2">Your account has been deleted</h1>
      <p className="text-sm text-slate-600 mb-6">
        Your membership is cancelled, your upcoming visits are cancelled and the people you worked with have been told. You've been signed out.
      </p>
      <Link to="/" className="inline-flex items-center justify-center rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800">
        Back to the home page
      </Link>
    </div>
  </main>
);

export default AccountDeletedPage;
