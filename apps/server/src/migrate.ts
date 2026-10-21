import { loadDatabaseUrl } from './config.js';
import { createDb } from './db.js';
import { createMigrator } from './migrator.js';

const db = createDb(loadDatabaseUrl());
const { error, results } = await createMigrator(db).migrateToLatest();

for (const result of results ?? []) {
  console.log(`${result.status}: ${result.migrationName}`);
}
await db.destroy();

if (error) {
  console.error('migration failed:', error);
  process.exit(1);
}
