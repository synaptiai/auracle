// The artifact-name scan as a pure function.
//
// The interesting cases are platform-specific: a case-sensitive filesystem
// holds 'v1.json' and 'V1.json' as two entries and a case-insensitive one
// cannot, so a test that builds real files can only ever cover the machine it
// runs on. CI is Linux and this repository is developed on macOS, which is
// how a defect reached HEAD that no local run could fail on.
import { describe, expect, it } from 'vitest';

import { selectArtifactName } from './artifact.js';

describe('selectArtifactName', () => {
  it('answers nothing for an empty directory', () => {
    expect(selectArtifactName([])).toBeNull();
  });

  it('takes the highest version', () => {
    expect(selectArtifactName(['v2.json', 'v10.json', 'v9.json'])).toEqual({
      name: 'v10.json',
      version: 10,
    });
  });

  it('reads a capitalised name, which a case-insensitive filesystem keeps', () => {
    // The writer emits lowercase, but the directory entry keeps the case it
    // was created with. Refusing this refuses a real artifact.
    expect(selectArtifactName(['V1.json'])).toEqual({ name: 'V1.json', version: 1 });
  });

  it.each([
    [['v1.json', 'V1.json']],
    [['V1.json', 'v1.json']],
  ])('refuses two spellings of one version, whatever the listing order (%#)', (names) => {
    // On a case-sensitive filesystem both are real, both parse to 1, and the
    // comparison is strict, so the listing order would decide which threshold
    // governs the live gate. Nothing downstream records the file name, so two
    // runs could publish different rates under one version number.
    expect(() => selectArtifactName(names)).toThrow(/2 files for version 1/);
  });

  it('names both files in the collision message, in a stable order', () => {
    const message = (() => {
      try {
        selectArtifactName(['v1.json', 'V1.json']);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toContain('V1.json, v1.json');
  });

  it('allows one spelling per version across different versions', () => {
    expect(selectArtifactName(['v1.json', 'V2.json'])).toEqual({
      name: 'V2.json',
      version: 2,
    });
  });

  it.each([['v01.json'], ['v0.json'], ['v1e5.json'], ['V0.JSON']])(
    'refuses %s, which is not a name this module writes',
    (name) => {
      expect(() => selectArtifactName([name])).toThrow(/not a versioned artifact/);
    },
  );

  it('refuses a version too large to read back', () => {
    expect(() => selectArtifactName(['v1000000000000000000000.json'])).toThrow(
      /too large to read/,
    );
  });

  it('refuses a collision on a version that is not the highest', () => {
    // Mutation testing found this gap: scoping the collision check to the
    // winning version would have shipped green. A lower version collides just
    // as badly once it is asked for by name.
    expect(() => selectArtifactName(['v1.json', 'V1.json', 'v2.json'])).toThrow(
      /2 files for version 1/,
    );
  });

  it.each([['vendor.json'], ['versions.json'], ['valid.json']])(
    // notes.txt and .DS_Store were here too and could not fail: no plausible
    // weakening of either guard reaches a name that is not .json-shaped.
    'leaves the operator file %s alone',
    (name) => {
      expect(selectArtifactName([name, 'v1.json'])).toEqual({ name: 'v1.json', version: 1 });
    },
  );
});
