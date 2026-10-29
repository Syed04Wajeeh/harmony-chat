import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHarmonyMcpServer, type Config } from '../src/server.js';
import { TOKEN, type FakeHarmony } from './fake-harmony.js';

export async function connect(
  fake: FakeHarmony,
  overrides: Partial<Config> = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createHarmonyMcpServer({
    url: fake.url,
    token: TOKEN,
    defaultChannel: undefined,
    maxSendsPerMinute: 20,
    allowMassMentions: false,
    agentChannel: undefined,
    approvalPermission: 'manage_messages',
    panelMinIntervalMs: 30,
    ...overrides,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  data: Record<string, unknown> | undefined;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
  };
  return {
    isError: result.isError === true,
    text: result.content.map((part) => part.text ?? '').join('\n'),
    data: result.structuredContent,
  };
}
