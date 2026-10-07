// One Node major, named once in `.nvmrc`.
//
// CI reads `.nvmrc`. The image names its base by a literal tag, because
// Dependabot cannot read a base image built from build arguments. So the two
// can drift: an image on a major that no CI run ever tested. This holds every
// stage of the image, and the floor in `engines`, to the major `.nvmrc` names.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(ROOT + path, 'utf8');

describe('the Node major', () => {
  const major = read('.nvmrc').trim();

  it('is a bare major version in .nvmrc', () => {
    expect(major).toMatch(/^\d+$/);
  });

  it('is the major of every image stage', () => {
    // Docker reads an instruction in any case, so the scan does too.
    const stages = read('Dockerfile').split('\n').filter((line) => /^\s*FROM\s/i.test(line));
    // A scan that found no stage would pass the loop below without looking.
    expect(stages.length).toBeGreaterThanOrEqual(2);
    for (const line of stages) {
      expect(line, line).toMatch(new RegExp(`^\\s*FROM\\s+node:${major}-`, 'i'));
    }
  });

  it('names one base image, by digest, in every image stage', () => {
    // Dependabot moves the digest one FROM line at a time. Two stages could
    // then build on different layers of the same tag.
    const images = read('Dockerfile').split('\n')
      .filter((line) => /^\s*FROM\s/i.test(line))
      .map((line) => line.trim().split(/\s+/)[1]);
    expect(images.length).toBeGreaterThanOrEqual(2);
    expect(new Set(images).size, images.join(', ')).toBe(1);
    expect(images[0]).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('is what every CI workflow reads, from .nvmrc', () => {
    // A workflow that names a version of its own tests a major the image
    // never runs.
    const dir = '.github/workflows/';
    const workflows = readdirSync(ROOT + dir).filter((name) => /\.ya?ml$/.test(name));
    let setups = 0;
    for (const name of workflows) {
      const lines = read(dir + name).split('\n');
      lines.forEach((line, at) => {
        expect(line, `${name}:${at + 1}`).not.toMatch(/^\s*node-version:/);
        if (!/uses:\s*actions\/setup-node@/.test(line)) return;
        setups += 1;
        // The step's `with:` map follows its `uses:` line.
        const step = lines.slice(at + 1, at + 6).join('\n');
        expect(step, `${name}:${at + 1}`).toMatch(/^\s*node-version-file:\s*\.nvmrc\s*$/m);
      });
    }
    // A scan that found no setup step would prove nothing.
    expect(setups).toBeGreaterThanOrEqual(1);
  });

  it('is the major of the Node types', () => {
    // Newer types let the type check accept an API the runtime lacks.
    const manifest = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> };
    expect(manifest.devDependencies['@types/node']).toMatch(new RegExp(`^\\^${major}\\.`));
  });

  it('is the major of the engines floor', () => {
    const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
    expect(engines).toMatch(new RegExp(`^>=${major}\\.`));
  });
});
