import { Pool } from 'pg';

// Mirrors the credentials in docker-compose.yml. Compose cannot export
// environment variables to the host shell, so this fallback is the default.
//
// Under `npm test`, Vitest's setup file (src/test-support/db-url.setup.ts)
// overwrites DATABASE_URL with the per-run ephemeral Postgres URI before any
// suite imports this module, so tests always prefer that container; an
// explicit shell export wins over the compose default everywhere else.
const COMPOSE_DEFAULT_URL = 'postgres://auracle:auracle@localhost:5433/auracle';

export function dbUrl(): string {
  return process.env.DATABASE_URL ?? COMPOSE_DEFAULT_URL;
}

export async function tryConnect(): Promise<Pool | null> {
  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch {
    await pool.end();
    return null;
  }
}
