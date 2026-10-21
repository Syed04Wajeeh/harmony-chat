# Engineering notes

## Decisions

- 2026-10-21: Raw `ws` over Socket.IO. The protocol is small and typed with zod; Socket.IO's rooms, fallbacks and custom framing add weight and hide behavior I want to own. Rejected: Socket.IO.
- 2026-10-21: Kysely over Prisma. Migrations and queries stay close to plain SQL, no generated client or query engine binary, and the Docker image stays small. Rejected: Prisma.
- 2026-10-21: pnpm monorepo with a shared zod package. Client and server validate against the same schemas, so protocol drift is a compile error. `@harmony/shared` is built with `tsc` to `dist` and consumed as a normal package (`main`/`types`/`exports`); this works unchanged for Vite, the Node server and `pnpm deploy` in Docker. Rejected: source exports (Node cannot run `.ts` from `node_modules`) and project references (extra config for no gain here).
- 2026-10-21: Migrations run in a separate one-shot `migrate` compose service, so several app instances never race on the schema. Rejected: migrating on app startup.
- 2026-10-21: The app serves the built web client itself, so client and API share one origin. That keeps CORS out of the picture and simplifies Origin checks for WebSockets later. Rejected: separate static host.
- 2026-10-21: TypeScript pinned to 6.x. typescript-eslint does not support TypeScript 7 yet, and one version across the workspace avoids running two compilers.

## Measured results

Only numbers actually measured, with conditions.

## Problems solved

- `pnpm fetch` failed in Docker with `ERR_PNPM_IGNORED_BUILDS`: pnpm 12 refuses to continue when dependencies have unapproved install scripts. Fixed by declaring `allowBuilds` in `pnpm-workspace.yaml` (esbuild allowed; cpu-features, protobufjs and ssh2 from Testcontainers denied).
- ESLint crashed at startup with "typescript-eslint does not support TS 7.0". Pinned TypeScript to 6.x across the workspace.
- `Migrator` and `FileMigrationProvider` are no longer exported from the `kysely` root in 0.29; they are imported from `kysely/migration`.
- Kysely's `FileMigrationProvider` dynamic-imports migration files, which needs file URLs under ESM, and the production image only has compiled JS. Migrations are compiled to `dist/migrations` by a second `tsc` pass, and the migrator uses that folder when present, else `migrations/` from source.
