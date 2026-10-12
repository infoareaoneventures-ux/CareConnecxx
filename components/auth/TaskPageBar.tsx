import React from 'react';
import { SiteHeader } from '../landing/SiteHeader';

// The pre-login TASK pages (/start both roles, /login, account recovery) share
// the site's one header (founder, 2026-10-12: "header be available in the
// other pages"). The help phone that used to sit here moved to the Footer.
export const TaskPageBar: React.FC = () => <SiteHeader />;
