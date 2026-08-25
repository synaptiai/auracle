// Runs per test file, before its imports execute: resolves the URI provided
// by global-setup.ts and publishes it as DATABASE_URL so suites pick it up
// through src/db/config.ts with no suite changes.
import { inject } from 'vitest';

process.env['DATABASE_URL'] = inject<string>('dbUrl');
