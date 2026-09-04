# Review Guide

Every change passes three reviews before merge. Run them in this order.

## Pass 1. Bugs

Check correctness against the claimed behaviour.

- Run the build, the tests and the lint. Paste the output.
- Read the concurrency rules in section 3.4. Check outbox inserts, epochs and
  idempotency keys against them. The epoch is a number that increases. It makes
  a write from a stale owner fail instead of corrupt the state. The
  idempotency key comes from the action data, not the run identity. Two runs of
  one action therefore share a key and land once on the target.
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
- The prompt-log path stays off unless an override exists (section 6).
  Activating it grants commercial rights to every prompt and completion.

## Pass 3. Compliance

Check the change against `docs/v1-architecture.md`.

- Every behaviour change cites a DEC or states that it is an implementation
  detail.
- No change blends the two gates into one score (DEC-05). Each gate catches a
  failure the other cannot see. A blend lets one strong signal mask one failed
  gate.
- Customer replies keep approval and a non-empty disclosure field
  (DEC-12, DEC-14). A sent reply cannot be recalled. The disclosure tells the
  customer that a machine produced the text.
- Shipped markdown follows Simplified Technical English.

## Severity

Important means one of these:

- The change breaks behaviour that a test claims to prove.
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

- The build, the tests and the lint ran. The output is pasted above.
- Each command states its exit code.

### Adversarial checklist

Run on any behavioural change to ledger, coordinator, relay, classifier,
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

Record each attack outcome in the card review feedback. Name the section or
DEC that motivated each attack.

## Backstop coverage

| Rule | Session backstop | CI enforces the rule | CI tests the guard |
|---|---|---|---|
| Synthetic fixtures | PII validator hook | yes | yes |
| DEC citation on register changes | commit hook | yes | yes |
| No test edits during a bug fix | test-edit-lock hook | no | no |
| Live database approval | live-db validator hook | no | yes |
| Simplified Technical English | none | rules 1 and 2 | yes |
| An intent file for each change | none | no | no |
| Fixtures match the generator | none | yes | n/a |

Two columns exist because they differ. A job that runs a guard's own cases
proves the guard works. It does not apply the rule to the pull request.

Three rules are not enforced on a pull request. Two of them depend on context
that exists only inside a session. One has no checker at all. State this
when it matters. Do not pretend coverage exists.
