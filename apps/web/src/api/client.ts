import {
  ErrorResponse,
  ListChannelsResponse,
  ListMessagesResponse,
  User,
  type Channel,
  type Message,
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

async function get<T>(
  schema: { parse(data: unknown): T },
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, { signal: signal ?? null });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = ErrorResponse.safeParse(body);
    throw new ApiError(
      res.status,
      error.success ? error.data.code : 'http_error',
      error.success ? error.data.message : `Request failed (${res.status})`,
    );
  }
  return schema.parse(body);
}

export const fetchMe = (signal?: AbortSignal): Promise<User> => get(User, '/api/me', signal);

export const fetchChannels = async (signal?: AbortSignal): Promise<Channel[]> =>
  (await get(ListChannelsResponse, '/api/channels', signal)).channels;

export function fetchMessages(
  channelId: string,
  options: { before?: string; signal?: AbortSignal } = {},
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const query = options.before ? `?before=${options.before}` : '';
  return get(ListMessagesResponse, `/api/channels/${channelId}/messages${query}`, options.signal);
}
