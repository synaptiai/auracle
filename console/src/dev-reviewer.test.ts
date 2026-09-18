// The development reviewer (DEC-45).
//
// The exception is what needs the cases, not the identity. A console that
// accepted `CONSOLE_DEV_REVIEWER` from an image, or from a bind off loopback,
// would serve whoever reached it as a reviewer the roster holds — which is
// the one way this gate could be worse than none at all.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { developmentReviewer } from './dev-reviewer.js';

/** A call from a console run from source on loopback, the ordinary case. */
function asked(overrides: Partial<Parameters<typeof developmentReviewer>[0]> = {}) {
  return developmentReviewer({
    wanting: 'dev@example.test',
    host: '127.0.0.1',
    moduleUrl: 'file:///src/console/src/main.ts',
    identityHeader: undefined,
    ...overrides,
  });
}

describe('the development reviewer (DEC-45)', () => {
  it('names the identity, for a console run from source on loopback', async () => {
    expect(asked()).toBe('dev@example.test');
    // Every loopback spelling an operator may bind, and the trimmed value.
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) {
      expect(asked({ host, wanting: ' dev@example.test ' }), host).toBe('dev@example.test');
    }
  });

  it('names nobody when the variable is unset or empty', async () => {
    expect(asked({ wanting: undefined })).toBeUndefined();
    expect(asked({ wanting: '' })).toBeUndefined();
    expect(asked({ wanting: '   ' })).toBeUndefined();
  });

  // The exception is for the console someone is working on. An image serves a
  // deployment, where there is no development and no proxy to name anyone.
  it('refuses to start when the variable is set on compiled output', async () => {
    for (const moduleUrl of [
      'file:///app/dist/console/src/main.js',
      'file:///app/console/src/main.cjs',
    ]) {
      expect(() => asked({ moduleUrl }), moduleUrl).toThrow(/run from source/);
    }
  });

  // Off loopback, everyone who can reach the port would be that reviewer.
  it('refuses to start when the variable is set off loopback', async () => {
    for (const host of ['0.0.0.0', '::', 'console.internal.example', '10.0.0.7', '127.0.0.1.example']) {
      expect(() => asked({ host }), host).toThrow(/bound to loopback/);
    }
  });

  // Both at once is the fail-open this variable must not create. The
  // development reviewer stands in for a proxy, so a console behind one that
  // also served as the developer would answer a request the proxy did not
  // name — and record the approval against the developer.
  it('refuses to start when a proxy header is named as well', async () => {
    expect(() => asked({ identityHeader: 'x-forwarded-user' })).toThrow(/both set/);
  });

  // The variable names a reviewer, so it holds a value the ledger would
  // record. Refused here, where the operator can read it, and not at the
  // first request, where it would refuse everyone with no explanation.
  it('refuses a name the ledger would not record', async () => {
    expect(() => asked({ wanting: 'unattributed' })).toThrow(/would not record/);
    expect(() => asked({ wanting: 'a'.repeat(257) })).toThrow(/would not record/);
  });
});

// The exception must not reach a deployment, and two things would have to be
// true at once for it to. A deployment file would have to name the variable,
// and the console there would have to run from source. The second is
// structural: the image's runtime stage copies the two `dist` trees and no
// source at all. So these cases hold the first, and the image's COPY set is
// asserted rather than its contents, because a built image is not in reach of
// a unit test.
describe('the deployments that must not name the development reviewer', () => {
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const DEPLOYMENTS = [
    'docker-compose.yml',
    'docker-compose.dev.yml',
    '.github/workflows/release.yml',
    'docker/entrypoint.sh',
  ];

  it('sets it in no deployment file', () => {
    for (const file of DEPLOYMENTS) {
      const source = readFileSync(ROOT + file, 'utf8');
      // A comment may name it, and one of these files explains why it is not
      // set. A line that is not a comment and names it is a deployment that
      // would serve as that reviewer, which is the thing to refuse.
      const settings = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .filter((line) => line.includes('CONSOLE_DEV_'));
      expect(settings, file).toEqual([]);
    }
  });

  // The behavioural check reads the module URL, so the image must hold no
  // console source for it to pass there. It copies `dist` and the core's
  // package files, and nothing under `console/src`.
  //
  // `products.json` joined the list with DEC-47, and it is data rather than
  // source: the channel map a process reads at startup, as `db/` and
  // `fixtures/` are. The rule this case holds is that no source tree reaches
  // the runtime stage, so the file is named here rather than the rule
  // loosened.
  it('ships compiled output, so the source check cannot pass in the image', () => {
    const dockerfile = readFileSync(ROOT + 'Dockerfile', 'utf8');
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    const copies = runtime.split('\n').filter((line) => line.startsWith('COPY'));
    // A slice that found the wrong stage, or a scan with no lines in it,
    // would pass the loop below without examining anything.
    expect(copies.length).toBeGreaterThanOrEqual(5);
    for (const line of copies) {
      expect(line, line).not.toMatch(/console\/src|\/src\b/);
      expect(line, line).toMatch(
        /dist|package\.json|db\b|fixtures|entrypoint\.sh|products\.json/,
      );
    }
    // And the console's entry point is the compiled one, not a source run.
    expect(readFileSync(ROOT + 'docker/entrypoint.sh', 'utf8')).not.toContain('tsx');
  });
});
