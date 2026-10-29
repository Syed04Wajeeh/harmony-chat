import { z } from 'zod';

export const MAX_BUTTONS = 5;

/** Lowercase slug used for panel keys, block ids, column keys and button ids. */
export const PanelSlug = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,31}$/,
    'Use 1-32 lowercase letters, digits, hyphens or underscores',
  );

export const ButtonStyle = z.enum(['primary', 'secondary', 'danger']);

/** A permission key such as `manage_messages` or `polls.create`; the server checks it on every click. */
export const ButtonPermission = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);

export const Button = z.object({
  id: PanelSlug,
  label: z.string().min(1).max(40),
  style: ButtonStyle.optional(),
  confirm: z
    .object({
      title: z.string().min(1).max(100),
      body: z.string().max(500).optional(),
      confirmLabel: z.string().min(1).max(20).optional(),
    })
    .optional(),
  requiredPermission: ButtonPermission.optional(),
});
export type Button = z.infer<typeof Button>;

const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;

/** Buttons on a bot message. */
export const MessageComponents = z
  .object({ buttons: z.array(Button).min(1).max(MAX_BUTTONS) })
  .refine((c) => unique(c.buttons.map((b) => b.id)), { message: 'Duplicate button id' });
export type MessageComponents = z.infer<typeof MessageComponents>;
