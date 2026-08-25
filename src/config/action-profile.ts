// The consumer's per-run action profile, parsed from the environment
// (section 4.3). Lives outside the daemon entrypoint so startup validation is
// unit-testable without executing main().
//
// DEC-14: a customer-visible profile must carry a non-empty DISCLOSURE_TEXT,
// so a missing one fails fast here, before any state change.

/** DEC-14 fallback disclosure for non-customer-visible profiles. */
export const DEFAULT_DISCLOSURE =
  'This reply was drafted by an automated assistant and reviewed by a person.';

const DELIVERIES = ['at_least_once', 'at_most_once'] as const;

export interface ActionProfile {
  actionClass: string;
  delivery: (typeof DELIVERIES)[number];
  isCustomerVisible: boolean;
  disclosure: string;
}

/**
 * Reads the four ACTION_* / DISCLOSURE_TEXT variables. Every malformed value
 * throws naming its variable, so a misconfigured deployment stops at startup.
 */
export function actionProfileFromEnv(env: NodeJS.ProcessEnv = process.env): ActionProfile {
  const actionClass = env['ACTION_CLASS'] ?? 'route_ticket';
  if (actionClass.trim().length === 0) {
    throw new Error('ACTION_CLASS must not be empty.');
  }

  const rawDelivery = env['ACTION_DELIVERY'] ?? 'at_most_once';
  const isDelivery = (
    value: string,
  ): value is (typeof DELIVERIES)[number] =>
    DELIVERIES.includes(value as (typeof DELIVERIES)[number]);
  if (!isDelivery(rawDelivery)) {
    throw new Error(
      `ACTION_DELIVERY must be one of ${DELIVERIES.join(', ')}, got '${rawDelivery}'`,
    );
  }
  const delivery: (typeof DELIVERIES)[number] = rawDelivery;

  const rawVisible = env['ACTION_IS_CUSTOMER_VISIBLE'] ?? 'false';
  if (rawVisible !== 'true' && rawVisible !== 'false') {
    throw new Error(`ACTION_IS_CUSTOMER_VISIBLE must be 'true' or 'false', got '${rawVisible}'`);
  }
  const isCustomerVisible = rawVisible === 'true';

  const disclosure = env['DISCLOSURE_TEXT'];
  if (isCustomerVisible && (disclosure === undefined || disclosure.trim().length === 0)) {
    throw new Error(
      'DISCLOSURE_TEXT is required when ACTION_IS_CUSTOMER_VISIBLE=true (DEC-14).',
    );
  }

  return {
    actionClass,
    delivery,
    isCustomerVisible,
    disclosure: disclosure ?? DEFAULT_DISCLOSURE,
  };
}
