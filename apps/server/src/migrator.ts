import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator, type MigrationResultSet } from 'kysely/migration';
import type { Database } from './db/schema.js';
import { sortModules } from './modules/registry.js';
import type { HarmonyModule } from './modules/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Built output keeps compiled migrations next to this file; from source they live one level up.
const builtFolder = path.join(here, 'migrations');
const migrationFolder = existsSync(builtFolder) ? builtFolder : path.resolve(here, '../migrations');

// Migrator imports whatever path.join returns; ESM needs file URLs.
const fileProvider = (folder: string) =>
  new FileMigrationProvider({
    fs,
    path: { join: (...parts) => pathToFileURL(path.join(...parts)).href },
    migrationFolder: folder,
  });

/** The core schema. Its history lives in Kysely's default `kysely_migration` table. */
export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: fileProvider(migrationFolder) });
}

/**
 * A module's schema, with a history table of its own so that core and module migrations never
 * have to agree on an order and a module can be removed without upsetting anyone else's history.
 */
export function createModuleMigrator(db: Kysely<Database>, module: HarmonyModule): Migrator | null {
  if (!module.migrationsDir) return null;
  const name = `harmony_module_${module.id.replaceAll('-', '_')}`;
  return new Migrator({
    db,
    provider: fileProvider(module.migrationsDir),
    migrationTableName: `${name}_migration`,
    migrationLockTableName: `${name}_migration_lock`,
  });
}

/**
 * Core first, then every module in dependency order, including modules `MODULES_DISABLED`
 * turns off: the schema stays complete, so switching a module back on needs no migration run.
 * Stops at the first failure.
 */
export async function migrateAll(
  db: Kysely<Database>,
  modules: readonly HarmonyModule[],
): Promise<MigrationResultSet> {
  const results: NonNullable<MigrationResultSet['results']> = [];
  const steps = [
    { label: '', migrator: createMigrator(db) },
    ...sortModules(modules).map((module) => ({
      label: `${module.id}:`,
      migrator: createModuleMigrator(db, module),
    })),
  ];
  for (const { label, migrator } of steps) {
    if (!migrator) continue;
    const { error, results: ran } = await migrator.migrateToLatest();
    results.push(
      ...(ran ?? []).map((r) => ({ ...r, migrationName: `${label}${r.migrationName}` })),
    );
    if (error) return { error, results };
  }
  return { results };
}
