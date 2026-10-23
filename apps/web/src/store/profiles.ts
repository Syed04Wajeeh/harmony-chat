import type { GuildEmoji, Perk, ProfileSummary } from '@harmony/shared';
import { create } from 'zustand';
import { api } from '../api/client.js';

export type UsableEmoji = GuildEmoji & { usable: boolean };

interface ProfilesState {
  summaries: Record<string, ProfileSummary>;
  /** Bumped when a user's profile changed, so an open popover refetches. */
  versions: Record<string, number>;
  emoji: readonly UsableEmoji[];
  perks: ReadonlySet<Perk>;
  explicitPerks: ReadonlySet<Perk>;

  ingestSummaries(summaries: Record<string, ProfileSummary>, replace?: boolean): void;
  userUpdated(userId: string, summary: ProfileSummary): void;
  emojiUpdated(guildId: string, emoji: readonly GuildEmoji[]): void;
  refresh(): Promise<void>;
}

export const useProfiles = create<ProfilesState>()((set, get) => ({
  summaries: {},
  versions: {},
  emoji: [],
  perks: new Set(),
  explicitPerks: new Set(),

  ingestSummaries: (summaries, replace = false) =>
    set((state) => ({ summaries: replace ? summaries : { ...state.summaries, ...summaries } })),
  userUpdated: (userId, summary) =>
    set((state) => ({
      summaries: { ...state.summaries, [userId]: summary },
      versions: { ...state.versions, [userId]: (state.versions[userId] ?? 0) + 1 },
    })),
  emojiUpdated: (guildId, emoji) => {
    const usable = get().perks.has('cross_server_emoji');
    set((state) => ({
      emoji: [
        ...state.emoji.filter((item) => item.guildId !== guildId),
        ...emoji.map((item) => ({ ...item, usable })),
      ],
    }));
  },
  refresh: async () => {
    try {
      const [emoji, perks] = await Promise.all([api.myEmoji(), api.myPerks()]);
      set({ emoji, perks: new Set(perks.perks), explicitPerks: new Set(perks.explicit) });
    } catch {
      // Customization is a nicety; the app works without it.
    }
  },
}));

export const usePerk = (perk: Perk): boolean => useProfiles((state) => state.perks.has(perk));
