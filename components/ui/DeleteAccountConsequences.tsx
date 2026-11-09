import React from 'react';

// What deleting an account actually does, said plainly before the person confirms (2026-11-09, fix plan
// Wave 2: the window never mentioned the membership, upcoming visits or unpaid hours). Matches
// functions/src/accountDeletion.ts + accountDeletionTies.ts — change them together.
export const DeleteAccountConsequences: React.FC<{ role: 'client' | 'caregiver' }> = ({ role }) => (
  <ul className="text-sm text-slate-600 space-y-1.5 list-disc pl-5" data-testid="delete-consequences">
    <li>Your membership is cancelled. Memberships are non-refundable, so any time left on it is lost.</li>
    {role === 'caregiver' ? (
      <>
        <li>Your upcoming visits are cancelled and each family is told.</li>
        <li>Your profile is removed and your job applications are withdrawn.</li>
        <li>If you have hours that haven't been paid yet, contact support before you delete.</li>
      </>
    ) : (
      <>
        <li>Your upcoming visits are cancelled and each care provider is told.</li>
        <li>Your open job posts are taken down.</li>
        <li>If any visit hours are waiting for your approval, approve them first or contact support.</li>
      </>
    )}
    <li>Your conversations are closed: the other person can still read them but can't send new messages.</li>
  </ul>
);
