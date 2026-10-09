// Which paths the document guards skip, and which they must not (issue #79).
//
// Three guards read this module, so a mistake here silently exempts shipped
// documentation from every one of them at once. The first version matched a
// substring, which meant a checkout under any path containing `docs/design/`
// exempted the whole repository — and nothing would have said so.
import { describe, expect, it } from 'vitest';

import { FROZEN_RECORD_DIRS, isFrozenRecord } from './frozen-records.js';

describe('a frozen record', () => {
  it('is a record under one of the named directories', () => {
    expect(isFrozenRecord('docs/design/v2-compensation.md')).toBe(true);
    expect(isFrozenRecord('docs/decisions/park-key-stops-a-duplicate-draft.md')).toBe(true);
    expect(isFrozenRecord('intent/archive/anything.md')).toBe(true);
  });

  it('is not shipped guidance', () => {
    for (const shipped of [
      'docs/operations.md', 'docs/v1-architecture.md', 'docs/quick-map.md',
      'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'src/coordinator/coordinator.ts',
    ]) {
      expect(isFrozenRecord(shipped), `${shipped} is exempt from the document guards`).toBe(false);
    }
  });

  // The canvas README gives live instructions — edit a template, run the join
  // — so it is guidance that happens to sit under a records directory.
  it('is not the console canvas, which is instructions', () => {
    expect(isFrozenRecord('docs/design/console-canvas/README.md')).toBe(false);
    expect(isFrozenRecord('docs/design/console-canvas/canvas.json')).toBe(false);
  });

  // The substring defect. A checkout at `/home/me/docs/design/auracle` made
  // every path in the repository contain the fragment.
  it('reads the path from the repository root, not as a substring', () => {
    expect(isFrozenRecord('/somewhere/docs/design/checkout/src/policy/policy.ts')).toBe(false);
    expect(isFrozenRecord('src/docs/design/helper.ts')).toBe(false);
    // A directory whose name merely starts with a frozen one.
    expect(isFrozenRecord('docs/designs/note.md')).toBe(false);
    expect(isFrozenRecord('docs/decisions-v2/note.md')).toBe(false);
  });

  it('takes an absolute path inside the repository', () => {
    const root = new URL('../../', import.meta.url).pathname;
    expect(isFrozenRecord(`${root}docs/design/a.md`)).toBe(true);
    expect(isFrozenRecord(`${root}docs/operations.md`)).toBe(false);
  });

  it('names the directories it skips, so a reader can check the list', () => {
    expect([...FROZEN_RECORD_DIRS]).toEqual(['docs/decisions', 'docs/design', 'intent/archive']);
  });
});
