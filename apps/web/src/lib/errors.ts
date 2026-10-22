import type { InteractionFailureReason } from '@harmony/shared';

const MESSAGES: Record<string, string> = {
  rate_limited: 'You are going too fast. Try again in a moment.',
  bot_not_allowed: 'Bots cannot use this action.',
  human_only: 'Only people can do this, not bots.',
  forbidden: 'You do not have permission to do that.',
  invalid_url: 'That is not a valid http or https URL.',
  command_conflict: 'Another bot already uses one of those command names in this server.',
  bot_limit: 'You have reached the limit of bots per person. Delete one to create another.',
};

/** A readable sentence for an API error code, falling back to the server's own message. */
export function describeError(code: string, serverMessage: string): string {
  if (code === 'missing_scope') {
    const scope = /lacks the (\S+) scope/.exec(serverMessage)?.[1];
    return scope
      ? `This bot is missing the "${scope}" scope. Turn it on in the bot's settings.`
      : "This bot is missing a required scope. Check the bot's settings.";
  }
  if (code === 'url_not_allowed') {
    const reason = serverMessage.charAt(0).toLowerCase() + serverMessage.slice(1);
    return `Harmony will not call that URL: ${reason}. Use a public http(s) address; an instance admin can allow specific private hosts.`;
  }
  return MESSAGES[code] ?? serverMessage;
}

const FAILURES: Record<InteractionFailureReason, string> = {
  timeout: 'did not answer in time',
  unreachable: 'could not be reached',
  bad_status: 'answered with an error',
  invalid_response: 'sent a reply Harmony could not understand',
  blocked_url: 'has an interactions URL that Harmony refuses to call',
  post_failed: 'could not post its reply (is it in this channel?)',
};

export const describeFailure = (reason: InteractionFailureReason): string => FAILURES[reason];
