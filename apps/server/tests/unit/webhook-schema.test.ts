import { describe, expect, it } from 'vitest';
import { EMBED_LIMITS, WebhookExecuteBody, stripMassMentions } from '@harmony/shared';
import { kumaDown, kumaTest, kumaUp } from '../support/kuma-payloads.js';

const parse = (input: unknown) => WebhookExecuteBody.safeParse(input);

describe('webhook payloads', () => {
  it('accepts a Discord message with every listed embed property', () => {
    const result = parse({
      content: 'hello',
      username: 'CI',
      avatar_url: 'https://example.com/a.png',
      embeds: [
        {
          title: 'T',
          description: 'D',
          url: 'https://example.com',
          color: 0x00ff00,
          timestamp: '2026-10-22T08:00:00.000Z',
          fields: [{ name: 'n', value: 'v', inline: true }],
          footer: { text: 'f' },
          author: { name: 'a' },
          thumbnail: { url: 'https://example.com/t.png' },
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ content: 'hello', username: 'CI' });
  });

  it('accepts Slack-style text and maps it to content', () => {
    expect(parse({ text: 'from slack' }).data?.content).toBe('from slack');
  });

  it('prefers content over text', () => {
    expect(parse({ content: 'a', text: 'b' }).data?.content).toBe('a');
  });

  it('allows empty content when embeds exist, and rejects an empty message', () => {
    expect(parse({ embeds: [{ title: 'only an embed' }] }).success).toBe(true);
    expect(parse({}).success).toBe(false);
    expect(parse({ content: '   ' }).success).toBe(false);
    expect(parse({ embeds: [] }).success).toBe(false);
  });

  it('ignores Discord fields it does not use', () => {
    const result = parse({
      content: 'x',
      tts: false,
      flags: 4096,
      thread_name: 't',
      allowed_mentions: {},
    });
    expect(result.success).toBe(true);
    expect(Object.keys(result.data ?? {})).not.toContain('flags');
  });

  it('accepts Uptime Kuma down, up and test payloads', () => {
    expect(parse(kumaDown).success).toBe(true);
    expect(parse(kumaUp).success).toBe(true);
    expect(parse(kumaTest).success).toBe(true);
  });

  it('normalizes Kuma timestamps (UTC, space separated) to ISO 8601', () => {
    const embed = parse(kumaDown).data?.embeds[0];
    expect(embed?.timestamp).toBe('2026-10-22T08:15:30.123Z');
    expect(embed?.fields).toHaveLength(5);
  });

  it('enforces content, username and avatar limits', () => {
    expect(parse({ content: 'x'.repeat(2000) }).success).toBe(true);
    expect(parse({ content: 'x'.repeat(2001) }).success).toBe(false);
    expect(parse({ content: 'x', username: 'u'.repeat(81) }).success).toBe(false);
    expect(parse({ content: 'x', avatar_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(parse({ content: 'x', avatar_url: 'ftp://example.com/a.png' }).success).toBe(false);
  });

  it('enforces Discord embed limits', () => {
    const embed = (extra: object) => parse({ embeds: [{ title: 't', ...extra }] }).success;
    expect(parse({ embeds: Array.from({ length: 10 }, () => ({ title: 't' })) }).success).toBe(
      true,
    );
    expect(parse({ embeds: Array.from({ length: 11 }, () => ({ title: 't' })) }).success).toBe(
      false,
    );
    expect(embed({ title: 'x'.repeat(257) })).toBe(false);
    expect(embed({ description: 'x'.repeat(4097) })).toBe(false);
    expect(embed({ fields: Array.from({ length: 25 }, () => ({ name: 'n', value: 'v' })) })).toBe(
      true,
    );
    expect(embed({ fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) })).toBe(
      false,
    );
    expect(embed({ fields: [{ name: 'n'.repeat(257), value: 'v' }] })).toBe(false);
    expect(embed({ fields: [{ name: '', value: 'v' }] })).toBe(false);
    expect(embed({ fields: [{ name: 'n', value: 'v'.repeat(1025) }] })).toBe(false);
    expect(embed({ footer: { text: 'x'.repeat(2049) } })).toBe(false);
    expect(embed({ author: { name: 'x'.repeat(257) } })).toBe(false);
    expect(embed({ color: -1 })).toBe(false);
    expect(embed({ color: 0x1000000 })).toBe(false);
    expect(embed({ color: 1.5 })).toBe(false);
    expect(embed({ url: 'javascript:alert(1)' })).toBe(false);
    expect(embed({ thumbnail: { url: 'data:image/png;base64,AAAA' } })).toBe(false);
    expect(embed({ timestamp: 'yesterday' })).toBe(false);
  });

  it('caps the total characters across embeds at 6000', () => {
    const big = (n: number) => ({ description: 'x'.repeat(n) });
    expect(parse({ embeds: [big(4000), big(2000)] }).success).toBe(true);
    expect(parse({ embeds: [big(4000), big(2001)] }).success).toBe(false);
    expect(EMBED_LIMITS.totalChars).toBe(6000);
  });
});

describe('mass mention stripping', () => {
  it('defuses @everyone and @here but leaves user mentions alone', () => {
    const stripped = stripMassMentions('hi @everyone and @here, <@12> and @EVERYONE');
    expect(stripped).not.toMatch(/@everyone/i);
    expect(stripped).not.toMatch(/@here/i);
    expect(stripped).toContain('<@12>');
    expect(stripped.replaceAll('​', '')).toBe('hi @everyone and @here, <@12> and @EVERYONE');
  });
});
