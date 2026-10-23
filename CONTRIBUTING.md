# Contributing

Harmony is a personal project, but issues and pull requests are welcome. This page covers how to
get a working checkout and what a change should include.

## Setup

Node 24, pnpm 12 and Docker are required. The step-by-step dev setup (throwaway Postgres and
Redis, the development identity, running the server and Vite) is in the
[README](README.md#local-development).

## Before you push

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration   # needs Docker (Testcontainers)
pnpm test:e2e           # Playwright, needs the dev stack from the README
npx prettier --check .
node scripts/check-links.mjs
```

CI runs the same checks. A change that touches behavior should come with a test at the lowest
level that can show it: a unit test for pure logic, an integration test for anything involving
SQL, Redis or the realtime hub.

## Conventions

- **Commits:** short imperative subject (`Fix nickname lookup on the send path`), a body that
  says why when the reason is not obvious. One logical change per commit.
- **Formatting:** Prettier (`pnpm format`) and the ESLint config in the repo. Do not hand-format.
- **Protocol changes:** edit the zod schemas in `packages/shared` first; the server and web client
  then fail to compile until they agree. Update [docs/api/protocol.md](docs/api/protocol.md).
- **Security-relevant changes** (auth, Origin checks, bot routes, outbound requests): read the
  [trust model](docs/security/trust-model.md) first and update it if the change alters it.
- **Performance-sensitive paths:** the message send path is held to a fixed number of SQL
  statements by a test, and new joins on it need a send-rate run. See
  [docs/performance.md](docs/performance.md).
- **Design decisions:** add a dated entry with the rejected alternatives to [NOTES.md](NOTES.md).

## Adding a feature as a module

Most features beyond the core belong in a module. The contract, lifecycle and a worked example are
in [docs/modules.md](docs/modules.md#write-a-module-in-15-minutes).
