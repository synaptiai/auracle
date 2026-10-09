// Which readers' URL a long-running process takes.
//
// No database suite can reach these paths: the test setup always publishes
// READER_DATABASE_URL. The ways the choice can fail:
//
//   1. It returns nothing usable, or the compose default, when the variable
//      is set.
//   2. It falls back to the compose default without the opt-in.
//   3. It falls back to the compose default beside a writer aimed at another
//      ledger, so reviewers read one ledger and approve into another.
//   4. Its refusal beside such a writer advises the opt-in that is already
//      set, which changes nothing.
//   5. It refuses the compose default with the opt-in beside the compose
//      writer, or beside none, which is the local run the opt-in exists for.
//   6. It takes the compose writer spelled another way as another ledger,
//      or a writer the driver sends elsewhere as the compose writer.
//   7. It reports a writer's URL the driver cannot read as another ledger,
//      which sends the operator to the wrong variable.
import { afterEach, describe, expect, it } from 'vitest';

import { ALLOW_COMPOSE_DEFAULT, requireReaderDbUrl } from './config.js';

const SAVED = {
  reader: process.env.READER_DATABASE_URL,
  writer: process.env.DATABASE_URL,
  allow: process.env[ALLOW_COMPOSE_DEFAULT],
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv('READER_DATABASE_URL', SAVED.reader);
  setEnv('DATABASE_URL', SAVED.writer);
  setEnv(ALLOW_COMPOSE_DEFAULT, SAVED.allow);
});

const COMPOSE_WRITER = 'postgres://auracle:auracle@localhost:5433/auracle';
const COMPOSE_READER = 'postgres://auracle_reader:auracle_reader@localhost:5433/auracle';

describe('requireReaderDbUrl', () => {
  it('takes the variable when it is set', () => { // 1
    setEnv('READER_DATABASE_URL', 'postgres://auracle_reader:x@ledger.example.test:5432/auracle');
    setEnv('DATABASE_URL', 'postgres://auracle:y@ledger.example.test:5432/auracle');
    setEnv(ALLOW_COMPOSE_DEFAULT, '1');
    expect(requireReaderDbUrl('the console')).toBe('postgres://auracle_reader:x@ledger.example.test:5432/auracle');
  });

  it('refuses to guess without the opt-in', () => { // 2
    setEnv('READER_DATABASE_URL', undefined);
    setEnv('DATABASE_URL', COMPOSE_WRITER);
    setEnv(ALLOW_COMPOSE_DEFAULT, undefined);
    expect(() => requireReaderDbUrl('the console'))
      .toThrow(/^the console needs READER_DATABASE_URL.*or set AURACLE_ALLOW_COMPOSE_DEFAULT=1 for a local run\.$/);
  });

  it('takes the compose default with the opt-in, beside the compose writer or none', () => { // 5
    setEnv('READER_DATABASE_URL', '');
    setEnv(ALLOW_COMPOSE_DEFAULT, '1');
    setEnv('DATABASE_URL', COMPOSE_WRITER);
    expect(requireReaderDbUrl('the console')).toBe(COMPOSE_READER);
    setEnv('DATABASE_URL', undefined);
    expect(requireReaderDbUrl('the console')).toBe(COMPOSE_READER);
  });

  it('knows the compose writer however it is spelled', () => { // 6
    setEnv('READER_DATABASE_URL', undefined);
    setEnv(ALLOW_COMPOSE_DEFAULT, '1');
    for (const writer of [
      'postgres://auracle:auracle@127.0.0.1:5433/auracle',
      'postgres://auracle:auracle@localhost:5433/auracle?sslmode=disable',
      'postgres://auracle:auracle@LOCALHOST:5433/auracle',
    ]) {
      setEnv('DATABASE_URL', writer);
      expect(requireReaderDbUrl('the console'), writer).toBe(COMPOSE_READER);
    }
    // The driver lets the query replace the host, port or user, and a URL it
    // cannot read names no ledger.
    for (const writer of [
      'postgres://auracle:auracle@localhost:5433/auracle?host=ledger.example.test',
      'postgres://auracle:auracle@localhost:5433/auracle?port=6543',
      'postgres://auracle:auracle@localhost:5433/auracle?user=someone',
    ]) {
      setEnv('DATABASE_URL', writer);
      expect(() => requireReaderDbUrl('the console'), writer).toThrow(/DATABASE_URL names another ledger/);
    }
  });

  it('names a writer\'s URL the driver cannot read as that', () => { // 7
    setEnv('READER_DATABASE_URL', undefined);
    setEnv(ALLOW_COMPOSE_DEFAULT, '1');
    for (const writer of [
      'postgres://auracle:auracle@localhost:5433/auracle?sslrootcert=/no/such/file',
      'postgres://auracle:auracle@localhost:99999/auracle',
    ]) {
      setEnv('DATABASE_URL', writer);
      expect(() => requireReaderDbUrl('the console'), writer)
        .toThrow(/ DATABASE_URL could not be read: .+\. Correct it, or set READER_DATABASE_URL\.$/);
    }
  });

  it('refuses the compose default beside a writer on another ledger, and says why', () => { // 3, 4
    setEnv('READER_DATABASE_URL', undefined);
    setEnv(ALLOW_COMPOSE_DEFAULT, '1');
    setEnv('DATABASE_URL', 'postgres://auracle:y@ledger.example.test:5432/auracle');
    let message = '';
    try {
      requireReaderDbUrl('the console');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL names another ledger\. Set READER_DATABASE_URL to that ledger\.$/);
    expect(message).not.toContain('or set AURACLE_ALLOW_COMPOSE_DEFAULT=1');
  });
});
