import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import {
  ChannelParams,
  ListSchedulesResponse,
  PutSchedulesBody,
  Schedule,
  ScheduleParams,
  UpdateScheduleBody,
} from '@harmony/shared';
import { AppError } from '../errors.js';
import type { ScheduleService } from './service.js';

export const scheduleRoutes: FastifyPluginCallbackZod<{ schedules: ScheduleService }> = (
  app,
  { schedules },
  done,
) => {
  // Bots register their own schedules with the `commands` scope: that scope is also what lets a
  // gateway bot receive interactions, and a refresh is one.
  app.put(
    '/bots/@me/schedules',
    {
      config: { scope: 'commands' },
      schema: { body: PutSchedulesBody, response: { 200: ListSchedulesResponse } },
    },
    async (request) => {
      if (!request.bot) throw new AppError(403, 'bots_only', 'Only a bot registers schedules');
      return { schedules: await schedules.replace(request.bot.id, request.body.schedules) };
    },
  );

  app.get(
    '/bots/@me/schedules',
    { config: { scope: 'commands' }, schema: { response: { 200: ListSchedulesResponse } } },
    async (request) => {
      if (!request.bot) throw new AppError(403, 'bots_only', 'Only a bot has schedules');
      return { schedules: await schedules.listForBot(request.bot.id) };
    },
  );

  app.get(
    '/channels/:id/schedules',
    {
      config: { humanOnly: true },
      schema: { params: ChannelParams, response: { 200: ListSchedulesResponse } },
    },
    async (request) => ({
      schedules: await schedules.listForChannel(request.user, request.params.id),
    }),
  );

  app.patch(
    '/schedules/:scheduleId',
    {
      config: { humanOnly: true },
      schema: { params: ScheduleParams, body: UpdateScheduleBody, response: { 200: Schedule } },
    },
    (request) => schedules.setPaused(request.user, request.params.scheduleId, request.body.paused),
  );

  app.delete(
    '/schedules/:scheduleId',
    { config: { humanOnly: true }, schema: { params: ScheduleParams } },
    async (request, reply) => {
      await schedules.remove(request.user, request.params.scheduleId);
      return reply.code(204).send();
    },
  );
  done();
};
