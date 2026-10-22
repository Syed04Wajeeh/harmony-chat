import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../store/store.js';
import { me, user } from '../test/factories.js';
import { TypingIndicator } from './TypingIndicator.js';

describe('TypingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    appStore.setState({
      me,
      users: { '2': user('2', 'Linus'), '3': user('3', 'Grace') },
      typing: {},
    });
  });
  afterEach(() => vi.useRealTimers());

  it('shows who is typing and clears after the expiry', () => {
    render(<TypingIndicator channelId="10" />);
    act(() => appStore.getState().applyFrame({ type: 'typing', channelId: '10', userId: '2' }));
    expect(screen.getByText('Linus is typing…')).toBeInTheDocument();
    act(() => appStore.getState().applyFrame({ type: 'typing', channelId: '10', userId: '3' }));
    expect(screen.getByText('Linus and Grace are typing…')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.queryByText(/typing/)).not.toBeInTheDocument();
  });

  it('is the only live region that announces typing', () => {
    const { container } = render(<TypingIndicator channelId="10" />);
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
