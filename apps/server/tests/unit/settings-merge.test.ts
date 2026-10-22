import { describe, expect, it } from 'vitest';
import {
  Appearance,
  DEFAULT_APPEARANCE,
  DEFAULT_SETTINGS,
  PatchSettingsBody,
  combinePatches,
  mergeSettings,
  normalizeSettings,
  DEFAULT_BEHAVIOR,
  Behavior,
} from '@harmony/shared';

describe('settings merge', () => {
  it('applies only the fields in the patch', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      appearance: { density: 'compact' },
      behavior: { sendOnEnter: false },
    });
    expect(merged.appearance).toEqual({ ...DEFAULT_APPEARANCE, density: 'compact' });
    expect(merged.behavior.sendOnEnter).toBe(false);
    expect(merged.behavior.timeFormat).toBe('12h');
  });

  it('ignores undefined values', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { appearance: { density: undefined } });
    expect(merged.appearance.density).toBe('cozy');
  });

  it('does not mutate its input', () => {
    mergeSettings(DEFAULT_SETTINGS, { appearance: { density: 'compact' } });
    expect(DEFAULT_SETTINGS.appearance.density).toBe('cozy');
  });

  it('combines unsent patches with the later one winning', () => {
    const combined = combinePatches(
      { appearance: { density: 'compact', fontScale: 1.1 } },
      { appearance: { density: 'comfortable' }, behavior: { showAvatars: false } },
    );
    expect(combined).toEqual({
      appearance: { density: 'comfortable', fontScale: 1.1 },
      behavior: { showAvatars: false },
    });
    expect(combinePatches({}, {})).toEqual({});
  });

  it('a conflict is resolved by replaying the unsent patch on the fresh server copy', () => {
    const server = mergeSettings(
      { ...DEFAULT_SETTINGS, version: 4 },
      { appearance: { panels: 'flat' } },
    );
    const unsent = { appearance: { density: 'compact' as const } };
    const replayed = mergeSettings(server, unsent);
    expect(replayed.appearance.panels).toBe('flat');
    expect(replayed.appearance.density).toBe('compact');
    expect(replayed.version).toBe(4);
  });
});

describe('settings validation', () => {
  it('rejects out-of-range and unknown values', () => {
    expect(PatchSettingsBody.safeParse({ version: 0, appearance: { fontScale: 2 } }).success).toBe(
      false,
    );
    expect(
      PatchSettingsBody.safeParse({ version: 0, appearance: { fontScale: 0.5 } }).success,
    ).toBe(false);
    expect(
      PatchSettingsBody.safeParse({ version: 0, appearance: { messageFont: 'comic-sans' } })
        .success,
    ).toBe(false);
    expect(
      PatchSettingsBody.safeParse({ version: 0, behavior: { autoIdleMinutes: -1 } }).success,
    ).toBe(false);
    expect(PatchSettingsBody.safeParse({ version: 0 }).success).toBe(false);
    expect(
      PatchSettingsBody.safeParse({ version: 0, appearance: { fontScale: 1.25 } }).success,
    ).toBe(true);
  });

  it('rejects oversize custom CSS', () => {
    const big = 'a{}'.repeat(8000);
    expect(
      PatchSettingsBody.safeParse({ version: 0, appearance: { customCss: big } }).success,
    ).toBe(false);
  });

  it('fills defaults field by field for stored data', () => {
    const stored = normalizeSettings(Appearance, DEFAULT_APPEARANCE, {
      density: 'compact',
      fontScale: 99,
      junk: 1,
    });
    expect(stored).toEqual({ ...DEFAULT_APPEARANCE, density: 'compact' });
    expect(normalizeSettings(Behavior, DEFAULT_BEHAVIOR, null)).toEqual(DEFAULT_BEHAVIOR);
  });
});
