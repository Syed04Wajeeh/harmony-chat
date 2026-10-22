import { RealtimeClient, realtimeUrl } from '../api/realtime.js';

let client: RealtimeClient | null = null;

export function getRealtime(): RealtimeClient {
  client ??= new RealtimeClient(realtimeUrl());
  return client;
}
