import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ChannelSidebar } from '../components/ChannelSidebar.js';
import { ChannelView } from '../components/ChannelView.js';
import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { DrawerLayout } from '../components/DrawerLayout.js';
import { GuildRail } from '../components/GuildRail.js';
import { MemberList } from '../components/MemberList.js';
import { Toasts } from '../components/Toasts.js';
import { useAutoIdle } from '../hooks/useAutoIdle.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { useVisualViewport } from '../hooks/useVisualViewport.js';
import { channelPath, guildPath, HOME } from '../lib/paths.js';
import { lastChannelFor, rememberChannel } from '../lib/storage.js';
import { loadGuildChannels } from '../store/actions.js';
import { guildChannels, sortDms, sortGuilds } from '../store/selectors.js';
import { useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';
import { HomeView } from './HomeView.js';

export function Shell() {
  useVisualViewport();
  useAutoIdle();
  useDocumentTitle();
  const desktop = useIsDesktop();
  const { guildId, channelId } = useParams();
  const guilds = useApp((state) => state.guilds);
  const channelMap = useApp((state) => state.channels);
  const membersOpen = useUi((state) => state.membersOpen);
  const navigate = useNavigate();
  const channels = useMemo(() => Object.values(channelMap), [channelMap]);

  const inGuild = guildId !== undefined && guildId !== HOME;
  const guild = inGuild ? guilds[guildId] : undefined;
  const channel = channelId ? channelMap[channelId] : undefined;
  const guildHasChannels = inGuild && channels.some((c) => c.guildId === guildId);

  useEffect(() => {
    if (inGuild && guild && !guildHasChannels) void loadGuildChannels(guildId);
  }, [inGuild, guild, guildHasChannels, guildId]);

  useEffect(() => {
    if (guild) rememberChannel('guild', guild.id);
  }, [guild]);

  useEffect(() => {
    useUi.getState().setDrawer(null);
  }, [guildId, channelId]);

  // Alt+Up / Alt+Down walks the channel list on desktop.
  useEffect(() => {
    if (!desktop) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const list = inGuild ? guildChannels(channels, guildId) : sortDms(channels);
      const index = list.findIndex((c) => c.id === channelId);
      const next = list[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        event.preventDefault();
        void navigate(channelPath(next));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desktop, inGuild, guildId, channelId, channels, navigate]);

  if (!guildId) {
    const first = guilds[lastChannelFor('guild') ?? ''] ?? sortGuilds(Object.values(guilds))[0];
    return <Navigate replace to={first ? guildPath(first.id, channels) : `/channels/${HOME}`} />;
  }
  if (inGuild && !guild) return <Navigate replace to="/" />;
  if (inGuild && guild && (!channel || channel.guildId !== guildId) && guildHasChannels) {
    return <Navigate replace to={guildPath(guildId, channels)} />;
  }
  if (guildId === HOME && channelId && (!channel || channel.kind !== 'dm')) {
    return <Navigate replace to={`/channels/${HOME}`} />;
  }

  const activeChannel =
    channel && (inGuild ? channel.guildId === guildId : channel.kind === 'dm')
      ? channel
      : undefined;
  const showMembers = activeChannel?.kind === 'text' && activeChannel.guildId !== null;

  const nav = (
    <div className="nav-pane">
      <GuildRail activeGuildId={guildId} />
      <ChannelSidebar guildId={guildId} activeChannelId={activeChannel?.id ?? null} />
    </div>
  );

  const main = activeChannel ? (
    <ChannelView key={activeChannel.id} channelId={activeChannel.id} />
  ) : guildId === HOME ? (
    <HomeView />
  ) : (
    <div className="empty-state">
      <h2>{guild?.name}</h2>
      <p>Loading channels…</p>
    </div>
  );

  const members =
    showMembers && activeChannel?.guildId ? (
      <MemberList guildId={activeChannel.guildId} channelId={activeChannel.id} />
    ) : null;

  return (
    <div className="app">
      <ConnectionBanner />
      {desktop ? (
        <div className="desktop-layout" data-members={members && membersOpen ? 'open' : 'closed'}>
          {nav}
          <main className="main-pane">{main}</main>
          {members && membersOpen && members}
        </div>
      ) : (
        <DrawerLayout left={nav} right={members}>
          <main className="main-pane">{main}</main>
        </DrawerLayout>
      )}
      <Toasts />
    </div>
  );
}
