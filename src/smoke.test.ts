import { describe, expect, it } from 'vitest';

import { NAME } from './index.js';

describe('toolchain smoke', () => {
  it('runs the empty module graph', () => {
    expect(NAME).toBe('auracle');
  });
});
