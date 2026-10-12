import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

// The caregiver pages moved from /caregiver/… to /care-provider/… (founder's
// "care provider" wording, 2026-10-12). Every old address keeps working — links
// Evia already texted, bookmarks, bell routes written before the move — by
// landing on the same sub-path under the new prefix, query string and hash
// intact. Mounted on `/caregiver` and `/caregiver/*` in App.tsx.
export const LEGACY_CAREGIVER_PREFIX = '/caregiver';
export const CARE_PROVIDER_PREFIX = '/care-provider';

export function legacyCaregiverPathToCareProvider(pathname: string, search = '', hash = ''): string {
  const rest = pathname.startsWith(LEGACY_CAREGIVER_PREFIX)
    ? pathname.slice(LEGACY_CAREGIVER_PREFIX.length)
    : pathname;
  return `${CARE_PROVIDER_PREFIX}${rest}${search}${hash}`;
}

export const LegacyCaregiverRedirect: React.FC = () => {
  const location = useLocation();
  return <Navigate to={legacyCaregiverPathToCareProvider(location.pathname, location.search, location.hash)} replace />;
};

export default LegacyCaregiverRedirect;

// The family's two provider addresses moved the same day (founder: "web
// addresses change too"): /client/find-caregivers → /client/find-care-providers
// and /client/caregiver/:caregiverId → /client/care-provider/:caregiverId (the
// `caregiverId` param name is code and stays). Same promise as above — the
// review_prompt bell (`?review=1`), Evia's texted profile links and bookmarks
// keep working, query string and hash intact. Mounted on `/client/find-caregivers`
// and `/client/caregiver/*` in App.tsx.
export const LEGACY_CLIENT_FIND_PATH = '/client/find-caregivers';
export const CLIENT_FIND_PATH = '/client/find-care-providers';
export const LEGACY_CLIENT_PROFILE_PREFIX = '/client/caregiver';
export const CLIENT_PROFILE_PREFIX = '/client/care-provider';

export function legacyClientPathToCareProvider(pathname: string, search = '', hash = ''): string {
  let next = pathname;
  if (pathname === LEGACY_CLIENT_FIND_PATH || pathname === `${LEGACY_CLIENT_FIND_PATH}/`) {
    next = CLIENT_FIND_PATH;
  } else if (pathname === LEGACY_CLIENT_PROFILE_PREFIX || pathname.startsWith(`${LEGACY_CLIENT_PROFILE_PREFIX}/`)) {
    next = `${CLIENT_PROFILE_PREFIX}${pathname.slice(LEGACY_CLIENT_PROFILE_PREFIX.length)}`;
  }
  return `${next}${search}${hash}`;
}

export const LegacyClientCaregiverRedirect: React.FC = () => {
  const location = useLocation();
  return <Navigate to={legacyClientPathToCareProvider(location.pathname, location.search, location.hash)} replace />;
};
