# Harmony desktop

A [Tauri v2](https://v2.tauri.app) shell around a Harmony server. It opens your server in its own window and adds a tray icon, launch at login, single instance, window-state memory, native notifications for mentions and DMs, an unread badge, and auto-update. The web client is not bundled: the window loads the server's own origin, so the Tailscale identity, the `Origin` checks and the UI version are exactly what the browser gets. There is no offline mode.

The security model of the bridge between the page and the app is in [docs/security/trust-model.md](../../docs/security/trust-model.md#desktop-app).

## Layout

| Path                        | What                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `src/`        | The setup page (TypeScript, no framework): validates nothing itself, asks the native `connect_server` and shows errors |
| `src-tauri/src`             | Rust: URL validation, server probe, config file, session and capabilities, commands, tray, updater, window handling    |
| `src-tauri/capabilities`    | The static capability for the setup page; the server's capability is created at runtime                                |
| `src-tauri/tauri.conf.json` | Product name, bundle targets, updater endpoint and public key                                                          |
| `scripts/sync-version.mjs`  | Keeps `Cargo.toml` and `Cargo.lock` on the version in `package.json`                                                   |

## Develop

Needs Node 24, pnpm, Rust (stable) and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS (on Debian/Ubuntu: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`).

```sh
pnpm install
pnpm --filter @harmony/desktop tauri dev      # opens the setup page; use http://localhost:8080 for a local dev server
pnpm --filter @harmony/desktop test:unit      # setup page logic (Vitest)
cd apps/desktop/src-tauri && cargo test       # URL validation, probe, notification arguments, access control
cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings
```

`http` is accepted for `localhost` and `127.0.0.1` only, so you can point a development build at `pnpm dev` of the server. Everything else must be `https`.

The stored server address is `config.json` in the app config directory (`%APPDATA%\chat.harmony.desktop` on Windows, `~/Library/Application Support/chat.harmony.desktop` on macOS, `~/.config/chat.harmony.desktop` on Linux). Delete it, or use the tray menu's "Change server…", to see the setup page again.

### Build locally

```sh
pnpm --filter @harmony/desktop tauri build
```

Installers land in `src-tauri/target/release/bundle/`. Updater artifacts (`.sig` files) need the signing key in the environment (below); without it `tauri build` stops at the end with an error that it cannot sign.

## Release

1. Set the new version in `apps/desktop/package.json` (the only place; `tauri.conf.json` reads it), then `pnpm --filter @harmony/desktop version:sync` to copy it into `Cargo.toml` and `Cargo.lock`, and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. The tag must equal `v<version>`; the workflow fails otherwise.
3. [`release.yml`](../../.github/workflows/release.yml) builds Windows (`.exe` NSIS installer and `.msi`), macOS (Apple silicon `.dmg`) and Linux (`.AppImage` and `.deb`), signs the update bundles, and creates a **draft** release containing the installers and `latest.json`. Check it, then publish it. Clients update from the published release.

The workflow can also be started by hand (`gh workflow run release.yml --ref <branch>`): it then creates a draft named `desktop-v<version>`. Delete such drafts afterwards with `gh release delete desktop-v<version> --yes --cleanup-tag`.

### Updater signing key

Updates are verified with a minisign key pair made by `pnpm --filter @harmony/desktop tauri signer generate`. The **public** key is in `tauri.conf.json` (`plugins.updater.pubkey`); the **private** key and its password are repository secrets named `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and should also be kept outside the repository (for example `~/.config/harmony-desktop/`, mode 600). To rotate: generate a new pair, replace both secrets and the public key, and release a build. Apps built with the old public key cannot verify updates signed by the new key, so those users must reinstall once.

### Update feed

The app checks `https://github.com/Syed04Wajeeh/harmony-chat/releases/latest/download/latest.json` shortly after start and every six hours. While the repository is private that URL answers 404 without authentication, so the check fails. Failures are ignored on purpose: the app keeps working and the tray's "Check for updates" says it could not check. Updates start working when the repository is public or when the release files are mirrored to a public URL (change `plugins.updater.endpoints`). A found update is only installed when the user chooses "Install update" in the tray menu.

### Code signing

The installers are not code-signed, which has two visible effects on first launch:

- **Windows SmartScreen** shows "Windows protected your PC / Unknown publisher". Choose "More info", then "Run anyway".
- **macOS Gatekeeper** refuses a downloaded, unsigned app. Right-click (or Control-click) the app and choose "Open", then confirm; or run `xattr -dr com.apple.quarantine /Applications/Harmony.app`.

To add signing later: for Windows, buy an Authenticode (or EV) certificate or use Azure Trusted Signing, and set `bundle.windows.certificateThumbprint` or a `signCommand` in `tauri.conf.json`; for macOS, join the Apple Developer Program and pass `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` and the notarization variables (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) to the `tauri-action` step as secrets. See the Tauri guides on [Windows](https://v2.tauri.app/distribute/sign/windows/) and [macOS](https://v2.tauri.app/distribute/sign/macos/) signing.

## Platform notes

- **Close** hides the window to the tray (Windows and macOS, and Linux when a tray exists); "Quit" in the tray menu exits.
- **Badge**: the unread count (mentions plus unread DMs) is on the tray tooltip everywhere, as a dock/launcher badge on macOS and Linux desktops that support it, and as a red dot overlay on the Windows taskbar button (Windows overlays are images, so the dot does not show the number).
- **Notifications** appear only while the window is not in front. On Windows, a click is only reported while the toast is still on screen, not after it moved to the Action Center.
- **Linux tray** needs an AppIndicator host. GNOME needs the AppIndicator extension; without a tray the window closes normally.
