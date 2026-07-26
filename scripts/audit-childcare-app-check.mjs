import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const serverPolicyPath = path.join(root, 'functions/src/childcare/appCheckPolicy.ts');
const clientPolicyPath = path.join(root, 'lib/childcareCallable.ts');
const indexPath = path.join(root, 'functions/src/index.ts');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function objectBody(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing policy marker: ${marker}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('} as const', open);
  if (open < 0 || close < 0) throw new Error(`Malformed policy object: ${marker}`);
  return source.slice(open + 1, close);
}

function parseServerPolicy(source) {
  const body = objectBody(source, 'CHILDCARE_APPCHECK_POLICY =');
  const entries = new Map();
  for (const match of body.matchAll(
    /^\s{2}([A-Za-z0-9_]+):\s+(standard|limited|nonDeployedLimited)\(/gm,
  )) {
    entries.set(match[1], {
      level: match[2] === 'standard' ? 'standard' : 'limited-use',
      exported: match[2] !== 'nonDeployedLimited',
    });
  }
  return entries;
}

function parseClientPolicy(source) {
  const body = objectBody(source, 'CHILDCARE_CLIENT_APPCHECK_POLICY =');
  const entries = new Map();
  for (const match of body.matchAll(
    /^\s{2}([A-Za-z0-9_]+):\s+(standard|limited),?$/gm,
  )) {
    entries.set(match[1], match[2] === 'standard' ? 'standard' : 'limited-use');
  }
  return entries;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'lib', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const serverSource = read(serverPolicyPath);
const clientSource = read(clientPolicyPath);
const indexSource = read(indexPath);
const server = parseServerPolicy(serverSource);
const client = parseClientPolicy(clientSource);
const failures = [];
const deployed = [...server.entries()].filter(([, policy]) => policy.exported);

for (const [name, policy] of deployed) {
  if (client.get(name) !== policy.level) {
    failures.push(
      `client/server policy drift for ${name}: server=${policy.level}, client=${client.get(name) ?? 'missing'}`,
    );
  }
  if (!new RegExp(`\\b${name}\\b`).test(indexSource)) {
    failures.push(`deployed callable ${name} is missing from functions/src/index.ts`);
  }
}
for (const name of client.keys()) {
  if (!server.get(name)?.exported) {
    failures.push(`client policy includes non-deployed or unknown callable ${name}`);
  }
}

const serverFiles = walk(path.join(root, 'functions/src/childcare'))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
for (const file of serverFiles) {
  const source = read(file);
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (
    relative !== 'functions/src/childcare/appCheckPolicy.ts' &&
    /functions\.https\.onCall\s*\(/.test(source)
  ) {
    failures.push(`${relative} bypasses childcareOnCall`);
  }
  for (const match of source.matchAll(/childcareOnCall\(\s*["']([^"']+)["']/g)) {
    if (!server.has(match[1])) failures.push(`${relative} uses unknown policy ${match[1]}`);
  }
}

const frontendFiles = [
  ...walk(path.join(root, 'components')),
  ...walk(path.join(root, 'services')),
  ...walk(path.join(root, 'lib')),
].filter(
  (file) =>
    /\.(?:ts|tsx)$/.test(file) &&
    !/\.test\.(?:ts|tsx)$/.test(file) &&
    !file.endsWith(path.join('lib', 'childcareCallable.ts')),
);
const deployedNames = new Set(deployed.map(([name]) => name));
for (const file of frontendFiles) {
  const source = read(file);
  const relative = path.relative(root, file).replaceAll('\\', '/');
  for (const match of source.matchAll(/httpsCallable[\s\S]{0,160}?["']v1-([A-Za-z0-9_]+)["']/g)) {
    if (deployedNames.has(match[1])) {
      failures.push(`${relative} directly calls childcare callable ${match[1]}`);
    }
  }
  for (const match of source.matchAll(/childcareCallable\(\s*["'](?:v1-)?([^"']+)["']/g)) {
    if (!client.has(match[1])) failures.push(`${relative} uses unknown client policy ${match[1]}`);
  }
}

for (const [name] of server) {
  if (!new RegExp(`childcareOnCall\\(\\s*["']${name}["']`).test(
    serverFiles.map(read).join('\n'),
  )) {
    failures.push(`server policy ${name} has no childcareOnCall implementation`);
  }
}

if (failures.length > 0) {
  console.error(`Childcare App Check audit FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Childcare App Check audit passed: ${deployed.length} deployed policies, ` +
  `${server.size - deployed.length} non-deployed policies, zero direct bypasses.`,
);
