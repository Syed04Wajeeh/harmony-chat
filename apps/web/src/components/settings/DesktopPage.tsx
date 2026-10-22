import { releasesUrl } from '../../lib/desktopBridge.js';
import { SettingsCard, SettingsPage } from './SettingsLayout.js';

export function DesktopPage() {
  const href = releasesUrl();
  return (
    <SettingsPage title="Desktop app" back="/settings/user">
      <SettingsCard
        title="Download the desktop app"
        description="Runs Harmony in its own window with a tray icon, native notifications and an unread badge. It connects to this same server, so you still need Tailscale."
      >
        {href && (
          <p>
            <a className="button button-primary" href={href} target="_blank" rel="noreferrer">
              Download the desktop app
            </a>
          </p>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
