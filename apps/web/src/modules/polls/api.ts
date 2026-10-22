import { Message, Poll, type CreatePollBody } from '@harmony/shared';
import { request } from '../../api/client.js';

export const pollsApi = {
  create: (channelId: string, body: CreatePollBody) =>
    request(`/api/channels/${channelId}/polls`, { method: 'POST', body, schema: Message }),
  vote: (messageId: string, optionIds: readonly number[]) =>
    request(`/api/polls/${messageId}/votes`, { method: 'PUT', body: { optionIds }, schema: Poll }),
  close: (messageId: string) =>
    request(`/api/polls/${messageId}/close`, { method: 'POST', schema: Poll }),
};
