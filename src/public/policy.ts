// The policy engine's vocabulary, for a surface that has to explain a verdict.
//
// `evaluatePolicy` is a pure function that calls no model and reads no state
// (DEC-05, DEC-06). A console renders its reasons; it never re-derives them.
//
// Named, not `export *`. The wildcard published nineteen declarations to make
// four reachable, and the README's claim — that a symbol reaches another
// package only by being named here — was not true of this file. Everything a
// wildcard exports also becomes public API that nobody can remove later
// without knowing who took it.
export { POLICY_REASONS, reachedAgreementGate, readCoverageGate } from '../policy/policy.js';
export type { PolicyReason } from '../policy/policy.js';
