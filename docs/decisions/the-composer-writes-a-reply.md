# Intent: the composer writes a reply, not a list of claims

## Problem

The composer's prompt asked for one claim per line. The draft was those lines
joined. That contract can only produce a list of assertions.

A run drafted eight cited assertions. The reply had no opening and no closing.
It addressed nobody. A person opened the approval queue and could not read it
as a reply, because it was not one.

The seeded history reproduced the same shape, which is what made it visible.
The shape came from the composer.

## Proposed outcome

The composer writes the reply a support person would send. It stays one model
call. Every fact still cites a retrieved document.

The composer partitions its own output and labels each sentence. A claim cites
a span. A courtesy sentence opens or closes the reply and states no fact.

The draft is those sentences in order. The text a customer reads is the text
the gate scored.

The console draws the whole reply. It marks every uncited sentence, and it
says how many of them there are.

## Affected users and systems

An approver reads the reply on the console. A customer reads it after an
approval.

The composer, the coordinator's compose row, the journal reader, the console
and the seeder all change. The groundedness gate does not.

## Constraints

- Coverage counts claims alone (DEC-05, DEC-07). A courtesy sentence never
  enters the fraction, so no published number moves.
- The gate records a verdict by position among the cited sentences. A courtesy
  sentence advances no position.
- One model call. A second call rewriting claims into prose separates the sent
  text from the scored text. Section 4.7 records that failure as removed.
- The parser accepts one optional courtesy sentence, the claims, and one
  optional courtesy sentence. A draft that cites nothing abstains (DEC-07).
- No check proves a courtesy sentence carries no fact. The parse, the console
  marking and DEC-12 approval carry that risk, and DEC-43 states it.
- The seeder calls no model. CI diffs the corpus against its generator.
- The erasure statement in `docs/operations.md` reaches the new key.

## Decisions affected

Affects: DEC-43, DEC-05, DEC-07, DEC-12, DEC-18, DEC-23

DEC-43, ratified by this change. Obeys DEC-05, DEC-07, DEC-12, DEC-18, DEC-23.

## Open questions

None.

The prompt gained a worked example after a live run. The model wrote a marker
on one line and its sentence on the next. It did so twice in three attempts.
The parser reads that as a marker with no sentence, so a well written reply
became an abstain. The instruction and the example are pinned by a test.
