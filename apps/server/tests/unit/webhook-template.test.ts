import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_LIMITS,
  WebhookTemplate,
  compileTemplateString,
  normalizeMessage,
  renderCompiled,
  renderTemplate,
} from '@harmony/shared';

const render = (source: string, body: unknown): string => {
  const compiled = compileTemplateString(source);
  if (!compiled.ok) throw new Error(compiled.error);
  return renderCompiled(compiled.parts, body);
};

const body = {
  name: 'Backup',
  status: 'ok',
  host: {
    name: 'nas',
    disks: [
      { label: 'sda', used: 91 },
      { label: 'sdb', used: 12 },
    ],
  },
  empty: '',
  nothing: null,
  tags: ['a', 'b'],
};

describe('template placeholders', () => {
  it('resolves dot paths and array indices', () => {
    expect(render('{{name}} on {{host.name}}', body)).toBe('Backup on nas');
    expect(render('{{host.disks[1].label}} {{host.disks.0.used}}', body)).toBe('sdb 91');
    expect(render('{{tags[0]}}{{tags.1}}', body)).toBe('ab');
  });

  it('renders missing, null and out-of-range as empty', () => {
    expect(render('[{{nope}}][{{nothing}}][{{host.disks[9].label}}][{{name.deeper}}]', body)).toBe(
      '[][][][]',
    );
  });

  it('renders objects as compact JSON', () => {
    expect(render('{{tags}}', body)).toBe('["a","b"]');
  });

  it('applies the fixed filters in order', () => {
    expect(render('{{name | upper}}', body)).toBe('BACKUP');
    expect(render('{{name | lower}}', body)).toBe('backup');
    expect(render('{{name | truncate:3}}', body)).toBe('Ba…');
    expect(render('{{empty | default:"n/a"}} {{name | default:"x"}}', body)).toBe('n/a Backup');
    expect(render('{{missing | default:"a | b"}}', body)).toBe('a | b');
    expect(render('{{name | json}} {{nothing | json}}', body)).toBe('"Backup" null');
    expect(render('{{name | upper | truncate:2}}', body)).toBe('B…');
  });

  it('rejects unknown filters, bad paths and unbalanced braces when compiling', () => {
    expect(compileTemplateString('{{name | eval}}').ok).toBe(false);
    expect(compileTemplateString('{{name | truncate}}').ok).toBe(false);
    expect(compileTemplateString('{{name | upper:3}}').ok).toBe(false);
    expect(compileTemplateString('{{}}').ok).toBe(false);
    expect(compileTemplateString('{{a..b}}').ok).toBe(false);
    expect(compileTemplateString('{{a[x]}}').ok).toBe(false);
    expect(compileTemplateString('oops {{ name').ok).toBe(false);
    expect(compileTemplateString('{{ name }} }}').ok).toBe(false);
    expect(compileTemplateString('{{a.b.c.d.e.f.g.h.i.j.k.l.m.n}}').ok).toBe(false);
  });

  it('does not evaluate anything: expressions are just bad paths', () => {
    for (const source of [
      '{{1+1}}',
      '{{name.length}}',
      '{{(function(){})()}}',
      '{{`x`}}',
      '{{process.env}}',
    ]) {
      const compiled = compileTemplateString(source);
      if (compiled.ok) expect(renderCompiled(compiled.parts, body)).toBe('');
    }
  });
});

