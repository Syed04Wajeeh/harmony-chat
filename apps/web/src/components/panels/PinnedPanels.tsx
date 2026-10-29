import { useEffect, useState } from 'react';
import { loadPanels, panelsOf, usePanels } from '../../store/panels.js';
import { ChevronDownIcon, PinIcon } from '../Icons.js';
import { PanelCard } from './PanelCard.js';

const NONE: never[] = [];

/** Panels pinned in a text channel, in a strip above the messages that can be folded away. */
export function PinnedPanels({ channelId }: { channelId: string }) {
  const panels = usePanels(panelsOf(channelId));
  const [open, setOpen] = useState(true);
  useEffect(() => {
    void loadPanels(channelId);
  }, [channelId]);

  const pinned = (panels ?? NONE).filter((panel) => panel.pinned);
  if (pinned.length === 0) return null;
  return (
    <section className="pinned-panels" aria-label="Pinned panels" data-open={open || undefined}>
      <button
        type="button"
        className="pinned-panels-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PinIcon width={16} height={16} />
        <span>
          {open
            ? pinned.length === 1
              ? 'Pinned panel'
              : `${String(pinned.length)} pinned panels`
            : pinned.map((panel) => panel.view.title ?? panel.key).join(', ')}
        </span>
        <ChevronDownIcon width={16} height={16} className="pinned-panels-chevron" />
      </button>
      {open && (
        <div className="pinned-panels-body">
          {pinned.map((panel) => (
            <PanelCard key={panel.id} panel={panel} />
          ))}
        </div>
      )}
    </section>
  );
}
