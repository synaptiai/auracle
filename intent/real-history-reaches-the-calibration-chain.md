# Intent: real history reaches the calibration chain

## Problem

The curation loop of `docs/operations.md` moves real mailbox history through
the offline jobs. Its last step did not run. The runbook conceded it and
named the work as deferred.

Five guards blocked a labeled half of real history. The loaders read the
committed corpus from a fixed location. The half validator demanded the
literal `synthetic`. The case validator demanded the generator's identifier
prefixes. Both fitting jobs demanded the literal `synthetic`, and the
agreement fit also demanded exactly 385 cases.
And `gold_source` was the literal `synthetic` in all three artifact types.

The last guard reached the runtime. A threshold fitted on real history wrote
an artifact that its own validator refused. The startup resolver loads
through that validator, so a real fit stopped every daemon that read the
result. Fitting on your own data broke the system.

The export also folded a whole thread into one record. Real history was the
one input that still arrived flattened. It could not exercise the multi-turn
prompts the runtime sends.

## Proposed outcome

An adopter carries their own labeled history through the whole offline
chain. Every number that comes out names the data behind it.

A gold half declares its provenance from a closed set. Each artifact records
it, and each process logs it at startup. A daemon starts against an artifact
fitted on real history.

The export emits one record per customer turn. Turn order comes from each
message's own stated time, and every fallback to delivery order is counted
and reported. An agent reply hangs off the turn it answered.

Nothing real is committed. The repository publishes synthetic numbers only.

## Affected users and systems

An operator running the curation loop. The two fitting jobs, the gold
report, the taxonomy induction job and the corpus export. The startup
resolver every daemon calls. No runtime ingress path changes.

## Constraints

- DEC-18. Nothing real enters this repository. `corpus/` stays gitignored and
  the committed fixtures stay synthetic and byte-identical.
- DEC-31. Fit and report stay disjoint. A job that consumes a real half
  refuses to run until the caller names the other half. It takes identifiers
  from that half and reads none of its cases.
- DEC-05. The two gates stay independent. No path joins a coverage value to
  an agreement value.
- DEC-35, DEC-37, DEC-38, DEC-39. A record belongs to a conversation. A later
  turn carries the turns before it, a reply takes no turn number of its own.
  The jobs that score a disposition still read first turns only.
- DEC-10. The induction job clusters first turns, so a follow-up never spends
  one of the 25 intents.

## Decisions affected

None. Every change is an implementation detail. The decisions above constrain
the work and none of them changes.

## Open questions

None outstanding. Review raised the equal-size question and it is settled.
DEC-31 splits one gold set into two halves. So `assertHalvesDisjoint` refuses
a pair of different sizes, of different provenance, or of the same split.
