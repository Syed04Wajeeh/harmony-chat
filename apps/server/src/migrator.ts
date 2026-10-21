import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import type { Database } from './db/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Built output keeps compiled migrations next to this file; from source they live one level up.
const builtFolder = path.join(here, 'migrations');
const migrationFolder = existsSync(builtFolder) ? builtFolder : path.resolve(here, '../migrations');

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      // Migrator imports whatever path.join returns; ESM needs file URLs.
      path: { join: (...parts) => pathToFileURL(path.join(...parts)).href },
      migrationFolder,
    }),
  });
}
