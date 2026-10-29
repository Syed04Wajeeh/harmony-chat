import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../store/settings.js';

type StatusListener = (status: string) => void;

const fake = vi.hoisted(() => ({
  open: true,
  sent: [] as unknown[],
  listeners: new Set<(status: string) => void>(),
}));

vi.mock('../store/connection.js', () => ({
  getRealtime: () => ({
    send: (frame: unknown) => {
      if (!fake.open) return false;
      fake.sent.push(frame);
      return true;
    },
    onStatus: (listener: StatusListener) => {
      fake.listeners.add(listener);
      return () => fake.listeners.delete(listener);
    },
  }),
}));

import { useAutoIdle } from './useAutoIdle.js';

const MINUTE = 60_000;
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};
const idleFrames = () => fake.sent.map((f) => (f as { idle: boolean }).idle);

describe('useAutoIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.open = true;
    fake.sent = [];
    fake.listeners.clear();
    setVisibility('visible');
    useSettings.setState((s) => ({
      settings: { ...s.settings, behavior: { ...s.settings.behavior, autoIdleMinutes: 5 } },
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('reports idle once after the quiet time and never changes the chosen status', () => {
    renderHook(() => useAutoIdle());
    act(() => void vi.advanceTimersByTime(4 * MINUTE));
    expect(fake.sent).toEqual([]);
    act(() => void vi.advanceTimersByTime(2 * MINUTE));
    expect(fake.sent).toEqual([{ type: 'presence.activity', idle: true }]);
    act(() => void vi.advanceTimersByTime(30 * MINUTE));
    expect(fake.sent).toHaveLength(1);
  });

  it('reports active on the first interaction after idle, and not on every one', () => {
    renderHook(() => useAutoIdle());
    act(() => void vi.advanceTimersByTime(6 * MINUTE));
    act(() => void window.dispatchEvent(new Event('pointermove')));
    act(() => void window.dispatchEvent(new Event('keydown')));
    expect(idleFrames()).toEqual([true, false]);
  });

  it('activity keeps resetting the timer so the device never goes idle', () => {
    renderHook(() => useAutoIdle());
    for (let i = 0; i < 5; i++) {
      act(() => void vi.advanceTimersByTime(4 * MINUTE));
      act(() => void window.dispatchEvent(new Event('keydown')));
    }
    expect(fake.sent).toEqual([]);
  });

  it('a hidden tab goes idle on the timer, and showing it again is activity', () => {
    renderHook(() => useAutoIdle());
    act(() => setVisibility('hidden'));
    act(() => void window.dispatchEvent(new Event('pointermove')));
    act(() => void vi.advanceTimersByTime(6 * MINUTE));
    expect(idleFrames()).toEqual([true]);
    act(() => setVisibility('visible'));
    expect(idleFrames()).toEqual([true, false]);
  });

  it('says it is idle again on a new socket', () => {
    renderHook(() => useAutoIdle());
    act(() => void vi.advanceTimersByTime(6 * MINUTE));
    act(() => {
      fake.open = false;
      fake.listeners.forEach((l) => l('reconnecting'));
    });
    act(() => {
      fake.open = true;
      fake.listeners.forEach((l) => l('open'));
    });
    expect(idleFrames()).toEqual([true, true]);
  });

  it('does nothing when auto-idle is off', () => {
    useSettings.setState((s) => ({
      settings: { ...s.settings, behavior: { ...s.settings.behavior, autoIdleMinutes: 0 } },
    }));
    renderHook(() => useAutoIdle());
    act(() => void vi.advanceTimersByTime(60 * MINUTE));
    expect(fake.sent).toEqual([]);
  });

  it('clears its idle flag when it unmounts', () => {
    const { unmount } = renderHook(() => useAutoIdle());
    act(() => void vi.advanceTimersByTime(6 * MINUTE));
    unmount();
    expect(idleFrames()).toEqual([true, false]);
  });
});
