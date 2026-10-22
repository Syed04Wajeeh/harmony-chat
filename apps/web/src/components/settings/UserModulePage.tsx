import { Navigate, useParams } from 'react-router';
import { webModules } from '../../modules/index.js';
import { SettingsPage } from './SettingsLayout.js';

/** Hosts the page a module added to User settings. */
export function UserModulePage() {
  const { moduleId = '' } = useParams();
  const panel = webModules.find((module) => module.id === moduleId)?.userSettingsPanel;
  if (!panel) return <Navigate replace to="/settings/user" />;
  return (
    <SettingsPage title={panel.label} back="/settings/user">
      <panel.Panel />
    </SettingsPage>
  );
}
