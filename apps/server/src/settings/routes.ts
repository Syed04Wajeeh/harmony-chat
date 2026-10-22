import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  CustomTheme,
  ListThemesResponse,
  PatchSettingsBody,
  ThemeInput,
  ThemeParams,
  UserSettings,
} from '@harmony/shared';
import type { SettingsService } from './service.js';

export interface SettingsRoutesOptions {
  settings: SettingsService;
}

export const settingsRoutes: FastifyPluginCallbackZod<SettingsRoutesOptions> = (
  app,
  { settings },
  done,
) => {
  const human = { humanOnly: true } as const;

  app.get(
    '/me/settings',
    { config: human, schema: { response: { 200: UserSettings } } },
    (request) => settings.get(request.user.id),
  );

  app.patch(
    '/me/settings',
    { config: human, schema: { body: PatchSettingsBody, response: { 200: UserSettings } } },
    (request) => settings.patch(request.user.id, request.body),
  );

  app.get(
    '/me/themes',
    { config: human, schema: { response: { 200: ListThemesResponse } } },
    async (request) => ({ themes: await settings.listThemes(request.user.id) }),
  );

  app.post(
    '/me/themes',
    { config: human, schema: { body: ThemeInput, response: { 201: CustomTheme } } },
    async (request, reply) =>
      reply.code(201).send(await settings.createTheme(request.user.id, request.body)),
  );

  app.put(
    '/me/themes/:id',
    {
      config: human,
      schema: { params: ThemeParams, body: ThemeInput, response: { 200: CustomTheme } },
    },
    (request) => settings.updateTheme(request.user.id, request.params.id, request.body),
  );

  app.delete(
    '/me/themes/:id',
    { config: human, schema: { params: ThemeParams } },
    async (request, reply) => {
      await settings.deleteTheme(request.user.id, request.params.id);
      return reply.code(204).send();
    },
  );
  done();
};
