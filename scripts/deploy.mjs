/**
 * Cross-platform deploy wrapper for `npm run deploy`.
 *
 * Builds the frontend, then runs `firebase deploy`. Sets
 * FUNCTIONS_DISCOVERY_TIMEOUT so the functions deploy doesn't silently fail at
 * Firebase's default 10s discovery window — our functions take ~4s to load
 * locally and tip past 10s in Firebase's slower sandbox, which aborts the
 * deploy before any upload (leaving function updates undeployed).
 */
import { execSync } from 'node:child_process';

process.env.FUNCTIONS_DISCOVERY_TIMEOUT =
  process.env.FUNCTIONS_DISCOVERY_TIMEOUT || '120';

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: process.env });

run('npm run build');
run('firebase deploy');
