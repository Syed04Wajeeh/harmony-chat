import type { Message } from '@harmony/shared';
import { Fragment, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';
import { webModules } from './index.js';
import { enabledWebModules } from './registry.js';
import type { ComposerAction, DialogProps, MessageAction, WebModule } from './types.js';

/** The web modules whose server module is on for a guild (all of them in a DM). */
export function useEnabledModules(guildId: string | null): readonly WebModule[] {
  const modules = useApp((state) => (guildId ? state.guildModules[guildId] : undefined));
  return useMemo(
    () => enabledWebModules(webModules, modules, guildId !== null),
    [modules, guildId],
  );
}

export function useGuildOf(channelId: string): string | null {
  return useApp((state) => state.channels[channelId]?.guildId ?? null);
}

type MessageSlot = 'messageFooter' | 'messageToolbar';

function MessageSlots({ slot, message }: { slot: MessageSlot; message: Message }) {
  const modules = useEnabledModules(useGuildOf(message.channelId));
  return (
    <>
      {modules.map(({ id, [slot]: Slot }) => (Slot ? <Slot key={id} message={message} /> : null))}
    </>
  );
}

/** Data a module attached to the message, rendered by the module's own accessory. */
export function MessageAccessories({ message }: { message: Message }) {
  const modules = useEnabledModules(useGuildOf(message.channelId));
  if (!message.modules) return null;
  return (
    <>
      {modules.map((module) => {
        const raw = message.modules?.[module.id];
        const Accessory = module.messageAccessory as
          ComponentType<{ message: Message; data: unknown }> | undefined;
        if (raw === undefined || !Accessory) return null;
        const parsed = module.messageData
          ? module.messageData.safeParse(raw)
          : { success: true, data: raw };
        return parsed.success ? (
          <Accessory key={module.id} message={message} data={parsed.data} />
        ) : null;
      })}
    </>
  );
}

export const MessageFooters = ({ message }: { message: Message }) => (
  <MessageSlots slot="messageFooter" message={message} />
);

export const MessageToolbarSlots = ({ message }: { message: Message }) => (
  <MessageSlots slot="messageToolbar" message={message} />
);

export function MessageSheetSlots({ message, close }: { message: Message; close: () => void }) {
  const modules = useEnabledModules(useGuildOf(message.channelId));
  return (
    <>
      {modules.map(({ id, messageSheet: Section }) =>
        Section ? <Section key={id} message={message} close={close} /> : null,
      )}
    </>
  );
}

export interface ResolvedMessageAction {
  id: string;
  icon: MessageAction['icon'];
  label: string;
  onSelect: () => void;
}

export function useMessageActions(message: Message): ResolvedMessageAction[] {
  const modules = useEnabledModules(useGuildOf(message.channelId));
  return modules.flatMap((module) =>
    (module.messageActions ?? []).map((action) => ({
      id: `${module.id}.${action.id}`,
      icon: action.icon,
      label: typeof action.label === 'function' ? action.label(message) : action.label,
      onSelect: () => action.onSelect(message),
    })),
  );
}

export function useComposerActions(guildId: string | null): (ComposerAction & { key: string })[] {
  const modules = useEnabledModules(guildId);
  return useMemo(
    () =>
      modules.flatMap((module) =>
        (module.composerActions ?? []).map((action) => ({
          ...action,
          key: `${module.id}.${action.id}`,
        })),
      ),
    [modules],
  );
}

/** Holds the dialog a composer action opened. */
export function useComposerDialog(): {
  dialog: ReactNode;
  open: (Dialog: ComponentType<DialogProps>, props: Omit<DialogProps, 'onClose'>) => void;
} {
  const [state, setState] = useState<{
    Dialog: ComponentType<DialogProps>;
    props: Omit<DialogProps, 'onClose'>;
  } | null>(null);
  return {
    dialog: state ? (
      <Fragment key="dialog">
        <state.Dialog {...state.props} onClose={() => setState(null)} />
      </Fragment>
    ) : null,
    open: (Dialog, props) => setState({ Dialog, props }),
  };
}

/** Header buttons: each module's own actions, then a toggle for each module panel. */
export function ChannelHeaderSlots({ channelId }: { channelId: string }) {
  const guildId = useGuildOf(channelId);
  const modules = useEnabledModules(guildId);
  const open = useUi((state) => state.channelPanel);
  const setOpen = useUi((state) => state.setChannelPanel);
  return (
    <>
      {modules.map((module) => {
        const Actions = module.channelHeaderActions;
        const panel = module.channelPanel;
        return (
          <Fragment key={module.id}>
            {Actions && <Actions channelId={channelId} guildId={guildId} />}
            {panel && (
              <button
                className="icon-button"
                aria-label={panel.label}
                aria-pressed={open === module.id}
                onClick={() => setOpen(open === module.id ? null : module.id)}
              >
                <panel.icon />
              </button>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export function ChannelPanels({ channelId, label }: { channelId: string; label: string }) {
  const guildId = useGuildOf(channelId);
  const modules = useEnabledModules(guildId);
  const open = useUi((state) => state.channelPanel);
  const setOpen = useUi((state) => state.setChannelPanel);
  const module = modules.find((candidate) => candidate.id === open && candidate.channelPanel);
  const panel = module?.channelPanel;
  if (!panel) return null;
  return (
    <panel.Panel
      channelId={channelId}
      guildId={guildId}
      channelLabel={label}
      onClose={() => setOpen(null)}
    />
  );
}
