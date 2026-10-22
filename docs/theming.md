# Theming and appearance tokens

The web client's look is driven by CSS custom properties in three layers. Components only ever read the top layer, so a theme (the built-in light theme today, user themes, server branding and custom CSS in Phase 5) can restyle the whole app by overriding tokens and nothing else.

```
primitives   palette.css   --palette-*          raw color scales, default theme only
semantic     tokens.css    --color-*, --radius-*, --space-*, --font-*, --density, ...
components   base/layout/chat/overlays/integrations.css   var(--semantic-token) only
```

Files live in `apps/web/src/styles/`. `index.css` imports them in that order, after the bundled fonts.

## Rules

1. **Component CSS reads semantic tokens only.** No hex, `rgb()`, `hsl()` (or `oklch()` and friends) literals and no `var(--palette-*)` outside `palette.css` and `tokens.css`. `styles/styles.test.ts` fails the unit run if either appears, and also fails if a stylesheet uses a custom property that nothing defines (typos).
2. **Derived colors are built in the token files**, with `color-mix()` over other tokens. Components that need a tint use a `*-soft` token or `color-mix(in srgb, var(--token) N%, transparent)`.
3. **Per-element tuning uses local custom properties** that components set themselves (`--status-ring`, `--embed-color`, `--pl`/`--pr` for drawer drag). They are not part of the theme contract.

## Layer 1: primitives (`palette.css`)

Raw scales for the default theme. Warm, slightly olive neutrals, so the dark theme is charcoal and not blue-gray.

