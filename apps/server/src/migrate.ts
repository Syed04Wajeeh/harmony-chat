import { loadDatabaseUrl } from './config.js';
import { createDb } from './db.js';
import { migrateAll } from './migrator.js';
import { modules } from './modules/index.js';

const db = createDb(loadDatabaseUrl());
const { error, results } = await migrateAll(db, modules);

for (const result of results ?? []) {
  console.log(`${result.status}: ${result.migrationName}`);
}
await db.destroy();

if (error) {
  console.error('migration failed:', error);
  process.exit(1);
}
