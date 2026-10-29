#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, createHarmonyMcpServer, loadConfig } from './server.js';

// stdout carries the protocol; anything for humans goes to stderr, and never the token.
try {
  const config = loadConfig(process.env);
  const server = createHarmonyMcpServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`harmony-mcp: connected to ${config.url}`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`harmony-mcp: ${error.message}`);
  } else {
    console.error('harmony-mcp: failed to start:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
