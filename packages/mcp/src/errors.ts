import { HarmonyError } from './client.js';

/** Raised by tools for problems that are the caller's to fix (bad channel name, rate limit). */
export class ToolError extends Error {}

/** Turns Harmony error codes into advice an agent (or the person behind it) can act on. */
export function explain(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  if (!(error instanceof HarmonyError)) {
    return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const detail = error.message;
  switch (error.code) {
    case 'unreachable':
    case 'timeout':
      return `${detail} Check that HARMONY_URL is right and the server is running.`;
    case 'invalid_token':
      return 'Harmony rejected the bot token. It may have been rotated or the bot deleted; create or rotate the token in Harmony (Settings > Bots) and update HARMONY_BOT_TOKEN.';
    case 'missing_scope':
      return `The bot token lacks a scope this needs (${detail}). Scopes: messages.read for reading, searching and waiting; messages.write for sending; reactions.write for reactions; channels.read for listing servers and channels and resolving #names. Ask the bot's owner to add it in Settings > Bots.`;
    case 'forbidden':
      return `The bot cannot access that. It is probably not in that server or channel (${detail}). A server manager must add the bot to the server (Server settings > Bots).`;
    case 'missing_permission':
      return `The bot is a member but lacks a permission: ${detail} A server admin can grant it to a role the bot has.`;
    case 'human_only':
    case 'bot_not_allowed':
      return `Harmony does not allow bots to do this (${error.code}).`;
    case 'rate_limited':
      return `Harmony is rate limiting this bot${error.retryAfterSeconds ? `; retry in ${error.retryAfterSeconds}s` : ''}. Slow down.`;
    case 'channel_not_found':
    case 'message_not_found':
    case 'guild_not_found':
      return `Not found: ${detail} Check the id with list_channels.`;
    case 'channel_archived':
      return 'That channel is archived and read-only.';
    case 'invalid_reply':
      return 'replyTo must be a message id in the same channel that has not been deleted.';
    case 'invalid_emoji':
    case 'reaction_limit':
      return `The reaction was refused: ${detail}`;
    case 'module_disabled':
      return `A server module is switched off here: ${detail}`;
    case 'invalid_request':
      return `Harmony rejected the request as invalid: ${detail}`;
    default:
      return `Harmony error ${error.code}${error.status ? ` (HTTP ${error.status})` : ''}: ${detail}`;
  }
}
