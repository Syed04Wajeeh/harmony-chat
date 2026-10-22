import type { Poll, PollOption } from '@harmony/shared';

/** Share of the people who voted that picked this option, 0 to 100. */
export function percentOf(option: PollOption, poll: Poll): number {
  return poll.totalVoters === 0 ? 0 : Math.round((option.votes / poll.totalVoters) * 100);
}

export function myVotes(poll: Poll, userId: string): number[] {
  return poll.options.filter((option) => option.voterIds.includes(userId)).map((o) => o.id);
}

/**
 * The vote set after clicking `optionId`: a single-choice poll switches to it (or retracts when
 * it was already the only vote), a multiple-choice poll toggles it.
 */
export function nextVotes(poll: Poll, current: readonly number[], optionId: number): number[] {
  const has = current.includes(optionId);
  if (poll.multiple) return has ? current.filter((id) => id !== optionId) : [...current, optionId];
  return has ? [] : [optionId];
}
