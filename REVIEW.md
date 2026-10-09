# Review Guide

Every change passes three reviews before merge. Run them in this order.

## Pass 1. Bugs

Check correctness against the claimed behavior.

- Run `pnpm run verify`. Paste its output, the exit code and the skip count.
- Read the concurrency rules in section 3.4 of `docs/v1-architecture.md`. Check outbox inserts, epochs and
  idempotency keys against them. The epoch is a number that increases. It makes
  a write from a stale owner fail instead of corrupt the state. The
  idempotency key comes from the action data, not the run identity. Two runs of
  one request therefore share a key and land once on the target.
- Check liveness. A run must not wait for a result that no component supplies.
  A run that loses an outbox insert must stop as `superseded`, never wait in
  `queued`.
- Check the relay order. The relay sends first and sets the status second.
  A status written before the send turns a crash into a silent loss.

## Pass 2. Security

Check data exposure and injection surface.

- No real customer data enters fixtures, evals or examples (DEC-18).
- No secret, key or token enters the repository or the logs.
- Adapter payloads stay inside the declared capability manifest (DEC-06). Each
  adapter declares the actions and payload fields that it supports. A payload
  outside that declaration means the adapter acts beyond its promise.
- Prompt logging stays off in the provider account (section 6 of
  `docs/v1-architecture.md`). No code here turns it on. Turning it on grants
  the provider commercial rights to every prompt and completion.

## Pass 3. Compliance

Check the change against `docs/v1-architecture.md`.

- Every behavior change cites a DEC or states that it is an implementation
  detail.
- A change that cites a DEC commits a design record, as `CONTRIBUTING.md`
  section 4 says. CI proves a record is well formed. Only a reader can tell
  whether a change needs a record and has one.
- No change blends the two gates into one score (DEC-05). Each gate catches a
  failure the other cannot see. A blend lets one strong signal mask one failed
  gate.
- Customer replies keep approval and a non-empty disclosure field
  (DEC-12, DEC-14). Nobody can recall a sent reply. The disclosure tells the
  customer that a machine produced the text.
- Shipped markdown follows Simplified Technical English.

## Severity

Important means one of these:

- The change breaks behavior that a test claims to prove.
- The change exposes data or writes real customer data into the repository.
- The change contradicts a DEC without a decision that changes the DEC.

Everything else is a nit. A review reports at most five nits. Discard nits
above five.

## Checklists

The verification checklist backs the verifier subagent. The adversarial
checklist backs the adversarial reviewer subagent. Both subagents live under
`.claude/agents/`. A checklist runs where no subagent does, and a subagent
that runs still answers to the checklist below.

### Verification checklist

- The description holds the output of `pnpm run verify`.
- The output states the exit code and the skip count.

### Adversarial checklist

Run on any behavioral change to ledger, coordinator, relay, classifier,
gates or policy engine.

1. Concurrency, section 3.4. Two runs on one ticket. An outbox insert that
   returns zero rows. Zero rows means another run won the insert, so this run
   must stop, not continue. A write with a stale epoch. Different refunds
   produce different keys, so no constraint catches the collision.
2. Liveness, sections 4.2 and 4.4. A run that waits with no supplier. Send
   first versus status first. Retry on unknown delivery state. A retry after an
   unknown outcome can pay twice.
3. Statistical, sections 3.2 and 4.10. Agreement on a confident error.
   Samples that agree can all carry the same wrong answer. Threshold selection
   on the report half of the gold set. Gates blended into one score.
4. Attack the proving test as hard as the change. A test that cannot fail
   proves nothing.

Record each attack outcome in the review. Name the section or DEC that
motivates each attack.

## Backstop coverage

| Rule | Session backstop | CI enforces the rule | CI tests the guard |
|---|---|---|---|
| Synthetic fixtures | PII validator hook | yes | yes |
| DEC citation on register changes | commit hook | yes | yes |
| No test edits during a bug fix | none, by decision | no | n/a |
| Live database approval | live-db validator hook | no | yes |
| Simplified Technical English | none | rules 1 and 2 | yes |
| A design record cites a defined DEC | none | yes | yes |
| Section 7.1 names every design document, by a name that says what it is | none | yes | yes |
| No test title cites an issue number | none | yes | yes |
| The release workflow checks the image before it publishes it | none | yes | n/a |
| Fixtures match the generator | none | yes | n/a |

The last two columns differ on purpose. A job that runs a guard's own tests
proves the guard works. It does not apply the rule to the pull request.

CI applies two rules to no pull request. The test-edit rule is a review duty.
The live-database rule depends on context that exists only inside a session.
State this when it matters. Do not claim that CI checks these rules.

CI enforces half of the design-record rule. It runs every refusal that
`CONTRIBUTING.md` section 4 lists. It cannot prove whether a change needs a
record and has one, because that depends on the diff. Pass 3 above owns that
reading.

The test-edit rule has no checker. A checker would block the regression test
that a bug fix adds. The bugs pass owns the rule. A fix adds a failing-first
test and never relaxes an existing assertion.

The PII guard has no clause for a person's name. It never reads an image.
It matches an email address, a phone number and a customer identifier.
So the DEC-18 box in the pull request template promises more than the guard
decides. The compliance pass owns the rest.
