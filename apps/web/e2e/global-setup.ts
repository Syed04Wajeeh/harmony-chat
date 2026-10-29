import { DevApi } from './support/dev-api.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:15173';

/**
 * The specs sign in brand-new people and expect them to land in a server. Newcomers join nothing
 * unless an admin picked a lobby, so make the first user's starter server the lobby. Only possible
 * on an empty database, where the first person to arrive is the instance admin; on a reused
 * database the setting is whatever it was.
 */
export default async function globalSetup(): Promise<void> {
  const admin = new DevApi(baseURL, 'dev@example.com');
  const me = await admin.request<{ isAdmin: boolean }>('GET', '/api/me');
  if (!me.isAdmin) return;
  const lobby = await admin.request<{ guildId: string | null }>('GET', '/api/admin/lobby');
  if (lobby.guildId) return;
  const [guild] = await admin.guilds();
  if (guild) await admin.request('PUT', '/api/admin/lobby', { guildId: guild.id });
}
