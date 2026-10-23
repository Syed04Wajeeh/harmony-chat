import type { Me, UserProfileResponse } from '@harmony/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfiles } from '../../store/profiles.js';
import { appStore } from '../../store/store.js';

const server = { bio: null as string | null, pronouns: null as string | null };
const profileCalls = { count: 0 };

vi.mock('../../api/client.js', () => ({
  api: {
    profile: vi.fn(() => {
      profileCalls.count += 1;
      return Promise.resolve({
        profile: {
          userId: '1',
          accentColor: null,
          bannerColor: null,
          bannerUrl: null,
          avatarUrl: null,
          providerAvatarUrl: null,
          avatarOverridden: false,
          statusEmoji: null,
          statusText: null,
          statusExpiresAt: null,
          hasPerks: false,
          perks: [],
          bio: server.bio,
          pronouns: server.pronouns,
        },
        displayName: 'Alice',
        login: 'alice',
        createdAt: new Date().toISOString(),
        member: null,
      } satisfies UserProfileResponse);
    }),
    updateProfile: vi.fn((patch: { bio?: string | null; pronouns?: string | null }) => {
      if (patch.bio !== undefined) server.bio = patch.bio;
      if (patch.pronouns !== undefined) server.pronouns = patch.pronouns;
      return Promise.resolve();
    }),
  },
  uploadFile: vi.fn(),
}));

const { ProfilePage } = await import('./ProfilePage.js');

describe('ProfilePage', () => {
  beforeEach(() => {
    server.bio = null;
    server.pronouns = null;
    profileCalls.count = 0;
    appStore.setState({ me: { id: '1', displayName: 'Alice', login: 'alice' } as unknown as Me });
  });

  it('keeps text typed while a refetch triggered by an earlier save lands', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>,
    );
    const pronouns = await screen.findByLabelText('Pronouns');
    const bio = screen.getByRole('textbox', { name: /Bio/ });
    await user.type(pronouns, 'she/her');
    await user.click(bio); // blur saves the pronouns
    await user.type(bio, 'Reads a lot');
    // The server announced the pronouns save to this page, which refetches while the bio is
    // still unsaved.
    const before = profileCalls.count;
    act(() => useProfiles.getState().userUpdated('1', {} as never));
    await waitFor(() => expect(profileCalls.count).toBe(before + 1));
    expect(bio).toHaveValue('Reads a lot');
    expect(pronouns).toHaveValue('she/her');
  });

  it('adopts a change made elsewhere in fields that are not being edited', async () => {
    render(
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>,
    );
    const bio = await screen.findByRole('textbox', { name: /Bio/ });
    server.bio = 'From my phone';
    act(() => useProfiles.getState().userUpdated('1', {} as never));
    await waitFor(() => expect(bio).toHaveValue('From my phone'));
  });
});
