import type { WebhookPreset } from '@harmony/shared';
import { alertmanager, grafana } from './alerts.js';
import { forgejo, github } from './forge.js';
import { generic } from './generic.js';
import { watchtower } from './watchtower.js';
import type { Preset } from './util.js';

export type { Headers, Preset } from './util.js';

export const PRESETS: Record<WebhookPreset, Preset> = {
  forgejo,
  github,
  alertmanager,
  grafana,
  watchtower,
  generic,
};
