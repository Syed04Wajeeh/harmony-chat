import {
  Attachment,
  ErrorResponse,
  Guild,
  GuildMembersResponse,
  GuildSummary,
  ChannelSummary,
  Invite,
  InvitePreview,
  ListChannelsResponse,
  ListGuildsResponse,
  ListMessagesResponse,
  ListUsersResponse,
  Me,
  MembersResponse,
  Message,
  PinsResponse,
  PresenceResponse,
  ReadState,
  type CreateChannelBody,
  type UpdateGuildBody,
  type UserStatus,
} from '@harmony/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Schema<T> {
  parse(data: unknown): T;
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema?: Schema<T>;
  signal?: AbortSignal | undefined;
}

export async function parseError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const parsed = ErrorResponse.safeParse(body);
  if (parsed.success) return new ApiError(res.status, parsed.data.code, parsed.data.message);
  const message =
    res.status === 413 ? 'That file is too large' : `Request failed (${String(res.status)})`;
  return new ApiError(res.status, 'http_error', message);
}

async function request<T = void>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, schema, signal } = options;
  const res = await fetch(path, {
    method,
    signal: signal ?? null,
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204 || !schema) return undefined as T;
  return schema.parse(await res.json());
}

const enc = encodeURIComponent;

export const api = {
  me: (signal?: AbortSignal) => request('/api/me', { schema: Me, signal }),
  setStatus: (status: UserStatus) =>
    request('/api/me', { method: 'PATCH', body: { status }, schema: Me }),
  users: async (signal?: AbortSignal) =>
    (await request('/api/users', { schema: ListUsersResponse, signal })).users,
  presence: async (signal?: AbortSignal) =>
    (await request('/api/presence', { schema: PresenceResponse, signal })).presence,

  guilds: async (signal?: AbortSignal) =>
    (await request('/api/guilds', { schema: ListGuildsResponse, signal })).guilds,
  createGuild: (name: string) =>
    request('/api/guilds', { method: 'POST', body: { name }, schema: GuildSummary }),
  updateGuild: (id: string, body: UpdateGuildBody) =>
    request(`/api/guilds/${id}`, { method: 'PATCH', body, schema: Guild }),
  deleteGuild: (id: string) => request(`/api/guilds/${id}`, { method: 'DELETE' }),
  leaveGuild: (id: string) => request(`/api/guilds/${id}/leave`, { method: 'POST' }),
  guildChannels: async (id: string, signal?: AbortSignal) =>
    (await request(`/api/guilds/${id}/channels`, { schema: ListChannelsResponse, signal }))
      .channels,
  guildMembers: async (id: string, signal?: AbortSignal) =>
    (await request(`/api/guilds/${id}/members`, { schema: GuildMembersResponse, signal })).members,
  createInvite: (guildId: string) =>
    request(`/api/guilds/${guildId}/invites`, { method: 'POST', body: {}, schema: Invite }),
  invitePreview: (code: string, signal?: AbortSignal) =>
    request(`/api/invites/${enc(code)}`, { schema: InvitePreview, signal }),
  acceptInvite: (code: string) =>
    request(`/api/invites/${enc(code)}/accept`, { method: 'POST', schema: GuildSummary }),

  channels: async (signal?: AbortSignal) =>
    (await request('/api/channels', { schema: ListChannelsResponse, signal })).channels,
  createChannel: (guildId: string, body: CreateChannelBody) =>
    request(`/api/guilds/${guildId}/channels`, {
      method: 'POST',
      body,
      schema: ChannelSummary,
    }),
  openDm: (userId: string) =>
    request('/api/dms', { method: 'POST', body: { userId }, schema: ChannelSummary }),
  channelMembers: async (id: string, signal?: AbortSignal) =>
    (await request(`/api/channels/${id}/members`, { schema: MembersResponse, signal })).members,
  addChannelMember: (id: string, userId: string) =>
    request(`/api/channels/${id}/members`, { method: 'POST', body: { userId } }),
  markRead: (channelId: string, messageId: string) =>
    request(`/api/channels/${channelId}/read`, {
      method: 'POST',
      body: { messageId },
      schema: ReadState,
    }),

  messages: (
    channelId: string,
    options: { before?: string; limit?: number; signal?: AbortSignal } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.before) query.set('before', options.before);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : '';
    return request(`/api/channels/${channelId}/messages${suffix}`, {
      schema: ListMessagesResponse,
      signal: options.signal,
    });
  },
  editMessage: (id: string, content: string) =>
    request(`/api/messages/${id}`, { method: 'PATCH', body: { content }, schema: Message }),
  deleteMessage: (id: string) => request(`/api/messages/${id}`, { method: 'DELETE' }),
  addReaction: (id: string, emoji: string) =>
    request(`/api/messages/${id}/reactions/${enc(emoji)}`, { method: 'PUT' }),
  removeReaction: (id: string, emoji: string) =>
    request(`/api/messages/${id}/reactions/${enc(emoji)}`, { method: 'DELETE' }),
  pin: (id: string) => request(`/api/messages/${id}/pin`, { method: 'PUT', schema: Message }),
  unpin: (id: string) => request(`/api/messages/${id}/pin`, { method: 'DELETE', schema: Message }),
  pins: async (channelId: string, signal?: AbortSignal) =>
    (await request(`/api/channels/${channelId}/pins`, { schema: PinsResponse, signal })).messages,
  search: (options: { q: string; channelId?: string; before?: string; signal?: AbortSignal }) => {
    const query = new URLSearchParams({ q: options.q });
    if (options.channelId) query.set('channelId', options.channelId);
    if (options.before) query.set('before', options.before);
    return request(`/api/search?${query.toString()}`, {
      schema: ListMessagesResponse,
      signal: options.signal,
    });
  },
};

/** Uploads one file with progress. Resolves with the stored attachment. */
export function uploadFile(
  file: File,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      const body: unknown = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = Attachment.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError(xhr.status, 'bad_response', 'Unexpected upload response'));
        return;
      }
      const error = ErrorResponse.safeParse(body);
      reject(
        error.success
          ? new ApiError(xhr.status, error.data.code, error.data.message)
          : new ApiError(
              xhr.status,
              'http_error',
              xhr.status === 413 ? 'That file is too large' : 'Upload failed',
            ),
      );
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Network error during upload'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}
