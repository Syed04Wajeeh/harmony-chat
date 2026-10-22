import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { bootstrap } from './store/actions.js';
import { startDispatcher } from './store/dispatcher.js';
import { InvitePage } from './routes/InvitePage.js';
import { AppearancePage } from './components/settings/AppearancePage.js';
import { BotDetailPage } from './components/settings/BotDetailPage.js';
import { DesktopBridge } from './components/DesktopBridge.js';
import { BotsPage } from './components/settings/BotsPage.js';
import { DesktopPage } from './components/settings/DesktopPage.js';
import { GuildBotsPage } from './components/settings/GuildBotsPage.js';
import { IntegrationsPage } from './components/settings/IntegrationsPage.js';
import { ModulesPage } from './components/settings/ModulesPage.js';
import { MembersPage } from './components/settings/MembersPage.js';
import { OverviewPage } from './components/settings/OverviewPage.js';
import { RolesPage } from './components/settings/RolesPage.js';
import { ServerSettingsLayout } from './components/settings/ServerSettings.js';
import { UserModulePage } from './components/settings/UserModulePage.js';
import { UserSettingsLayout } from './components/settings/UserSettings.js';
import { Shell } from './routes/Shell.js';

type Boot = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

function Bootstrap({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    bootstrap(controller.signal)
      .then(() => setBoot({ status: 'ready' }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setBoot({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    return () => controller.abort();
  }, [attempt]);

  const ready = boot.status === 'ready';
  useEffect(() => (ready ? startDispatcher() : undefined), [ready]);

  if (boot.status === 'loading') {
    return (
      <div className="splash" role="status">
        <span className="spinner" aria-hidden="true" /> Loading Harmony…
      </div>
    );
  }
  if (boot.status === 'error') {
    return (
      <div className="splash">
        <h1>Cannot reach Harmony</h1>
        <p>{boot.message}</p>
        <button
          className="button button-primary"
          onClick={() => {
            setBoot({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <Bootstrap>
        <DesktopBridge />
        <Routes>
          <Route path="/invite/:code" element={<InvitePage />} />
          <Route path="/settings/user" element={<UserSettingsLayout />}>
            <Route path="appearance" element={<AppearancePage />} />
            <Route path="desktop" element={<DesktopPage />} />
            <Route path="bots" element={<BotsPage />} />
            <Route path="bots/:botId" element={<BotDetailPage />} />
            <Route path="m/:moduleId" element={<UserModulePage />} />
          </Route>
          <Route path="/settings/server/:guildId" element={<ServerSettingsLayout />}>
            <Route path="overview" element={<OverviewPage />} />
            <Route path="roles" element={<RolesPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="modules" element={<ModulesPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="bots" element={<GuildBotsPage />} />
          </Route>
          <Route path="/channels/:guildId?/:channelId?" element={<Shell />} />
          <Route path="*" element={<Shell />} />
        </Routes>
      </Bootstrap>
    </BrowserRouter>
  );
}