describe('template hostile inputs', () => {
  it('never reads prototype properties', () => {
    for (const path of [
      '__proto__',
      'constructor',
      'prototype',
      'constructor.name',
      'a.__proto__.x',
    ]) {
      expect(compileTemplateString(`{{${path}}}`).ok).toBe(false);
    }
    // The key can still exist in a JSON body (JSON.parse makes it an own property); it is not readable.
    const parsed = JSON.parse(
      '{"__proto__": {"polluted": "yes"}, "constructor": "boom", "ok": 1}',
    ) as unknown;
    expect(render('{{ok}}', parsed)).toBe('1');
    expect(render('{{toString}} {{hasOwnProperty}} {{valueOf}}', parsed)).toBe('  ');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('handles a very large body and deep nesting without reading it all', () => {
    const huge = {
      text: 'x'.repeat(5_000_000),
      list: Array.from({ length: 200_000 }, (_, i) => i),
    };
    const started = Date.now();
    const out = render('{{text | truncate:10}} {{list[199999]}} {{list | truncate:5}}', huge);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.startsWith('xxxxxxxxx… 199999 ')).toBe(true);
    let deep: unknown = 'bottom';
    for (let i = 0; i < 2000; i++) deep = { n: deep };
    expect(render('{{n.n.n}}', deep)).not.toBe('bottom');
    expect(compileTemplateString(`{{${Array(13).fill('n').join('.')}}}`).ok).toBe(false);
  });

  it('keeps one substitution and the whole string bounded', () => {
    const out = render('{{a}}{{a}}{{a}}{{a}}{{a}}{{a}}{{a}}{{a}}{{a}}', { a: 'y'.repeat(100_000) });
    expect(out.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.string * 4 + TEMPLATE_LIMITS.value);
    const message = normalizeMessage({ content: out });
    expect(message?.content.length).toBeLessThanOrEqual(2000);
  });

  it('disarms mass mentions however they arrive', () => {
    const out = render('{{who}} and @everyone and @here', { who: '@everyone' });
    expect(out).not.toMatch(/@(everyone|here)\b/);
    const message = normalizeMessage(
      renderTemplate(
        WebhookTemplate.parse({
          content: '@Everyone {{who}}',
          embed: { title: '@here {{who}}', fields: [{ name: '@everyone', value: '{{who}}' }] },
        }),
        { who: '@here' },
      ),
    );
    expect(JSON.stringify(message)).not.toMatch(/@(everyone|here)\b/i);
  });

  it('cannot be tricked by placeholders inside substituted values', () => {
    expect(render('{{a}}', { a: '{{b}}', b: 'secret' })).toBe('{{b}}');
  });
});

describe('WebhookTemplate schema', () => {
  it('accepts a content or embed template', () => {
    expect(WebhookTemplate.safeParse({ content: 'Hi {{name}}' }).success).toBe(true);
    expect(
      WebhookTemplate.safeParse({
        embed: {
          title: '{{name | upper}}',
          color: '{{color | default:"#3498db"}}',
          fields: [{ name: 'Host', value: '{{host.name}}', inline: true }],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects empty templates, unknown keys, bad placeholders and too many fields', () => {
    expect(WebhookTemplate.safeParse({}).success).toBe(false);
    expect(WebhookTemplate.safeParse({ content: 'x', script: 'alert(1)' }).success).toBe(false);
    expect(WebhookTemplate.safeParse({ embed: { loop: '{{#each x}}' } }).success).toBe(false);
    expect(WebhookTemplate.safeParse({ content: '{{x | eval}}' }).success).toBe(false);
    expect(WebhookTemplate.safeParse({ content: 'x'.repeat(2001) }).success).toBe(false);
    const fields = Array.from({ length: 11 }, () => ({ name: 'a', value: 'b' }));
    expect(WebhookTemplate.safeParse({ embed: { fields } }).success).toBe(false);
    const many = Array.from({ length: 100 }, () => '{{a}}').join(' ');
    expect(WebhookTemplate.safeParse({ content: many.slice(0, 1900) }).success).toBe(true);
    expect(
      WebhookTemplate.safeParse({
        content: '{{a}}'.repeat(300),
      }).success,
    ).toBe(false);
  });
});

describe('renderTemplate', () => {
  const template = WebhookTemplate.parse({
    content: 'Backup {{status | upper}}',
    embed: {
      title: '{{name}}',
      description: 'Disk {{host.disks[0].label}} at {{host.disks[0].used}}%',
      url: '{{link}}',
      color: '{{color}}',
      fields: [
        { name: 'Host', value: '{{host.name}}', inline: true },
        { name: '{{nothing}}', value: 'dropped because the name is empty' },
      ],
      footer: 'via webhook',
    },
  });

  it('fills content and embed, dropping empty fields and invalid links', () => {
    const message = normalizeMessage(
      renderTemplate(template, { ...body, link: 'javascript:alert(1)', color: '#ff0000' }),
    );
    expect(message?.content).toBe('Backup OK');
    const embed = message?.embeds[0];
    expect(embed?.title).toBe('Backup');
    expect(embed?.description).toBe('Disk sda at 91%');
    expect(embed?.url).toBeUndefined();
    expect(embed?.color).toBe(0xff0000);
    expect(embed?.fields).toEqual([{ name: 'Host', value: 'nas', inline: true }]);
    expect(embed?.footer?.text).toBe('via webhook');
  });

  it('keeps https links and decimal colours, ignores bad colours', () => {
    const ok = normalizeMessage(
      renderTemplate(template, { ...body, link: 'https://example.test/x', color: '255' }),
    );
    expect(ok?.embeds[0]?.url).toBe('https://example.test/x');
    expect(ok?.embeds[0]?.color).toBe(255);
    const bad = normalizeMessage(renderTemplate(template, { ...body, color: 'red' }));
    expect(bad?.embeds[0]?.color).toBeUndefined();
  });

  it('yields nothing when everything renders empty', () => {
    const t = WebhookTemplate.parse({ content: '{{nope}}' });
    expect(normalizeMessage(renderTemplate(t, {}))).toBeNull();
  });

  it('clamps long output to the embed limits', () => {
    const t = WebhookTemplate.parse({ embed: { title: '{{a}}', description: '{{a}}' } });
    const message = normalizeMessage(renderTemplate(t, { a: 'z'.repeat(50_000) }));
    expect(message?.embeds[0]?.title?.length).toBeLessThanOrEqual(256);
    expect(message?.embeds[0]?.description?.length).toBeLessThanOrEqual(4096);
  });
});

describe('normalizeMessage', () => {
  it('caps the total embed size', () => {
    const embeds = Array.from({ length: 10 }, () => ({ description: 'd'.repeat(4000) }));
    const message = normalizeMessage({ embeds });
    const total = message?.embeds.reduce((n, e) => n + (e.description?.length ?? 0), 0) ?? 0;
    expect(total).toBeLessThanOrEqual(6000);
  });
});
