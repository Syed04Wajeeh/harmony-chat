import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { attempt } from '../../store/actions.js';
import { CheckIcon, CopyIcon } from '../Icons.js';
import { Modal } from '../Overlay.js';

interface Props {
  guildId: string;
  guildName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteDialog({ guildId, guildName, open, onOpenChange }: Props) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void attempt(api.createInvite(guildId), 'Could not create an invite').then((invite) => {
      if (invite && !cancelled) setLink(`${window.location.origin}/invite/${invite.code}`);
    });
    return () => {
      cancelled = true;
    };
  }, [open, guildId]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Invite people to ${guildName}`}
      description="Anyone signed in to this Harmony can use this link to join."
    >
      <div className="copy-row">
        <input
          readOnly
          aria-label="Invite link"
          value={link ?? 'Creating link…'}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button className="button button-primary" disabled={!link} onClick={() => void copy()}>
          {copied ? <CheckIcon width={18} height={18} /> : <CopyIcon width={18} height={18} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  );
}
