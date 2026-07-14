import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function loadViteEnvironment() {
  const values = { ...process.env };
  for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const fullPath = path.resolve(filename);
    if (!fs.existsSync(fullPath)) continue;
    for (const line of fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || values[match[1]]) continue;
      values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return values;
}

function validPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

const env = loadViteEnvironment();
const missing = ['VITE_SUPPORT_PHONE', 'VITE_LINQ_PHONE_NUMBER'].filter(key => !validPhone(env[key]));
if (missing.length) {
  console.error(`Launch configuration missing or invalid: ${missing.join(', ')}`);
  process.exit(1);
}

const heapOption = '--max-old-space-size=8192';
env.NODE_ENV = 'production';
env.NODE_OPTIONS = env.NODE_OPTIONS?.includes('--max-old-space-size')
  ? env.NODE_OPTIONS
  : [env.NODE_OPTIONS, heapOption].filter(Boolean).join(' ');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args) {
  const result = spawnSync(npm, args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['exec', '--', 'tsc', '--noEmit']);
run(['exec', '--', 'vite', 'build']);
