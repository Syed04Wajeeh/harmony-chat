import { MAX_MESSAGE_LENGTH, type GuildCommand, type Message, type User } from '@harmony/shared';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useGuildCommands } from '../hooks/useGuildCommands.js';
import { useGuildAccess } from '../hooks/usePermission.js';
import { useCoarsePointer } from '../hooks/useMediaQuery.js';
import type { Uploads } from '../hooks/useUploads.js';
import {
  buildInvocation,
  findSlashQuery,
  splitSlashInput,
  suggestCommands,
} from '../lib/commands.js';
import { encodeMentions, findMentionQuery, insertMention, suggestUsers } from '../lib/mentions.js';
import { formatBytes } from '../lib/time.js';
import { invokeCommand, sendMessage } from '../store/actions.js';
import { useApp } from '../store/store.js';
import { getRealtime } from '../store/connection.js';
import { Avatar } from './Avatar.js';
import { CommandFields, type ActiveCommand } from './CommandFields.js';
import { EmojiPickerButton } from './EmojiPicker.js';
import { CloseIcon, FileIcon, PaperclipIcon, PlusIcon, SendIcon, SmileIcon } from './Icons.js';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './Menu.js';
import { useComposerActions, useComposerDialog } from '../modules/slots.js';

const TYPING_THROTTLE_MS = 3000;
const MAX_HEIGHT_PX = 160;

interface Draft {
  text: string;
  mentions: Map<string, string>;
}
const drafts = new Map<string, Draft>();

interface Props {
  channelId: string;
  /** Null in direct messages, where there are no slash commands. */
  guildId: string | null;
  placeholder: string;
  replyTo: Message | null;
  replyToName: string | null;
  onCancelReply: () => void;
  onEditLast: () => void;
  uploads: Uploads;
  candidates: readonly User[];
  me: User;
}

