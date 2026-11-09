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
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

process.env.FUNCTIONS_DISCOVERY_TIMEOUT =
  process.env.FUNCTIONS_DISCOVERY_TIMEOUT || '120';

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: process.env });

// Guard (2026-11-09): this is a LIVE deploy — the project has no staging copy, and `firebase deploy`
// ships hosting, functions, rules and indexes together. A person has to type the project id to go
// ahead. No prompt can be answered without a terminal, so scripts and AI tools cannot run it.
const project = JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url), 'utf8')).projects.default;
if (!process.stdin.isTTY) {
  console.error(`Refusing to deploy: this ships to the LIVE project "${project}" and needs a person at a terminal to confirm.`);
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `\nThis deploys hosting, functions, Firestore/Storage rules and indexes to the LIVE project "${project}".\n` +
  `Type the project id to continue (anything else cancels): `,
);
rl.close();
if (answer.trim() !== project) {
  console.error('Cancelled — nothing was deployed.');
  process.exit(1);
}

run('npm run build');
run('firebase deploy');
