import type {
  Attachment,
  ChannelSummary,
  GuildSummary,
  Invite,
  Message,
  UserStatus,
} from '@harmony/shared';

/** Talks to a dev-mode server as one user, using the `dev_login` cookie. */
export class DevApi {
  constructor(
    readonly baseUrl: string,
    readonly login: string,
  ) {}

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

  me() {
    return this.call<{ id: string; displayName: string }>('GET', '/api/me');
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
  channels() {
    return this.call<{ channels: ChannelSummary[] }>('GET', '/api/channels').then(
      (r) => r.channels,
    );
  }
  createChannel(
    guildId: string,
    name: string,
    options: { topic?: string; isPrivate?: boolean } = {},
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
