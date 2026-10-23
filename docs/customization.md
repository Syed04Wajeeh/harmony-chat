# Customization

Everything people and admins can change in Harmony, and where it is documented.

## For everyone

| What                 | Where                                   | Details                                                                                                        |
| -------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Themes               | Settings > User > Themes                | [theming](theming.md): eight presets, custom themes, share strings                                             |
| Display and behavior | Settings > User > Display / Behavior    | density, panels, text size, fonts, clock, Enter to send                                                        |
| Custom CSS           | Settings > User > Advanced              | [theming](theming.md), [threat model](security/trust-model.md#custom-css)                                      |
| Profile              | Settings > User > Profile               | avatar (cropped square, or reset to the Tailscale picture), banner color or image, accent color, pronouns, bio |
| Custom status        | User panel (bottom left) > status menu  | emoji, text and expiry (30 minutes, 1 hour, 4 hours, today, never)                                             |
| Custom emoji         | composer `:` autocomplete, emoji picker | [protocol](api/protocol.md#profiles-custom-emoji-and-perks)                                                    |

A status or a bio can use the message Markdown subset. Statuses clear themselves when they expire.

## For server owners and managers

| What         | Permission     | Where                                                                                                                          |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Branding     | `manage_guild` | Server settings > Overview: accent color, banner, description                                                                  |
| Custom emoji | `manage_emoji` | Server settings > Emoji: upload (PNG, GIF, WebP, up to 256 KB and 128x128), rename, delete; at most `EMOJI_MAX_PER_GUILD` (50) |
| Modules      | `manage_guild` | Server settings > Modules: the `custom-emoji` module can be switched off per server                                            |
| Roles        | `manage_roles` | [permissions](permissions.md)                                                                                                  |

## For instance admins: perks

Perks are free extras with no payment behind them. Everyone gets the `PERKS_DEFAULT` set
(`all` by default); admins can grant more to single people in Settings > User > Perks.

| Perk                   | Unlocks                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `animated_avatar`      | GIF or animated WebP avatars (otherwise upload a still image)          |
| `profile_banner_image` | an image as profile banner (otherwise banner color only)               |
| `cross_server_emoji`   | custom emoji from other servers you are in, in messages and reactions  |
| `larger_uploads`       | `UPLOAD_MAX_BYTES_PERK` (default 50 MiB) instead of `UPLOAD_MAX_BYTES` |
| `extra_themes`         | 100 custom themes instead of 20                                        |
| `custom_status_emoji`  | custom emoji in your status                                            |

To restrict them, set `PERKS_DEFAULT=none` (or a list such as `PERKS_DEFAULT=extra_themes,larger_uploads`)
and grant the rest by hand. Locked features show a small "Perk" badge with an explanation.
Enforcement is server-side; see the [trust model](security/trust-model.md#profiles-custom-emoji-and-perks).

## Extending

Modules can contribute settings pages, message decorations, permissions and routes: see
[modules](modules.md). The `custom-emoji` module is a small example of an optional per-guild module.
