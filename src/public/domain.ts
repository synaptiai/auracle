// The design constants and pure judgements a surface needs to describe a run.
//
// These are the numbers and rules the architecture fixes, so a second
// interface renders the same system rather than a similar one.
export { CLASSIFIER_K } from '../classifier/classifier.js';
export { LOOKBACK_DAYS, METRICS } from '../bands/metrics.js';
export type { MetricName, Direction, MetricDefinition } from '../bands/metrics.js';
export { evaluateMetric } from '../bands/evaluate.js';
export { escalationHead } from '../escalations/reason.js';
export { COMPENSATION_ACTION_CLASS } from '../adapters/types.js';
// The name an approval records, so a surface names the same person the
// ledger would (DEC-42).
export { approverFrom, UNATTRIBUTED } from '../approval/approver.js';
