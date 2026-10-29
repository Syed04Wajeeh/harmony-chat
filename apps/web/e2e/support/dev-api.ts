import type {
  Attachment,
  Bot,
  ChannelSummary,
  GuildSummary,
  Invite,
  Message,
  UserStatus,
} from '@harmony/shared';

/** The first user on an empty e2e database, hence the instance admin (see global-setup.ts). */
export const ADMIN_LOGIN = 'dev@example.com';

/** Talks to a dev-mode server as one user, using the `dev_login` cookie. */
export class DevApi {
  constructor(
    readonly baseUrl: string,
    readonly login: string,
  ) {}

  /** Any endpoint, for the ones the helpers below do not cover. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(method, path, body);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        cookie: `dev_login=${this.login}`,
        origin: new URL(this.baseUrl).origin,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${path} failed: ${String(response.status)} ${await response.text()}`,
      );
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  createRole(
    guildId: string,
    body: { name: string; color?: number; hoist?: boolean; permissions?: string[] },
  ) {
    return this.call<{ id: string }>('POST', `/api/guilds/${guildId}/roles`, body);
  }
  assignRole(guildId: string, userId: string, roleId: string) {
    return this.call('PUT', `/api/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }
  setNickname(guildId: string, userId: string, nickname: string | null) {
    return this.call('PATCH', `/api/guilds/${guildId}/members/${userId}`, { nickname });
  }
  roles(guildId: string) {
    return this.call<{ roles: { id: string; isDefault: boolean }[] }>(
      'GET',
      `/api/guilds/${guildId}/roles`,
    ).then((r) => r.roles);
  }
  putOverwrite(
    channelId: string,
    targetType: 'role' | 'member',
    targetId: string,
    body: { allow?: string[]; deny?: string[] },
  ) {
    return this.call(
      'PUT',
      `/api/channels/${channelId}/overwrites/${targetType}/${targetId}`,
      body,
    );
  }

  me() {
    return this.call<{ id: string; displayName: string; isAdmin: boolean }>('GET', '/api/me');
  }
  setStatus(status: UserStatus) {
    return this.call('PATCH', '/api/me', { status });
  }
  guilds() {
    return this.call<{ guilds: GuildSummary[] }>('GET', '/api/guilds').then((r) => r.guilds);
  }
  createGuild(name: string) {
    return this.call<GuildSummary>('POST', '/api/guilds', { name });
  }
  createPoll(channelId: string, question: string, options: string[], multiple = false) {
    return this.call<Message>('POST', `/api/channels/${channelId}/polls`, {
      question,
      options,
      multiple,
    });
  }
  votePoll(messageId: string, optionIds: number[]) {
    return this.call('PUT', `/api/polls/${messageId}/votes`, { optionIds });
  }
  channels() {
    return this.call<{ channels: ChannelSummary[] }>('GET', '/api/channels').then(
      (r) => r.channels,
    );
  }
  createChannel(
    guildId: string,
    name: string,
    options: { topic?: string; isPrivate?: boolean; kind?: 'text' | 'dashboard' } = {},
  ) {
    return this.call<ChannelSummary>('POST', `/api/guilds/${guildId}/channels`, {
      name,
      ...options,
    });
  }
  addChannelMember(channelId: string, userId: string) {
    return this.call('POST', `/api/channels/${channelId}/members`, { userId });
  }
  createInvite(guildId: string) {
    return this.call<Invite>('POST', `/api/guilds/${guildId}/invites`, {});
  }
  acceptInvite(code: string) {
    return this.call<GuildSummary>('POST', `/api/invites/${code}/accept`);
  }
  openDm(userId: string) {
    return this.call<ChannelSummary>('POST', '/api/dms', { userId });
  }
  send(
    channelId: string,
    content: string,
    extra: { replyToId?: string; attachmentIds?: string[] } = {},
  ) {
    return this.call<Message>('POST', `/api/channels/${channelId}/messages`, { content, ...extra });
  }
  edit(messageId: string, content: string) {
    return this.call<Message>('PATCH', `/api/messages/${messageId}`, { content });
  }
  remove(messageId: string) {
    return this.call('DELETE', `/api/messages/${messageId}`);
  }
  react(messageId: string, emoji: string) {
    return this.call('PUT', `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }
  pin(messageId: string) {
    return this.call<Message>('PUT', `/api/messages/${messageId}/pin`);
  }
  markRead(channelId: string, messageId: string) {
    return this.call('POST', `/api/channels/${channelId}/read`, { messageId });
  }

  createBot(body: {
    name: string;
    scopes?: string[];
    interactionsUrl?: string;
    eventsUrl?: string;
    eventTypes?: string[];
  }) {
    return this.call<{ bot: Bot; token: string; signingSecret: string }>('POST', '/api/bots', body);
  }
  addBotToGuild(guildId: string, botId: string) {
    return this.call('POST', `/api/guilds/${guildId}/bots`, { botId });
  }
  createWebhook(channelId: string, name: string) {
    return this.call<{ id: string; url: string }>('POST', `/api/channels/${channelId}/webhooks`, {
      name,
    });
  }
  deliveries(botId: string) {
    return this.call<{ deliveries: { status: string }[] }>(
      'GET',
      `/api/bots/${botId}/deliveries?limit=100`,
    ).then((r) => r.deliveries);
  }

  /** Posts to a webhook URL path (`/api/webhooks/:id/:token`); the path is the only credential. */
  async execute(path: string, payload: unknown): Promise<void> {
    const response = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new Error(`webhook failed: ${String(response.status)} ${await response.text()}`);
  }

  async upload(name: string, data: Buffer, type = 'image/png'): Promise<Attachment> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type }), name);
    const response = await fetch(`${this.baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { cookie: `dev_login=${this.login}`, origin: new URL(this.baseUrl).origin },
      body: form,
    });
    if (!response.ok)
      throw new Error(`upload failed: ${String(response.status)} ${await response.text()}`);
    return (await response.json()) as Attachment;
  }
}
