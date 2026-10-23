// Checks that every relative link and image in the repository's Markdown files resolves to an
// existing file, and that #anchors match a heading in the target. No dependencies.
// Usage: node scripts/check-links.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skip = new Set(['node_modules', '.git', 'dist', 'target', 'results', '.work', '.claude']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const stripFences = (text) =>
  text.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, (m) => m.replace(/[^\n]/g, ''));

// GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens.
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const anchorCache = new Map();
function anchors(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    for (const m of stripFences(readFileSync(file, 'utf8')).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
      const base = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n ? `${base}-${n}` : base);
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

let failures = 0;
let checked = 0;
for (const file of walk(root)) {
  const text = stripFences(readFileSync(file, 'utf8')).replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, ...
    const [pathPart, hash] = target.split('#');
    const dest = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
    checked++;
    let ok = true;
    let why = '';
    try {
      statSync(dest);
    } catch {
      ok = false;
      why = 'file not found';
    }
    if (ok && hash && dest.endsWith('.md') && !anchors(dest).has(hash.toLowerCase())) {
      ok = false;
      why = 'anchor not found';
    }
    if (!ok) {
      failures++;
      console.error(`${relative(root, file)}: ${target} (${why})`);
    }
  }
}
console.log(`${checked} relative links checked, ${failures} broken`);
process.exit(failures ? 1 : 0);