export function Composer({
  channelId,
  guildId,
  placeholder,
  replyTo,
  replyToName,
  onCancelReply,
  onEditLast,
  uploads,
  candidates,
  me,
}: Props) {
  const coarse = useCoarsePointer();
  const access = useGuildAccess(guildId ?? '', guildId ? channelId : undefined);
  const canAttach = guildId === null || !access.loaded || access.has('attach_files');
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const mentions = useRef(new Map<string, string>(drafts.get(channelId)?.mentions));
  const [text, setText] = useState(drafts.get(channelId)?.text ?? '');
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();
  const { commands, refresh } = useGuildCommands(guildId);
  const [active, setActive] = useState<ActiveCommand | null>(null);
  const channelMap = useApp((state) => state.channels);
  const guildChannels = useMemo(
    () =>
      Object.values(channelMap)
        .filter((c) => guildId !== null && c.guildId === guildId && c.kind === 'text')
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [channelMap, guildId],
  );
  const members = useMemo(() => [me, ...candidates], [me, candidates]);
  const composerActions = useComposerActions(guildId).filter(
    (action) => !action.permission || !access.loaded || access.has(action.permission),
  );
  const composerDialog = useComposerDialog();

  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  useEffect(() => {
    return () => {
      if (textRef.current)
        drafts.set(channelId, { text: textRef.current, mentions: mentions.current });
      else drafts.delete(channelId);
    };
  }, [channelId]);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, MAX_HEIGHT_PX))}px`;
  }, [text]);

  useEffect(() => {
    if (replyTo) field.current?.focus();
  }, [replyTo]);

  const slashQuery = active || dismissed || !guildId ? null : findSlashQuery(text);
  const commandMatches = slashQuery === null ? [] : suggestCommands(commands, slashQuery);
  const showCommands = commandMatches.length > 0;

  const query = active || dismissed || showCommands ? null : findMentionQuery(text, caret);
  const suggestions = query ? suggestUsers(candidates, query.query) : [];
  const showSuggestions = suggestions.length > 0;

  const canSend =
    active !== null ||
    (!uploads.busy && (text.trim().length > 0 || uploads.attachments.length > 0));

  const focusText = () => requestAnimationFrame(() => field.current?.focus());

  function startCommand(command: GuildCommand, rest = '') {
    const first = command.options[0];
    setActive({
      command,
      values: first?.type === 'string' && rest.trim() ? { [first.name]: rest.trim() } : {},
      errors: {},
    });
    setText('');
    setActiveIndex(0);
  }

  function cancelCommand() {
    setActive(null);
    focusText();
  }

  function runCommand() {
    if (!active) return;
    const result = buildInvocation(active.command, active.values);
    if (!result.ok) {
      setActive({ ...active, errors: result.errors });
      return;
    }
    if (invokeCommand(channelId, active.command.name, result.options)) {
      setActive(null);
      focusText();
    }
  }

  function submit() {
    if (active) return runCommand();
    if (!canSend) return;
    sendMessage({
      channelId,
      content: encodeMentions(text.trim(), mentions.current),
      replyToId: replyTo?.id ?? null,
      attachments: uploads.attachments,
    });
    setText('');
    mentions.current = new Map();
    drafts.delete(channelId);
    uploads.clear();
    onCancelReply();
  }

  function choose(user: User) {
    if (!query) return;
    const next = insertMention(text, query, user.displayName);
    mentions.current.set(`@${user.displayName}`, user.id);
    setText(next.text);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }

  function chooseCommand(command: GuildCommand) {
    startCommand(command);
  }

  function onChange(value: string, selection: number) {
    const typed = guildId ? splitSlashInput(value) : null;
    const known = typed && commands.find((command) => command.name === typed.name);
    if (known) return startCommand(known, typed.rest);
    if (guildId && value.startsWith('/') && !text.startsWith('/')) refresh();
    setText(value);
    setCaret(selection);
    setDismissed(false);
    setActiveIndex(0);
    const now = Date.now();
    if (value.trim() && now - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = now;
      getRealtime().send({ type: 'typing', channelId });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showCommands) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + step + commandMatches.length) % commandMatches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const command = commandMatches[activeIndex];
        if (command) chooseCommand(command);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (showSuggestions) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const user = suggestions[activeIndex];
        if (user) choose(user);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === 'Escape' && replyTo) {
      onCancelReply();
      return;
    }
    if (event.key === 'ArrowUp' && !coarse && text === '' && !event.shiftKey) {
      event.preventDefault();
      onEditLast();
      return;
    }
    // Phones have an explicit send button; Enter there is a newline.
    if (event.key === 'Enter' && !event.shiftKey && !coarse && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function onPaste(event: ClipboardEvent) {
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      uploads.add(files);
    }
  }

  function insertEmoji(emoji: string) {
    const el = field.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  return (
    <div className="composer">
      {replyTo && (
        <div className="composer-reply">
          <span>
            Replying to <strong>{replyToName ?? 'someone'}</strong>
          </span>
          <button
            className="icon-button icon-button-small"
            aria-label="Cancel reply"
            onClick={onCancelReply}
          >
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      )}
      {uploads.items.length > 0 && (
        <ul className="upload-chips" aria-label="Attachments">
          {uploads.items.map((item) => (
            <li key={item.id} className="upload-chip" data-status={item.status}>
              {item.previewUrl ? (
                <img src={item.previewUrl} alt="" />
              ) : (
                <span className="upload-chip-icon">
                  <FileIcon width={22} height={22} />
                </span>
              )}
              <span className="upload-chip-text">
                <span className="upload-chip-name">{item.file.name}</span>
                <span className="upload-chip-meta">
                  {item.status === 'error' ? (item.error ?? 'Failed') : formatBytes(item.file.size)}
                </span>
              </span>
              {item.status === 'uploading' && (
                <progress
                  className="upload-progress"
                  max={1}
                  value={item.progress}
                  aria-label={`Uploading ${item.file.name}`}
                />
              )}
              <button
                className="icon-button icon-button-small"
                aria-label={
                  item.status === 'uploading'
                    ? `Cancel upload of ${item.file.name}`
                    : `Remove ${item.file.name}`
                }
                onClick={() => uploads.remove(item.id)}
              >
                <CloseIcon width={16} height={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {active && (
        <p className="command-hint">
          <strong>{active.command.botName}</strong> · {active.command.description}
        </p>
      )}
      <div className="composer-box">
        {showCommands && (
          <ul id={listId} className="command-list" role="listbox" aria-label="Slash commands">
            {commandMatches.map((command, index) => (
              <li
                key={command.name}
                id={`${listId}-${command.name}`}
                role="option"
                aria-selected={index === activeIndex}
                onPointerDown={(event) => {
                  event.preventDefault();
                  chooseCommand(command);
                }}
              >
                <span className="command-name">/{command.name}</span>
                <span className="command-desc">{command.description}</span>
                <span className="command-bot">{command.botName}</span>
              </li>
            ))}
          </ul>
        )}
        {showSuggestions && (
          <ul id={listId} className="mention-list" role="listbox" aria-label="Mention suggestions">
            {suggestions.map((user, index) => (
              <li
                key={user.id}
                id={`${listId}-${user.id}`}
                role="option"
                aria-selected={index === activeIndex}
                onPointerDown={(event) => {
                  event.preventDefault();
                  choose(user);
                }}
              >
                <Avatar user={user} size={28} />
                <span>{user.displayName}</span>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            uploads.add([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        {composerActions.length > 0 && !active && (
          <Menu>
            <MenuTrigger className="icon-button composer-button" aria-label="Add to message">
              <PlusIcon />
            </MenuTrigger>
            <MenuContent align="start" side="top">
              {composerActions.map((action) => (
                <MenuItem
                  key={action.key}
                  icon={<action.icon />}
                  onSelect={() =>
                    action.onSelect({
                      channelId,
                      guildId,
                      openDialog: (Dialog) => composerDialog.open(Dialog, { channelId, guildId }),
                    })
                  }
                >
                  {action.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {canAttach && (
          <button
            type="button"
            className="icon-button composer-button"
            aria-label="Attach files"
            onClick={() => fileInput.current?.click()}
          >
            <PaperclipIcon />
          </button>
        )}
        {active ? (
          <CommandFields
            active={active}
            members={members}
            channels={guildChannels}
            onChange={(name, value) =>
              setActive({
                ...active,
                values: { ...active.values, [name]: value },
                errors: Object.fromEntries(
                  Object.entries(active.errors).filter(([key]) => key !== name),
                ),
              })
            }
            onSubmit={runCommand}
            onCancel={cancelCommand}
          />
        ) : (
          <textarea
            ref={field}
            className="composer-input"
            rows={1}
            value={text}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-controls={showSuggestions || showCommands ? listId : undefined}
            aria-activedescendant={
              showCommands && commandMatches[activeIndex]
                ? `${listId}-${commandMatches[activeIndex].name}`
                : showSuggestions && suggestions[activeIndex]
                  ? `${listId}-${suggestions[activeIndex].id}`
                  : undefined
            }
            enterKeyHint={coarse ? 'enter' : 'send'}
            onChange={(event) => onChange(event.target.value, event.target.selectionStart)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        )}
        <EmojiPickerButton
          label="Insert emoji"
          className="icon-button composer-button"
          onPick={insertEmoji}
        >
          <SmileIcon />
        </EmojiPickerButton>
        <button
          type="button"
          className="send-button"
          aria-label={active ? 'Run command' : 'Send message'}
          disabled={!canSend}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          <SendIcon width={20} height={20} />
        </button>
      </div>
      {composerDialog.dialog}
    </div>
  );
}
