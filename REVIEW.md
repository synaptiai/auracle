# Review Guide

Every change passes three reviews before merge. Run them in this order.

## Pass 1. Bugs

Check correctness against the claimed behaviour.

- Run the build, the tests and the lint. Paste the output.
- Read the concurrency rules in section 3.4. Check outbox inserts, epochs and
  idempotency keys against them.
- Check liveness. A run must not wait for a result that no component supplies.
- Check the relay order. The relay sends first and sets the status second.

## Pass 2. Security

Check data exposure and injection surface.

- No real customer data enters fixtures, evals or examples (DEC-18).
- No secret, key or token enters the repository or the logs.
- Adapter payloads stay inside the declared capability manifest (DEC-06).
- The prompt-log path stays off unless an override exists (section 6).

## Pass 3. Compliance

Check the change against `docs/v1-architecture.md`.

- Every behaviour change cites a DEC or states that it is an implementation
  detail.
- No change blends the two gates into one score (DEC-05).
- Customer replies keep approval and a non-empty disclosure field
  (DEC-12, DEC-14).
- Shipped markdown follows Simplified Technical English.

## Severity

Important means one of these:

- The change breaks behaviour that a test claims to prove.
- The change exposes data or writes real customer data into the repository.
- The change contradicts a DEC without a decision that changes the DEC.

Everything else is a nit. A review reports at most five nits. Discard nits
above five.

## Checklists

The verification checklist replaces a verifier subagent. The adversarial
checklist replaces an adversarial reviewer subagent.

### Verification checklist

- The build, the tests and the lint ran. The output is pasted above.
- Each command states its exit code.

### Adversarial checklist

Run on any behavioural change to ledger, coordinator, relay, classifier,
gates or policy engine.

1. Concurrency, section 3.4. Two runs on one ticket. An outbox insert that
   returns zero rows. A write with a stale epoch. Different refunds that
   produce different keys.
2. Liveness, sections 4.2 and 4.4. A run that waits with no supplier. Send
   first versus status first. Retry on unknown delivery state.
3. Statistical, sections 3.2 and 4.10. Agreement on a confident error.
   Threshold selection on the report half of the gold set. Gates blended
   into one score.
4. Attack the proving test as hard as the change. A test that cannot fail
   proves nothing.

Record each attack outcome in the card review feedback. Name the section or
DEC that motivated each attack.

## Backstop coverage

| Rule | Session backstop | CI backstop |
|---|---|---|
| Synthetic fixtures | PII validator hook | guardrails.yml job |
| DEC citation on register changes | commit hook | guardrails.yml job + commit-msg hook |
| No test edits during a bug fix | test-edit-lock hook | none |
| Live database approval | live-db validator hook | none |

Two rules have no CI surface because their context exists only inside a
session. State this when it matters. Do not pretend coverage exists.
