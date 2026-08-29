// Runs per test file, before its imports execute: resolves the URI provided
// by global-setup.ts and publishes it as DATABASE_URL so suites pick it up
// through src/db/config.ts with no suite changes.
//
// The key is typed by the ProvidedContext declaration in global-setup.ts,
// so a rename on either side is a compile error rather than an undefined at
// run time.
import { inject } from 'vitest';

process.env['DATABASE_URL'] = inject('dbUrl');
