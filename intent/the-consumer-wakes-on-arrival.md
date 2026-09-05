# Intent: The consumer wakes on arrival

## Problem

The consumer slept through the arrivals it was waiting for.

`pnpm run latency` over a synthetic history of 2397 runs reported a mean queue
wait of 2.78 s against a poll floor of 2.50 s, at 1.37 per cent utilisation.
Ninety per cent of the wait was the loop's own sleep. One run in a hundred
waited longer than one poll period, so almost nothing queued at all.

The V2 design document names three sources of delay. Two of them get five
mapped corrections. The third is the sleep, and it had none. The measurement
indicts the third.

## Proposed outcome

Intake signals the consumer inside the enqueue transaction. The consumer holds
one dedicated connection, listens on that channel, and ends its interval sleep
when a message it owns arrives. Wait `p50` and `p95` fall from 2.4 to 2.6 s
and 4.7 to 4.8 s to a figure the poll no longer sets.

`CONSUMER_INTERVAL_MS` stays as a ceiling. A lost notification costs the
latency the system had before the signal existed, and nothing else.

## Affected users and systems

An operator reads a queue wait of zero on a healthy partition. Any wait above
zero is now a message that queued behind a batch, so the runbook's triage
table reads differently and states the new meaning.

The webhook ingress, the IMAP ingress and every other caller of
`enqueueTicket` emit the signal, because it lives in that function.

## Constraints

- DEC-27 rejects a lease and a lock service. A notification is neither: it
  grants no exclusivity and no mutual exclusion, and ownership still comes
  from the partition assignment.
- DEC-28 is untouched. No write path changes, and the fencing epoch still
  covers a rebalance overlap.
- DEC-36 is untouched. The partition key does not move.
- DEC-25 bounds cost, steps and clock time. None of the three moves, and the
  scan still walks one ticket at a time.
- DEC-18. The measurement comes from synthetic traffic only.
- The listener never takes a client from a daemon's pool. Every daemon builds
  its pool with `max: 1`, and a `LISTEN` client is held for the process
  lifetime.

## Decisions affected

none. This is an implementation detail of the consumer loop. The register
specifies that one consumer owns each partition and that every write carries a
fencing epoch. It does not specify how a consumer learns that work exists.

The restatement of open item 7 edits `docs/v1-architecture.md`, so it cites
DEC-27 and DEC-12 as the two decisions the measurement explains. It changes
neither.

## Open questions

Head-of-line delay itself. It stays open, because this change corrects at
most a small part of it. The maximum wait moves from 2.3 minutes to 2.2
minutes on the deepest partition, and about one run in a hundred still waits
behind the batch ahead of it.
`src/seed/plan.test.ts` asserts that share never rises with the signal, and
never falls by half, across six seeds. So the wake can never be reported as
the correction.

The history runs at 53 tickets a day against two consumers, which is 1.37 per
cent of their capacity, so saturating them needs about 3 900 a day. An
adopter near that volume reads the four rules again and picks from the five
options the design document maps.