| Scale                 | Steps                                                                                 | Role                                                                     |
| --------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--palette-neutral-*` | 0, 25, 50, 100, 150, 200, 300, 400, 500, 550, 600, 700, 750, 800, 850, 900, 950, 1000 | Surfaces, borders, text (0 is white, 1000 the darkest canvas)            |
| `--palette-jade-*`    | 100 to 950                                                                            | Primary accent (sage / jade)                                             |
| `--palette-apricot-*` | 100 to 900                                                                            | Secondary accent: mentions, unread, "new"                                |
| `--palette-red-*`     | 300 to 800                                                                            | Danger, "do not disturb"                                                 |
| `--palette-amber-*`   | 300 to 700                                                                            | Idle, failed deliveries                                                  |
| `--palette-green-*`   | 300 to 700                                                                            | Online, succeeded (yellow-green, so it stays apart from the jade accent) |
| `--palette-blue-*`    | 300 to 700                                                                            | Info                                                                     |
| `--palette-tone-0..6` | single values                                                                         | Avatar fallback backgrounds                                              |

## Layer 2: semantic tokens (`tokens.css`)

### Color (themeable)

| Token                                                                | Meaning                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `--color-bg-canvas`                                                  | The surface behind the floating panels; page background                                     |
| `--color-bg-panel`                                                   | Panels and cards: rail, sidebar, chat, member list, dialogs, sheets                         |
| `--color-bg-raised`                                                  | Things sitting on a panel: composer, settings cards, embeds, reactions, user card           |
| `--color-bg-overlay`                                                 | Menus, popovers, tooltips, toasts, floating toolbar                                         |
| `--color-bg-input`                                                   | Text fields                                                                                 |
| `--color-bg-code`                                                    | Inline code and code blocks                                                                 |
| `--color-bg-hover`, `--color-bg-active`                              | Translucent hover / pressed overlays                                                        |
| `--color-border`, `--color-border-strong`                            | 1px outlines and dividers; strong for inputs and controls                                   |
| `--color-scrim`                                                      | Dimming behind dialogs and drawers                                                          |
| `--color-text`                                                       | Primary text                                                                                |
| `--color-text-muted`                                                 | Secondary text, passes WCAG AA on every surface above                                       |
| `--color-text-faint`                                                 | Timestamps and hints, still AA (4.5:1 or better) on panel and raised                        |
| `--color-text-link`                                                  | Links                                                                                       |
| `--color-accent`                                                     | Fill for primary buttons, active state, send button, own mention                            |
| `--color-accent-hover`                                               | Hover for accent fills                                                                      |
| `--color-accent-soft`                                                | Tinted background for active rows, chips, others' mentions                                  |
| `--color-accent-text`                                                | Accent used as text on panel / soft backgrounds                                             |
| `--color-accent-contrast`                                            | Text on `--color-accent`                                                                    |
| `--color-mention`                                                    | Apricot fill: badges, the "new" divider pill, the highlight bar of messages that mention me |
| `--color-mention-soft`                                               | Background of messages that mention me                                                      |
| `--color-mention-text`                                               | Text on `--color-mention-soft`                                                              |
| `--color-mention-contrast`                                           | Text on `--color-mention`                                                                   |
| `--color-unread`                                                     | Unread dots and the new-messages line                                                       |
| `--color-danger`, `--color-danger-hover`, `--color-danger-soft`      | Destructive fills and tints                                                                 |
| `--color-danger-text`                                                | Danger as text on panel / soft backgrounds                                                  |
| `--color-danger-contrast`                                            | Text on `--color-danger`                                                                    |
| `--color-info`                                                       | Informational accent (reserved)                                                             |
| `--color-status-online`, `-idle`, `-dnd`, `-offline`                 | Presence dots (3:1 against panels), distinct from both accents                              |
| `--color-tone-0..6`, `--color-tone-contrast`                         | Avatar fallback colors and their letter color                                               |
| `--color-switch-thumb`                                               | Toggle knob                                                                                 |
| `--color-viewer-bg`, `--color-viewer-text`, `--color-viewer-control` | Full-screen image viewer                                                                    |
| `--shadow-panel`, `--shadow-raised`, `--shadow-sheet`                | Card, floating-element and bottom-sheet shadows                                             |

### Geometry, type and rhythm

| Token                                                                                                    | Default                                                      | Meaning                                                    |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `--radius-panel`                                                                                         | 16px                                                         | Shell panels (0 in `flat`)                                 |
| `--radius-card`                                                                                          | 12px                                                         | Settings cards, embeds, code blocks, menus, attachments    |
| `--radius-control`                                                                                       | 10px                                                         | Buttons, inputs, rows                                      |
| `--radius-tile`                                                                                          | 12px                                                         | Server tiles                                               |
| `--radius-avatar` / `--avatar-shape`                                                                     | 30%                                                          | Avatars; 50% is a circle, 0 a square                       |
| `--radius-inline`                                                                                        | 6px                                                          | Inline code, chips inside text                             |
| `--radius-pill`                                                                                          | 999px                                                        | Capsules, badges, reactions                                |
| `--radius-sheet`                                                                                         | 20px                                                         | Dialogs and bottom sheets (0 in `flat`)                    |
| `--panel-gap`                                                                                            | 8px                                                          | Gap between floating panels (0 in `flat`)                  |
| `--space-1..12`                                                                                          | 4 to 48px                                                    | Spacing scale                                              |
| `--font-ui`, `--font-mono`                                                                               | Manrope Variable, JetBrains Mono Variable (system fallbacks) | Typefaces                                                  |
| `--font-size-ui`, `--font-size-message`                                                                  | 14px, 15px                                                   | Base sizes for chrome and messages                         |
| `--text-xs` to `--text-xl`, `--leading-*`, `--weight-*`                                                  |                                                              | Type scale                                                 |
| `--density`                                                                                              | 1                                                            | Unitless multiplier; compact 0.78, cozy 1, comfortable 1.3 |
| `--row-height`, `--message-pad-y`, `--message-gap`, `--list-pad`                                         | derived from `--density`                                     | Row and message rhythm                                     |
| `--tap-min`, `--tap-row`                                                                                 | 36 / 0 (44 / 44 on touch)                                    | Control and row minimums; touch screens always get 44      |
| `--rail-width`, `--tile-size`, `--sidebar-width`, `--member-width`, `--header-height`, `--content-width` |                                                              | Layout sizes                                               |
| `--duration-fast`, `--duration`, `--ease`                                                                | 120ms, 180ms, ease-out                                       | Motion; `prefers-reduced-motion` collapses it              |
| `--z-*`                                                                                                  |                                                              | Layers                                                     |

## Switches on `<html>`

`lib/appearance.ts` writes three attributes, persisted in `localStorage` (`harmony.appearance`) until Phase 5 moves it to the server:

| Attribute      | Values                                                 | Effect                                                                               |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `data-theme`   | `dark`, `light`; absent follows `prefers-color-scheme` | Remaps the color tokens                                                              |
| `data-density` | `compact`, `cozy`, `comfortable`                       | Sets `--density`                                                                     |
| `data-panels`  | `floating`, `flat`                                     | `flat` zeroes `--panel-gap`, `--radius-panel`, `--radius-sheet` and `--shadow-panel` |

```ts
import { applyAppearance, saveAppearance } from './lib/appearance';
applyAppearance({ theme: 'light', density: 'compact', panels: 'flat' }); // just apply
saveAppearance({ theme: 'dark', density: 'cozy', panels: 'floating' }); // persist and apply
```

`applyAppearance` also keeps the `theme-color` meta tags in step with the canvas color.

## How a theme overrides tokens

The default (dark) values are declared on `:root`. The light theme is the same semantic tokens under `:root[data-theme='light']`, repeated under `@media (prefers-color-scheme: light) { :root:not([data-theme]) }` so "system" works without JavaScript. A test requires the two light blocks to stay identical.

A custom theme is another block with the same shape, and it only needs the semantic layer:

```css
:root[data-theme='dusk'] {
  color-scheme: dark;
  --color-bg-canvas: #101418;
  --color-bg-panel: #171c22;
  --color-bg-raised: #1e252d;
  --color-accent: #8fb4ff;
  --color-accent-contrast: #0b1220;
  /* ...every themed token in the table above */
}
```

Guidelines for a complete theme:

- Define all color tokens, not a subset. Any token left out falls through to the dark default.
- Keep `--color-text-muted` and `--color-text-faint` at 4.5:1 or better on `bg-panel` and `bg-raised`, `--color-accent-contrast` on `--color-accent` at 4.5:1, and status colors at 3:1 on `bg-panel`.
- Server branding overrides a few accent tokens (`--color-accent*`) and `--avatar-shape` or `--radius-*` only; user themes and custom CSS (Phase 5) can override anything in the table. Because components read no literals, there is nothing else to patch.
- Fonts are bundled (`@fontsource-variable/*`, no third-party requests). A theme that changes `--font-ui` must also bundle its font.

## Contrast (default theme)

Measured with the WCAG relative-luminance formula for the combinations the UI actually uses. All text pairs are at least 4.5:1, presence dots and the unread dot at least 3:1.

| Pair                                 | Dark      | Light     |
| ------------------------------------ | --------- | --------- |
| text / panel                         | 14.5      | 16.9      |
| muted / panel                        | 8.7       | 7.0       |
| faint / panel (lowest: faint / code) | 6.2 (5.4) | 5.6 (4.9) |
| link / panel                         | 10.2      | 7.4       |
| accent-contrast / accent             | 7.7       | 5.2       |
| mention-contrast / mention           | 9.1       | 9.1       |
| mention-text / mention-soft          | 8.4       | 8.5       |
| danger-text / panel                  | 8.6       | 7.2       |
| avatar letter / tone (lowest)        | 4.9       | 4.9       |
