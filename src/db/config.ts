import { Pool } from 'pg';

// Mirrors the credentials in docker-compose.yml. Compose cannot export
// environment variables to the host shell, so this fallback is the default.
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
