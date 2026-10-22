/**
 * Payloads shaped exactly like Uptime Kuma's Discord provider
 * (server/notification-providers/discord.js, master as of 2026-10): `heartbeatJSON.time` is
 * `YYYY-MM-DD HH:mm:ss.SSS` (UTC, not ISO), `flags` and `avatar_url` are added on request, and
 * `content` appears only with a prefix message.
 */
export const kumaDown = {
  username: 'Uptime Kuma',
  embeds: [
    {
      title: '❌ Your service Example Site went down. ❌',
      color: 16711680,
      timestamp: '2026-10-22 08:15:30.123',
      fields: [
        { name: 'Service Name', value: 'Example Site' },
        { name: 'Service URL', value: 'https://example.com/health' },
        { name: 'Went Offline', value: '<t:1792656930:F>' },
        { name: 'Time (UTC)', value: '2026-10-22 08:15:30' },
        { name: 'Error', value: 'timeout of 48000ms exceeded.' },
      ],
    },
  ],
  avatar_url: 'https://github.com/louislam/uptime-kuma/raw/master/public/icon.png',
  content: '@everyone check this',
  flags: 4096,
};

export const kumaUp = {
  username: 'Uptime Kuma',
  embeds: [
    {
      title: '✅ Your service Example Site is up! ✅',
      color: 65280,
      timestamp: '2026-10-22 08:20:00.000',
      fields: [
        { name: 'Service Name', value: 'Example Site' },
        { name: 'Service URL', value: 'https://example.com/health' },
        { name: 'Went Offline', value: '<t:1792656930:F>' },
        { name: 'Downtime Duration', value: '4m 30s' },
        { name: 'Time (UTC)', value: '2026-10-22 08:20:00' },
        { name: 'Ping', value: '42 ms' },
      ],
    },
  ],
};

/** The "Test" button and the minimalist/custom formats send plain content. */
export const kumaTest = { username: 'Uptime Kuma', content: 'Sent from Uptime Kuma' };
