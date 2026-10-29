import { BotError, clean } from './errors.ts';

export interface Monitor {
  name: string;
  group: string;
  /** 1 up, 0 down, 2 pending, 3 maintenance; undefined when there is no heartbeat yet. */
  status: number | undefined;
  /** 24 hour uptime as a percentage. */
  uptime: number | undefined;
}

/** Reads an Uptime Kuma public status page. Nothing here needs a login. */
export async function fetchMonitors(
  kuma: { baseUrl: string; slug: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Monitor[]> {
  const get = async (path: string): Promise<unknown> => {
    try {
      const res = await fetchImpl(`${kuma.baseUrl}/api/status-page/${path}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new BotError('failed', `Uptime Kuma said no (${String(res.status)}).`);
      const data: unknown = await res.json();
      return data;
    } catch (error) {
      if (error instanceof BotError) throw error;
      throw new BotError('unreachable', 'Uptime Kuma did not answer.');
    }
  };
  const page = (await get(kuma.slug)) as {
    publicGroupList?: { name?: string; monitorList?: { id: number; name?: string }[] }[];
  };
  const beats = (await get(`heartbeat/${kuma.slug}`)) as {
    heartbeatList?: Record<string, { status: number }[]>;
    uptimeList?: Record<string, number>;
  };
  return (page.publicGroupList ?? []).flatMap((group) =>
    (group.monitorList ?? []).map((monitor) => {
      const list = beats.heartbeatList?.[String(monitor.id)] ?? [];
      const uptime = beats.uptimeList?.[`${String(monitor.id)}_24`];
      return {
        name: clean(monitor.name, 60) || `Monitor ${String(monitor.id)}`,
        group: clean(group.name, 60),
        status: list.at(-1)?.status,
        uptime: typeof uptime === 'number' ? Math.round(uptime * 1000) / 10 : undefined,
      };
    }),
  );
}
