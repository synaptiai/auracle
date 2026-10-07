// Runs per test file, before its imports execute: clones the migrated
// template into a database of this file's own and publishes it as
// DATABASE_URL, so suites pick it up through src/db/config.ts with no suite
// changes.
//
// One database per file is what lets the db project run its files in
// parallel. The suites truncate tables between cases, so two files sharing a
// database corrupt each other's results, and the project ran one file at a
// time for that reason alone. The clone is a file-system copy of an already
// migrated database, so it costs far less than replaying the migrations.
//
// The key is typed by the ProvidedContext declaration in containers.ts, so a
// rename on either side is a compile error rather than an undefined at run
// time. `dbUrl` is the server's admin URI; a suite never uses it directly.
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, inject } from 'vitest';

// Pulls in the ProvidedContext augmentation, so `inject('dbUrl')` is typed
// rather than `never`.
import type {} from './containers.js';
import { recordDatabase } from './isolation-registry.js';
import { asReader, cloneTemplate, databaseOf } from './template-db.js';

// A name unique to this file, and short: Postgres truncates an identifier at
// 63 bytes, and a truncated name would collide with another worker's.
const label = randomUUID().replace(/-/g, '').slice(0, 16);
const runId = inject('dbRunId');

const url = await cloneTemplate(inject('dbUrl'), runId, label);
process.env['DATABASE_URL'] = url;
// The same database as the readers' role sees it (issue #153).
process.env['READER_DATABASE_URL'] = asReader(url);

// The run's teardown reads these back and fails when one database served two
// files. No single file can see that about itself.
//
// Recorded from a hook rather than here, because `expect.getState().testPath`
// is empty at module scope and populated inside one. The path is what makes
// the check able to see a setup that stopped running per file: two files on
// one database are two lines naming it, however this module was evaluated.
beforeAll(() => {
  recordDatabase(runId, databaseOf(url), String(expect.getState().testPath ?? 'unknown'));
});
