import type { Message } from '@harmony/shared';
import type { ComponentType, SVGProps } from 'react';

/** What the client needs from a schema; zod schemas fit. */
export interface Schema<T> {
  safeParse: (data: unknown) => { success: true; data: T } | { success: false };
}

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** What a module's frame reducer may change. */
export interface ModuleStoreApi {
  patchMessage: (
    channelId: string,
    messageId: string,
    update: (message: Message) => Message,
  ) => void;
}

/** A frame the server sends for this module: validated, then applied to the store. */
export interface ModuleFrameDef<T = unknown> {
  type: string;
  schema: Schema<T>;
  reduce: (frame: T, store: ModuleStoreApi) => void;
}

/** Erases the frame type so differently typed frames fit in one list. */
export function defineFrame<T>(frame: ModuleFrameDef<T>): ModuleFrameDef {
  return frame as unknown as ModuleFrameDef;
}

export interface MessageAction {
  id: string;
  icon: IconComponent;
  label: string | ((message: Message) => string);
  onSelect: (message: Message) => void;
}

export interface DialogProps {
  channelId: string;
  guildId: string | null;
  onClose: () => void;
}

export interface ComposerContext {
  channelId: string;
  guildId: string | null;
  /** Mounts a dialog above the composer until it calls `onClose`. */
  openDialog: (Dialog: ComponentType<DialogProps>) => void;
}

export interface ComposerAction {
  id: string;
  icon: IconComponent;
  label: string;
  /** Hidden for people who lack this permission here (a module's own key, such as `polls.create`). */
  permission?: string;
  onSelect: (context: ComposerContext) => void;
}

export interface ChannelSlotProps {
  channelId: string;
  guildId: string | null;
}

export interface ChannelPanelProps extends ChannelSlotProps {
  channelLabel: string;
  onClose: () => void;
}

/** A panel beside the messages that a header button opens and closes. */
export interface ChannelPanel {
  label: string;
  icon: IconComponent;
  Panel: ComponentType<ChannelPanelProps>;
}

/**
 * What a module adds to the web client. Every part is optional and appears only where the
 * module is enabled: the client hides the slots of modules a guild has switched off.
 */
export interface WebModule<TData = unknown> {
  /** The id of the server module this belongs to. */
  id: string;
  /** Frames from the server (`<id>.<name>`). */
  frames?: readonly ModuleFrameDef[];
  /** Shape of `message.modules[id]`; data that does not fit is ignored. */
  messageData?: Schema<TData>;
  /** Rendered under the message when `message.modules[id]` exists and fits `messageData`. */
  messageAccessory?: ComponentType<{ message: Message; data: TData }>;
  /** Rendered under every message, for modules whose data lives in core fields (reactions). */
  messageFooter?: ComponentType<{ message: Message }>;
  /** Buttons in the desktop hover toolbar. */
  messageToolbar?: ComponentType<{ message: Message }>;
  /** A section of the phone action sheet. */
  messageSheet?: ComponentType<{ message: Message; close: () => void }>;
  /** Entries in the message "more" menu and in the phone action sheet. */
  messageActions?: readonly MessageAction[];
  composerActions?: readonly ComposerAction[];
  channelHeaderActions?: ComponentType<ChannelSlotProps>;
  channelPanel?: ChannelPanel;
  /** Extra content in this module's card on Server settings, Modules. */
  guildSettingsPanel?: ComponentType<{ guildId: string }>;
  /** A page in User settings. */
  userSettingsPanel?: { label: string; Panel: ComponentType };
}

/** Erases the data type so differently typed modules fit in one list. */
export function defineWebModule<TData = unknown>(module: WebModule<TData>): WebModule {
  return module as WebModule;
}
