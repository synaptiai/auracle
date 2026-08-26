// Unit tests for the consumer's env-driven action profile (section 4.3).
// Pure: every case passes its own env object, so nothing touches process.env.
import { describe, expect, it } from 'vitest';

import { DEFAULT_DISCLOSURE, actionProfileFromEnv } from './action-profile.js';

type ProfileEnv = Record<string, string | undefined>;

function envWith(vars: ProfileEnv): NodeJS.ProcessEnv {
  return vars;
}

describe('actionProfileFromEnv', () => {
  it('falls back to the route_ticket defaults when no variable is set', () => {
    expect(actionProfileFromEnv(envWith({}))).toEqual({
      actionClass: 'route_ticket',
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DEFAULT_DISCLOSURE,
    });
  });

  it('passes an explicit non-visible profile through unchanged', () => {
    const env = envWith({
      ACTION_CLASS: 'route_ticket',
      ACTION_DELIVERY: 'at_least_once',
      ACTION_IS_CUSTOMER_VISIBLE: 'false',
      DISCLOSURE_TEXT: 'custom disclosure',
    });
    expect(actionProfileFromEnv(env)).toEqual({
      actionClass: 'route_ticket',
      delivery: 'at_least_once',
      isCustomerVisible: false,
      disclosure: 'custom disclosure',
    });
  });

  it('throws naming ACTION_CLASS when it is empty or blank', () => {
    for (const value of ['', '   ']) {
      expect(() => actionProfileFromEnv(envWith({ ACTION_CLASS: value }))).toThrow(
        /ACTION_CLASS/,
      );
    }
  });

  it('throws naming ACTION_DELIVERY on an unknown rule', () => {
    expect(() =>
      actionProfileFromEnv(envWith({ ACTION_DELIVERY: 'sometimes' })),
    ).toThrow(/ACTION_DELIVERY/);
  });

  it('throws naming ACTION_IS_CUSTOMER_VISIBLE on a non-boolean value', () => {
    expect(() =>
      actionProfileFromEnv(envWith({ ACTION_IS_CUSTOMER_VISIBLE: 'maybe' })),
    ).toThrow(/ACTION_IS_CUSTOMER_VISIBLE/);
  });

  it('accepts the two valid delivery rules and both visibility values', () => {
    for (const delivery of ['at_most_once', 'at_least_once']) {
      for (const visible of ['true', 'false']) {
        const profile = actionProfileFromEnv(
          envWith({
            ACTION_DELIVERY: delivery,
            ACTION_IS_CUSTOMER_VISIBLE: visible,
            DISCLOSURE_TEXT: 'reviewed by a person',
          }),
        );
        expect(profile.delivery).toBe(delivery);
        expect(profile.isCustomerVisible).toBe(visible === 'true');
      }
    }
  });

  it('DEC-14: throws naming DISCLOSURE_TEXT when visible and missing', () => {
    expect(() =>
      actionProfileFromEnv(envWith({ ACTION_IS_CUSTOMER_VISIBLE: 'true' })),
    ).toThrow(/DISCLOSURE_TEXT.*DEC-14/s);
  });

  it('DEC-14: throws when visible and DISCLOSURE_TEXT is blank', () => {
    expect(() =>
      actionProfileFromEnv(
        envWith({ ACTION_IS_CUSTOMER_VISIBLE: 'true', DISCLOSURE_TEXT: '   ' }),
      ),
    ).toThrow(/DISCLOSURE_TEXT/);
  });

  it('keeps a provided DISCLOSURE_TEXT on a visible profile', () => {
    const profile = actionProfileFromEnv(
      envWith({
        ACTION_CLASS: 'customer_reply',
        ACTION_IS_CUSTOMER_VISIBLE: 'true',
        DISCLOSURE_TEXT: 'reviewed by a person',
      }),
    );
    expect(profile.disclosure).toBe('reviewed by a person');
    expect(profile.isCustomerVisible).toBe(true);
  });
});
