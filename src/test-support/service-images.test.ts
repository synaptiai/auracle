// One tag for each test server, named the same in three places.
//
// The compose file, the CI services and the throwaway containers each start
// Postgres and GreenMail. Dependabot reads the compose file alone. So a
// proposed bump moves one pin, CI still runs the old server, and a green check
// says nothing about the new one. This suite reads all three and fails when
// one of them names another tag, or lacks a server the others start.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(ROOT + path, 'utf8');

type Pins = Record<string, string>;

/** `repo:tag` to `{ repo: tag }`, refusing an image with no tag. */
function pin(pins: Pins, image: string, where: string): void {
  const at = image.lastIndexOf(':');
  expect(at, `${where}: ${image} names no tag`).toBeGreaterThan(0);
  const repo = image.slice(0, at);
  expect(pins[repo], `${where}: ${repo} appears twice`).toBeUndefined();
  pins[repo] = image.slice(at + 1);
}

interface Services { services?: Record<string, { image?: unknown }> }

function servicePins(services: Services['services'], where: string): Pins {
  const pins: Pins = {};
  for (const [name, service] of Object.entries(services ?? {})) {
    if (typeof service.image !== 'string') continue;
    pin(pins, service.image, `${where} ${name}`);
  }
  return pins;
}

function composePins(): Pins {
  return servicePins((parse(read('docker-compose.yml')) as Services).services, 'docker-compose.yml');
}

function workflowPins(): Pins {
  const workflow = parse(read('.github/workflows/tests.yml')) as { jobs: Record<string, Services> };
  const pins: Pins = {};
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const [repo, tag] of Object.entries(servicePins(job.services, `tests.yml ${name}`))) {
      // Two jobs may start one server, but never at two tags.
      expect(pins[repo] ?? tag, `tests.yml ${name}: ${repo}`).toBe(tag);
      pins[repo] = tag;
    }
  }
  return pins;
}

/** Every top-level `const …IMAGE = '…'` in the container setup. */
function containerPins(): Pins {
  const path = 'src/test-support/containers.ts';
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const pins: Pins = {};
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !/IMAGE$/.test(declaration.name.text)) continue;
      const value = declaration.initializer;
      expect(value && ts.isStringLiteral(value), `${path}: ${declaration.name.text} is not a literal`).toBe(true);
      pin(pins, (value as ts.StringLiteral).text, `${path} ${declaration.name.text}`);
    }
  }
  return pins;
}

describe('the test servers', () => {
  const compose = composePins();

  it('are both named in the compose file', () => {
    // A scan that found nothing would let every comparison below pass.
    expect(Object.keys(compose).sort()).toEqual(['greenmail/standalone', 'pgvector/pgvector']);
  });

  it('run in CI at the tags the compose file names', () => {
    expect(workflowPins()).toEqual(compose);
  });

  it('start as throwaway containers at the tags the compose file names', () => {
    expect(containerPins()).toEqual(compose);
  });
});
