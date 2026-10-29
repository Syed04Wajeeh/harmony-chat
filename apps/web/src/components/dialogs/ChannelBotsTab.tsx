import type { ChannelSummary, Schedule } from '@harmony/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { attempt, loadGuildMembers, reportError } from '../../store/actions.js';
import { appStore, useApp } from '../../store/store.js';
import { Avatar } from '../Avatar.js';

/** "every 60 s", "every 5 min", "cron 0 3 * * * (UTC)". */
export function describeCadence(schedule: Pick<Schedule, 'every' | 'cron'>): string {
  if (schedule.cron) return `cron ${schedule.cron} (UTC)`;
  const seconds = schedule.every ?? 0;
  if (seconds % 3600 === 0) return `every ${String(seconds / 3600)} h`;
  if (seconds % 60 === 0) return `every ${String(seconds / 60)} min`;
  return `every ${String(seconds)} s`;
}

const STATUS_LABEL = { ok: 'Last run ok', failed: 'Last run failed', skipped: 'Last run skipped' };

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });
}

/** Assign the guild's bots to a channel, switch on feed mode and look after their schedules. */
export function ChannelBotsTab({ channel }: { channel: ChannelSummary }) {
  const guildId = channel.guildId ?? '';
  const memberIds = useApp((state) => state.guildMembers[guildId]);
  const users = useApp((state) => state.users);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);

  const bots = (memberIds ?? []).flatMap((id) => {
    const user = users[id];
    return user?.isBot ? [user] : [];
  });
  const botName = (id: string) => users[id]?.displayName ?? 'A bot';

  useEffect(() => {
    void loadGuildMembers(guildId);
    const controller = new AbortController();
    api
      .channelSchedules(channel.id, controller.signal)
      .then(setSchedules)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) reportError(error, 'Could not load schedules');
      });
    return () => controller.abort();
  }, [guildId, channel.id]);

  async function assign(botId: string, assigned: boolean) {
    const next = assigned
      ? [...channel.botIds, botId]
      : channel.botIds.filter((id) => id !== botId);
    const updated = await attempt(api.setChannelBots(channel.id, next), 'Could not assign the bot');
    if (updated) appStore.getState().upsertChannel({ ...channel, ...updated });
  }

  async function setFeed(botFeed: boolean) {
    const updated = await attempt(
      api.updateChannel(channel.id, { botFeed }),
      'Could not change feed mode',
    );
    if (updated) appStore.getState().upsertChannel({ ...channel, ...updated });
  }

  async function pause(schedule: Schedule, paused: boolean) {
    const updated = await attempt(
      api.setSchedulePaused(schedule.rowId, paused),
      'Could not change the schedule',
    );
    if (updated) {
      setSchedules((list) => list?.map((s) => (s.rowId === updated.rowId ? updated : s)) ?? null);
    }
  }

  async function remove(schedule: Schedule) {
    const done = await attempt(
      api.deleteSchedule(schedule.rowId).then(() => true),
      'Could not delete the schedule',
    );
    if (done) setSchedules((list) => list?.filter((s) => s.rowId !== schedule.rowId) ?? null);
  }

  return (
    <div className="channel-bots-tab">
      <section aria-labelledby="channel-bots-heading">
        <h3 id="channel-bots-heading">Bots in this channel</h3>
        <p className="field-hint">
          Assigned bots show in the channel header and their slash commands come first in
          autocomplete. Assigning grants nothing; permissions still decide what a bot may do.
        </p>
        {bots.length === 0 ? (
          <p className="field-hint">No bots have been added to this server.</p>
        ) : (
          <ul className="bot-assign-list">
            {bots.map((bot) => (
              <li key={bot.id}>
                <label className="switch-row">
                  <span className="bot-assign-who">
                    <Avatar user={bot} size={28} />
                    <strong>{bot.displayName}</strong>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Assign ${bot.displayName}`}
                    checked={channel.botIds.includes(bot.id)}
                    onChange={(event) => void assign(bot.id, event.target.checked)}
                  />
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="channel-feed-heading">
        <h3 id="channel-feed-heading">Feed mode</h3>
        <label className="switch-row">
          <span>
            <strong>Bot feed</strong>
            <small>
              Only bots and people with Manage messages can post. Everyone can still react, press
              buttons and run commands.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Bot feed"
            checked={channel.botFeed}
            onChange={(event) => void setFeed(event.target.checked)}
          />
        </label>
      </section>

      <section aria-labelledby="channel-schedules-heading">
        <h3 id="channel-schedules-heading">Scheduled refreshes</h3>
        <p className="field-hint">
          Bots register these themselves. Pause one to stop it without removing it; a deleted one
          comes back the next time its bot registers.
        </p>
        {schedules === null ? (
          <p className="field-hint">Loading…</p>
        ) : schedules.length === 0 ? (
          <p className="field-hint">No schedules target this channel.</p>
        ) : (
          <ul className="schedule-list">
            {schedules.map((schedule) => (
              <li
                key={schedule.rowId}
                className="schedule-row"
                data-paused={schedule.paused || undefined}
              >
                <div className="schedule-main">
                  <strong>
                    {botName(schedule.botId)} · {schedule.id}
                  </strong>
                  <small>
                    {describeCadence(schedule)}
                    {schedule.panelKey ? ` · panel ${schedule.panelKey}` : ''}
                  </small>
                  <small>
                    {schedule.paused ? 'Paused' : `Next run ${formatTime(schedule.nextRunAt)}`}
                    {schedule.lastStatus && (
                      <>
                        {' · '}
                        <span className="schedule-status" data-status={schedule.lastStatus}>
                          {STATUS_LABEL[schedule.lastStatus]}
                          {schedule.lastError ? ` (${schedule.lastError})` : ''}
                        </span>
                      </>
                    )}
                  </small>
                </div>
                <div className="schedule-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void pause(schedule, !schedule.paused)}
                  >
                    {schedule.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    className="button button-danger-outline"
                    aria-label={`Delete schedule ${schedule.id}`}
                    onClick={() => void remove(schedule)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
