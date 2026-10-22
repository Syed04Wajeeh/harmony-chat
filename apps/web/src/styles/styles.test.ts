import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.dirname(new URL(import.meta.url).pathname);
const files = readdirSync(dir).filter((name) => name.endsWith('.css'));
/** The only files allowed to hold raw color values (docs/theming.md). */
const TOKEN_FILES = new Set(['palette.css', 'tokens.css']);
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (name: string) => strip(readFileSync(path.join(dir, name), 'utf8'));
const componentFiles = files.filter((name) => !TOKEN_FILES.has(name) && name !== 'index.css');

const COLOR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\bcolor\(\s*(?:srgb|display-p3)|:\s*(?:white|black)\s*[;!]/;

describe('component stylesheets', () => {
  it('finds the stylesheets', () => {
    expect(componentFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(componentFiles)('%s has no color literals', (name) => {
    const offending = read(name)
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => COLOR_LITERAL.test(line))
      .map(({ line, number }) => `${name}:${String(number)}: ${line.trim()}`);
    expect(offending).toEqual([]);
  });

  it.each(componentFiles)('%s does not read palette primitives', (name) => {
    expect(read(name)).not.toMatch(/--palette-/);
  });

  it('only uses custom properties that something defines', () => {
    // Set from TSX with inline styles (drawer position, embed color, sheet grace period, image size, visual viewport).
    const inline = new Set([
      '--pl',
      '--pr',
      '--embed-color',
      '--grace',
      '--w',
      '--h',
      '--app-top',
      '--app-height',
    ]);
    const all = files.map(read).join('\n');
    const defined = new Set([...all.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? ''));
    const used = new Set([...all.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? ''));
    const missing = [...used].filter((name) => !defined.has(name) && !inline.has(name));
    expect(missing).toEqual([]);
  });
});

describe('theme layer', () => {
  const tokens = read('tokens.css');
  const declarations = (block: string) =>
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
      .map((m) => `${m[1] ?? ''}: ${(m[2] ?? '').trim()}`)
      .sort();

  const blockAfter = (selector: string) => {
    const start = tokens.indexOf(selector);
    expect(start).toBeGreaterThan(-1);
    const open = tokens.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
      if (tokens[i] === '{') depth++;
      if (tokens[i] === '}' && --depth === 0) return tokens.slice(open + 1, i);
    }
    throw new Error('unbalanced');
  };

  it('the OS-preference light block and the explicit light block stay identical', () => {
    const media = declarations(blockAfter(':root:not([data-theme])'));
    const explicit = declarations(blockAfter(":root[data-theme='light']"));
    expect(media.length).toBeGreaterThan(30);
    expect(media).toEqual(explicit);
  });

  it('the light theme overrides every themed token the dark theme defines, except the shared ones', () => {
    const dark = new Set(
      declarations(blockAfter(':root {\n  color-scheme: dark')).map((d) => d.split(':')[0] ?? ''),
    );
    const light = new Set(
      declarations(blockAfter(":root[data-theme='light']")).map((d) => d.split(':')[0] ?? ''),
    );
    // Avatar tones are the same in both themes on purpose.
    const missing = [...dark].filter(
      (name) => !light.has(name) && !name.startsWith('--color-tone'),
    );
    expect(missing).toEqual([]);
  });
});
