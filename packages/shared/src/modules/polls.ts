import { z } from 'zod';
import { Id } from '../chat.js';

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_QUESTION_LENGTH = 300;
export const POLL_MAX_OPTION_LENGTH = 100;
/** Separates the options in the `/poll options:` text. */
export const POLL_OPTION_SEPARATOR = '|';

export const PollOption = z.object({
  /** Position-independent id, unique within the poll. */
  id: z.number().int(),
  label: z.string(),
  votes: z.number().int(),
  voterIds: z.array(Id),
});
export type PollOption = z.infer<typeof PollOption>;

/** What `message.modules.polls` carries. */
export const Poll = z.object({
  multiple: z.boolean(),
  closed: z.boolean(),
  closedAt: z.iso.datetime().nullable(),
  /** Distinct people who voted, which is also the denominator for percentages. */
  totalVoters: z.number().int(),
  options: z.array(PollOption),
});
export type Poll = z.infer<typeof Poll>;

const PollOptionLabel = z.string().trim().min(1).max(POLL_MAX_OPTION_LENGTH);

export const CreatePollBody = z.object({
  question: z.string().trim().min(1).max(POLL_MAX_QUESTION_LENGTH),
  options: z
    .array(PollOptionLabel)
    .min(POLL_MIN_OPTIONS)
    .max(POLL_MAX_OPTIONS)
    .refine((labels) => new Set(labels.map((l) => l.toLowerCase())).size === labels.length, {
      message: 'Options must be different',
    }),
  multiple: z.boolean().default(false),
});
export type CreatePollBody = z.input<typeof CreatePollBody>;

export const PollParams = z.object({ id: Id });

/** Replaces the caller's votes: one id for a single-choice poll, any number for multiple choice, none to retract. */
export const VotePollBody = z.object({
  optionIds: z.array(z.number().int()).max(POLL_MAX_OPTIONS),
});
export type VotePollBody = z.infer<typeof VotePollBody>;

export const PollSettings = z.object({
  /** When off, people can only create single-choice polls. */
  allowMultipleChoice: z.boolean().default(true).meta({
    title: 'Allow multiple choice',
    description: 'Let people create polls where each voter can pick more than one option.',
  }),
});
export type PollSettings = z.infer<typeof PollSettings>;

/** Published on the channel topic whenever votes or the closed state change. */
export const PollsUpdatedFrame = z.object({
  type: z.literal('polls.updated'),
  channelId: Id,
  messageId: Id,
  poll: Poll,
});
export type PollsUpdatedFrame = z.infer<typeof PollsUpdatedFrame>;

/** Client to server: the WebSocket twin of `PUT /api/polls/:id/votes`. */
export const PollsVoteFrame = z.object({
  type: z.literal('polls.vote'),
  messageId: Id,
  optionIds: VotePollBody.shape.optionIds,
});
export type PollsVoteFrame = z.infer<typeof PollsVoteFrame>;

/** `a|b|c` to its labels: trimmed, blanks dropped. Shared by the slash command and the dialog. */
export function splitPollOptions(text: string): string[] {
  return text
    .split(POLL_OPTION_SEPARATOR)
    .map((label) => label.trim())
    .filter(Boolean);
}
