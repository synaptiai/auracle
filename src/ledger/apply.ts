// Applies db/*.sql in lexical order against DATABASE_URL.
// The files use IF NOT EXISTS, so applying twice is a no-op.
// Run via `npm run db:apply` (executes the built dist/ledger/apply.js).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const dbDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db',
);

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const files = (await readdir(dbDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.error(`No .sql files found in ${dbDir}`);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      const sql = await readFile(path.join(dbDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
