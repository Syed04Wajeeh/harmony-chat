// package.json is the single source of the app version. tauri.conf.json reads it directly;
// this keeps Cargo.toml and Cargo.lock in step. `--check` fails instead of writing, and
// `--tag vX.Y.Z` also verifies a release tag matches.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const { version } = JSON.parse(read('package.json'));

const args = process.argv.slice(2);
const check = args.includes('--check');
const tag = args[args.indexOf('--tag') + 1];

if (args.includes('--tag') && tag !== `v${version}`) {
  console.error(`Tag ${String(tag)} does not match apps/desktop/package.json version ${version}`);
  process.exit(1);
}

const targets = [
  ['src-tauri/Cargo.toml', /^(name = "harmony-desktop"\nversion = ")[^"]+(")/m],
  ['src-tauri/Cargo.lock', /(name = "harmony-desktop"\nversion = ")[^"]+(")/],
];

let stale = false;
for (const [path, pattern] of targets) {
  const text = read(path);
  const next = text.replace(pattern, `$1${version}$2`);
  if (next === text) continue;
  stale = true;
  if (!check) writeFileSync(new URL(path, root), next);
  console.log(`${check ? 'out of date' : 'updated'}: ${path}`);
}
if (check && stale) process.exit(1);
