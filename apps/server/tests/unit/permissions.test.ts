import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  computePermissions,
  hasPermission,
  missingToGrant,
  outranks,
  topPosition,
  type OverwriteRule,
  type PermissionInput,
} from '@harmony/shared';
import { canModerate } from '../../src/permissions/access.js';

const everyone = { id: '1', position: 0, permissions: ['view_channel', 'send_messages'] };
const mod = { id: '2', position: 2, permissions: ['manage_messages'] };
const muted = { id: '3', position: 1, permissions: [] };

const input = (over: Partial<PermissionInput> = {}): PermissionInput => ({
  userId: '10',
  isOwner: false,
  isInstanceAdmin: false,
  everyone,
  roles: [],
  ...over,
});
const can = (over: Partial<PermissionInput>, key: string) =>
  hasPermission(computePermissions(input(over)), key);
const role = (targetId: string, allow: string[] = [], deny: string[] = []): OverwriteRule => ({
  targetType: 'role',
  targetId,
  allow,
  deny,
});
const member = (targetId: string, allow: string[] = [], deny: string[] = []): OverwriteRule => ({
  targetType: 'member',
  targetId,
  allow,
  deny,
});

describe('computePermissions', () => {
  it('gives everyone what @everyone has and nothing else', () => {
    expect(can({}, 'send_messages')).toBe(true);
    expect(can({}, 'manage_messages')).toBe(false);
  });

  it('unions @everyone with every role the member holds', () => {
    expect(can({ roles: [mod] }, 'manage_messages')).toBe(true);
    expect(can({ roles: [mod] }, 'send_messages')).toBe(true);
  });

  it('lets the owner and instance admins do everything, overwrites included', () => {
    const overwrites = [role('1', [], ['send_messages'])];
    expect(can({ isOwner: true, overwrites }, 'send_messages')).toBe(true);
    expect(can({ isInstanceAdmin: true, overwrites }, 'anything.at_all')).toBe(true);
  });

  it('treats administrator as everything and skips overwrites', () => {
    const admin = { id: '4', position: 3, permissions: ['administrator'] };
    const overwrites = [role('1', [], ['view_channel']), member('10', [], ['view_channel'])];
    const result = computePermissions(input({ roles: [admin], overwrites }));
    expect(result.all).toBe(true);
    expect(hasPermission(result, 'view_channel')).toBe(true);
  });

  describe('channel overwrites', () => {
    it('apply @everyone first, then role denies, then role allows, then the member', () => {
      const overwrites = [
        role('1', [], ['send_messages']),
        role('2', ['send_messages'], []),
        member('10', [], ['send_messages']),
      ];
      // Role allow beats the @everyone deny; the member's own deny beats the role allow.
      expect(can({ roles: [mod], overwrites: overwrites.slice(0, 2) }, 'send_messages')).toBe(true);
      expect(can({ roles: [mod], overwrites }, 'send_messages')).toBe(false);
    });

    it('lets a role deny beat an allow that came from @everyone', () => {
      const overwrites = [role('1', ['attach_files'], []), role('3', [], ['attach_files'])];
      expect(can({ roles: [muted], overwrites }, 'attach_files')).toBe(false);
    });

    it('lets a role allow beat a role deny held at the same level', () => {
      const overwrites = [role('3', [], ['attach_files']), role('2', ['attach_files'], [])];
      expect(can({ roles: [muted, mod], overwrites }, 'attach_files')).toBe(true);
    });

    it('lets a member allow beat a role deny', () => {
      const overwrites = [role('3', [], ['send_messages']), member('10', ['send_messages'], [])];
      expect(can({ roles: [muted], overwrites }, 'send_messages')).toBe(true);
    });

    it('ignores overwrites for other members and roles the member lacks', () => {
      const overwrites = [member('99', [], ['send_messages']), role('2', [], ['send_messages'])];
      expect(can({ overwrites }, 'send_messages')).toBe(true);
    });

    it('makes a private channel: deny view to @everyone, allow it to chosen members', () => {
      const overwrites = [role('1', [], ['view_channel']), member('10', ['view_channel'], [])];
      expect(can({ overwrites }, 'view_channel')).toBe(true);
      expect(can({ userId: '11', overwrites }, 'view_channel')).toBe(false);
    });

    it('can grant a permission @everyone lacks', () => {
      expect(can({ overwrites: [role('1', ['attach_files'])] }, 'attach_files')).toBe(true);
    });
  });
});

describe('hierarchy', () => {
  it('reads the highest role position, 0 without roles', () => {
    expect(topPosition([])).toBe(0);
    expect(topPosition([mod, muted])).toBe(2);
  });

  it('only outranks strictly lower positions, and superusers outrank all', () => {
    expect(outranks({ superuser: false, top: 2 }, 1)).toBe(true);
    expect(outranks({ superuser: false, top: 2 }, 2)).toBe(false);
    expect(outranks({ superuser: true, top: 0 }, 99)).toBe(true);
  });

  it('never lets anyone moderate a superuser unless they are one', () => {
    const owner = { superuser: true, top: 0 };
    expect(canModerate({ superuser: false, top: 9 }, owner)).toBe(false);
    expect(canModerate(owner, { superuser: false, top: 9 })).toBe(true);
    expect(canModerate({ superuser: false, top: 3 }, { superuser: false, top: 2 })).toBe(true);
    expect(canModerate({ superuser: false, top: 2 }, { superuser: false, top: 2 })).toBe(false);
  });

  it('lists the permissions an actor would be granting without holding them', () => {
    const held = computePermissions(input({ roles: [mod] }));
    expect(missingToGrant(held, ['manage_messages', 'manage_guild'])).toEqual(['manage_guild']);
    const owner = computePermissions(input({ isOwner: true }));
    expect(missingToGrant(owner, ['manage_guild'])).toEqual([]);
  });
});

describe('defaults', () => {
  it('give @everyone only what members could do before roles', () => {
    expect(DEFAULT_EVERYONE_PERMISSIONS).toContain('send_messages');
    expect(DEFAULT_EVERYONE_PERMISSIONS).not.toContain('manage_messages');
    expect(DEFAULT_EVERYONE_PERMISSIONS).not.toContain('administrator');
  });
});
