import type { InteractionPayload } from '@harmony/shared';
import type { HarmonyClient, InteractionAnswer } from './client.js';
import { defuseMassMentions } from './format.js';
import { stamp, type Person } from './runs.js';

export type Risk = 'low' | 'medium' | 'high';
export type Decision = 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface ApprovalRequest {
  channelId: string;
  title: string;
  details: string;
  risk: Risk;
  timeoutMs: number;
  requiredPermission: string;
  allowMassMentions?: boolean;
  /** Aborts the wait (a cancelled run, a closed client). */
  signal?: AbortSignal | undefined;
}

export interface ApprovalResult {
  decision: Decision;
  by: Person | null;
  at: string;
  messageId: string;
  channelId: string;
  /** Set when the message could not be updated after the decision. */
  warning?: string;
  /** Who cancelled, when the decision is `cancelled` because a person cancelled the run. */
  cancelledBy?: Person | undefined;
}

interface Pending {
  decide: (decision: 'approved' | 'denied', by: Person) => boolean;
}

const RISK_LABEL: Record<Risk, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export const APPROVE = 'approve';
export const DENY = 'deny';

/** The approval message as first posted. */
export function approvalContent(request: ApprovalRequest): string {
  const minutes = Math.max(1, Math.round(request.timeoutMs / 60_000));
  const lines = [
    `**Approval requested** · risk ${RISK_LABEL[request.risk]}`,
    `**${request.title}**`,
  ];
  if (request.details) lines.push('', request.details);
  lines.push(
    '',
    `Needs \`${request.requiredPermission}\` to decide · expires in ${String(minutes)} min`,
  );
  return lines.join('\n');
}

function resolvedContent(
  request: ApprovalRequest,
  decision: Decision,
  by: Person | null,
  at: string,
  cancelledBy?: Person,
): string {
  const who = by ? `${by.displayName} (@${by.login})` : undefined;
  const head =
    decision === 'approved'
      ? `**Approved** by ${who ?? 'someone'}`
      : decision === 'denied'
        ? `**Denied** by ${who ?? 'someone'}`
        : decision === 'timeout'
          ? '**Timed out** with no decision'
          : `**Cancelled**${cancelledBy ? ` (run cancelled by ${cancelledBy.displayName})` : ''}`;
  const lines = [`${head} · ${stamp(at)}`, `**${request.title}**`];
  if (request.details) lines.push('', request.details);
  return lines.join('\n');
}

/**
 * Approval messages the agent is waiting on, keyed by message id. They live in this process, not
 * on the socket: when the socket drops, the entry stays and clicks work again once it is back.
 */
export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly client: HarmonyClient) {}

  get size(): number {
    return this.pending.size;
  }

  async request(
    request: ApprovalRequest,
    hooks: { cancelledBy?: () => Person | undefined } = {},
  ): Promise<ApprovalResult> {
    const release = await this.client.holdGateway();
    try {
      const content = request.allowMassMentions
        ? approvalContent(request)
        : defuseMassMentions(approvalContent(request));
      const message = await this.client.sendMessage(request.channelId, {
        content,
        components: {
          buttons: [
            {
              id: APPROVE,
              label: 'Approve',
              style: 'primary',
              requiredPermission: request.requiredPermission,
              ...(request.risk === 'high' && {
                confirm: {
                  title: 'Approve a high-risk action?',
                  body: request.title.slice(0, 400),
                  confirmLabel: 'Approve',
                },
              }),
            },
            {
              id: DENY,
              label: 'Deny',
              style: 'danger',
              requiredPermission: request.requiredPermission,
            },
          ],
        },
      });

      const outcome = await new Promise<{ decision: Decision; by: Person | null }>((resolve) => {
        let done = false;
        const finish = (decision: Decision, by: Person | null): boolean => {
          if (done) return false;
          done = true;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
          this.pending.delete(message.id);
          resolve({ decision, by });
          return true;
        };
        const timer = setTimeout(() => finish('timeout', null), request.timeoutMs);
        const onAbort = () => finish('cancelled', null);
        if (request.signal?.aborted) onAbort();
        else request.signal?.addEventListener('abort', onAbort);
        this.pending.set(message.id, { decide: (decision, by) => finish(decision, by) });
      });

      const at = new Date().toISOString();
      const result: ApprovalResult = {
        decision: outcome.decision,
        by: outcome.by,
        at,
        messageId: message.id,
        channelId: request.channelId,
        cancelledBy: hooks.cancelledBy?.(),
      };
      try {
        await this.client.editMessage(
          message.id,
          request.allowMassMentions
            ? resolvedContent(request, outcome.decision, outcome.by, at, result.cancelledBy)
            : defuseMassMentions(
                resolvedContent(request, outcome.decision, outcome.by, at, result.cancelledBy),
              ),
          { clearComponents: true },
        );
      } catch (error) {
        result.warning = `The approval message could not be updated (${error instanceof Error ? error.message : 'error'}).`;
      }
      return result;
    } finally {
      release();
    }
  }

  /** A click on an approval message; the server already checked the permission. */
  handleAction(messageId: string, actionId: string, user: Person): InteractionAnswer {
    const entry = this.pending.get(messageId);
    if (!entry || (actionId !== APPROVE && actionId !== DENY)) {
      return {
        type: 'message',
        content: 'This approval is no longer waiting for a decision.',
        ephemeral: true,
      };
    }
    const approved = actionId === APPROVE;
    if (!entry.decide(approved ? 'approved' : 'denied', user)) {
      return { type: 'message', content: 'Someone already decided this.', ephemeral: true };
    }
    return {
      type: 'message',
      content: approved ? 'You approved this. The agent continues.' : 'You denied this.',
      ephemeral: true,
    };
  }
}

export function personOf(interaction: Extract<InteractionPayload, { type: 'action' }>): Person {
  return {
    id: interaction.user.id,
    login: interaction.user.login,
    displayName: interaction.user.displayName,
  };
}
