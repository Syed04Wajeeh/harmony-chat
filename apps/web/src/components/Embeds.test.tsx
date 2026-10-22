import type { Embed } from '@harmony/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Embeds } from './Embeds.js';

const nameOf = () => undefined;
const show = (...embeds: Embed[]) => render(<Embeds embeds={embeds} nameOf={nameOf} meId="1" />);

describe('Embeds', () => {
  it('renders the parts of a full embed', () => {
    const { container } = show({
      title: 'Build 42',
      url: 'https://ci.example.com/42',
      description: 'All **green**',
      color: 0x2ecc71,
      author: { name: 'CI', url: 'https://ci.example.com', icon_url: 'https://example.com/a.png' },
      fields: [
        { name: 'Branch', value: 'main', inline: true },
        { name: 'Commit', value: 'abc123', inline: true },
        { name: 'Notes', value: 'Full width' },
      ],
      footer: { text: 'ci-runner', icon_url: 'https://example.com/f.png' },
      timestamp: '2026-10-22T08:00:00.000Z',
      thumbnail: { url: 'https://example.com/t.png' },
      image: { url: 'https://example.com/i.png' },
    });

    expect(screen.getByRole('link', { name: 'Build 42' })).toHaveAttribute(
      'href',
      'https://ci.example.com/42',
    );
    expect(screen.getByRole('link', { name: 'CI' })).toHaveAttribute(
      'href',
      'https://ci.example.com/',
    );
    expect(screen.getByText('green').tagName).toBe('STRONG');
    expect(container.querySelector('.embed')).toHaveStyle({ '--embed-color': '#2ecc71' });
    const fields = container.querySelectorAll('.embed-field');
    expect([...fields].map((f) => f.hasAttribute('data-inline'))).toEqual([true, true, false]);
    expect(screen.getByText(/ci-runner/)).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-10-22T08:00:00.000Z');
  });

  it('loads remote images directly, lazily and without a referrer', () => {
    const { container } = show({
      author: { name: 'A', icon_url: 'https://example.com/a.png' },
      thumbnail: { url: 'https://example.com/t.png' },
      image: { url: 'https://example.com/i.png' },
      footer: { text: 'f', icon_url: 'https://example.com/f.png' },
    });
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(4);
    for (const img of images) {
      expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img.getAttribute('src')).toMatch(/^https:\/\/example\.com\//);
    }
  });

  it('never makes a link or image out of a non-http URL', () => {
    const { container } = show({
      title: 'Click me',
      url: 'javascript:alert(1)',
      author: {
        name: 'Mallory',
        url: 'JaVaScRiPt:alert(2)',
        icon_url: 'data:image/svg+xml,<svg onload=alert(3)>',
      },
      description: '[x](javascript:alert(4)) <img src=x onerror=alert(5)> javascript:alert(6)',
      thumbnail: { url: 'javascript:alert(7)' },
      image: { url: 'file:///etc/passwd' },
      footer: { text: 'foot', icon_url: 'vbscript:msgbox' },
    });
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toMatch(/href=["']?javascript/i);
    expect(screen.getByText('Click me')).toBeInTheDocument();
    expect(screen.getByText('Mallory')).toBeInTheDocument();
    // Raw HTML in text stays text.
    expect(screen.getByText(/<img src=x onerror=alert\(5\)>/)).toBeInTheDocument();
  });

  it('still links plain http(s) URLs written in the description', () => {
    show({ description: 'see https://example.com/docs now' });
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute(
      'rel',
      expect.stringContaining('noopener'),
    );
  });

  it('copes with missing parts and empty embeds', () => {
    const { container } = show(
      { description: 'just text' },
      {},
      { fields: [{ name: 'Empty', value: '' }] },
    );
    expect(container.querySelectorAll('.embed')).toHaveLength(2);
    expect(screen.getByText('just text')).toBeInTheDocument();
    expect(screen.getByText('Empty')).toBeInTheDocument();
    expect(container.querySelector('.embed-field-value')).toBeNull();
    expect(container.querySelector('.embed')).not.toHaveAttribute('style');
  });

  it('renders nothing when no embed has anything to show', () => {
    const { container } = show({}, { color: 5 });
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores out-of-range colors', () => {
    const { container } = show({ title: 't', color: -1 }, { title: 'u', color: 0x1000000 });
    for (const embed of container.querySelectorAll('.embed')) {
      expect(embed).not.toHaveAttribute('style');
    }
  });

  it('keeps very long unbroken text inside the card', () => {
    const long = 'x'.repeat(4000);
    show({ title: 'T'.repeat(256), description: long, fields: [{ name: 'n', value: long }] });
    const card = screen.getAllByRole('article')[0];
    expect(card).toBeDefined();
    if (card) expect(within(card).getAllByText(long)).toHaveLength(2);
  });
});
