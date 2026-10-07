// What the Postgres driver makes of a connection URI (issue #153).
import pg from 'pg';

/** The fields the driver parsed from a URI, as it will use them. */
export interface DriverParameters {
  readonly user: string;
  /** Null or absent when the URI carries none. */
  readonly password: string | null | undefined;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly ssl: pg.ClientConfig['ssl'];
  readonly options: string | undefined;
}

/**
 * The driver's own parse of a URI. The URL alone misleads: the driver lets a
 * `host` query parameter replace the host before the path, ignores
 * `hostaddr`, and fills an empty host from PGHOST. Nothing connects.
 */
export function driverParameters(url: string): DriverParameters {
  const client = new pg.Client({ connectionString: url }) as unknown as { connectionParameters: DriverParameters };
  return client.connectionParameters;
}
