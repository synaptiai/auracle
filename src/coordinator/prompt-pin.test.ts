// The prompt pin cannot take the one value the ledger reserves.
//
// `abandonMessage` files a run with both pins set to 'intake', and the latency
// report reads that pair as a run that never entered service. A deployment
// setting PROMPT_VER=intake would put every real run under the same label, so
// the service distribution empties and the count an operator reads as a
// failing partition spikes on a healthy one. Section 4.5's rule applies: this
// is enforced with an assertion, not a comment.

import { afterEach, describe, expect, it } from 'vitest';

import { requirePromptVer } from './consumer-main.js';

const saved = process.env['PROMPT_VER'];

afterEach(() => {
  if (saved === undefined) delete process.env['PROMPT_VER'];
  else process.env['PROMPT_VER'] = saved;
});

describe('the prompt pin', () => {
  it('takes the documented default when nothing is set', () => {
    delete process.env['PROMPT_VER'];
    expect(requirePromptVer()).toBe('consumer-prompt-v1');
  });

  it('takes any name a deployment gives it', () => {
    process.env['PROMPT_VER'] = 'consumer-prompt-v2';
    expect(requirePromptVer()).toBe('consumer-prompt-v2');
  });

  it('refuses the value the ledger reserves for a run that never executed', () => {
    process.env['PROMPT_VER'] = 'intake';
    expect(() => requirePromptVer()).toThrow(/reserves that value/);
  });

  it('treats an empty setting as unset, rather than as a pin named nothing', () => {
    process.env['PROMPT_VER'] = '';
    expect(requirePromptVer()).toBe('consumer-prompt-v1');
  });
});
