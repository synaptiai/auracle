# Fixtures

This directory holds the synthetic fixture corpus.
Every value here is invented.
Invented values are what let this repository stay public.
No real customer data enters this repository.
See DEC-18.

## Accepted addresses

An address here must be unable to reach a person.
RFC 2606 and RFC 6761 reserve names for exactly that.
`.claude/hooks/fixtures_pii_guard.py` accepts these and rejects the rest:

| Domain | Reserved by |
|---|---|
| `example.com`, `example.net`, `example.org` | RFC 2606 |
| any `.example` name | RFC 2606 |
| any `.test` name | RFC 2606 |
| any `.invalid` name | RFC 2606 |
| any `.localhost` name | RFC 6761 |

A subdomain of a reserved name is reserved too, so a local part at
`mail.acme.example` passes. Any other domain is rejected here, whether or
not it is invented.

This file names domains and never a whole address. `fixtures.test.ts` holds
a stricter rule than the guard does: no email-shaped string may appear
anywhere under `fixtures/`, this README included. So an example address
written here would fail the suite, which is why none is.
A guard cannot tell an invented company from a real one.
So the rule is about reachability, not about intent.

The rule is absolute in this directory and in `evals/cases/`.
Elsewhere the guard warns and does not block a pull request.
It has no clause for a person's name, and it never reads an image.
A reader owns both of those.

## Contents

- `taxonomy.json`. The curated taxonomy of 25 intents. Each intent carries a
  risk tier per DEC-13. A high-risk intent never reaches the automatic path,
  whatever the gate values say. The `other` group stays in the list per
  section 4.11, so unmatched tickets have a target label.
- `gold/fit.json`. The fit half of the gold set. It holds 4100 synthetic cases.
- `gold/report.json`. The report half of the gold set. It also holds 4100
  synthetic cases.
- `documents.json`. Help-center documents and canonical resolutions for the
  retrieval index per DEC-22. Approved resolutions record how people actually
  solved tickets. Each entry declares an owner and a review date per DEC-23.
  The retriever drops an out-of-date document from the automatic path.

## Split discipline

The gold set holds 8200 cases. You fit on the fit half only. You report each
published number from the report half only. One case never serves both tasks.
A threshold picked on the cases that you later report on inflates the result.
See DEC-31.

The strata are the intents, and they are not equal. Frequency follows a Zipf
curve, so the most frequent intent holds 2148 cases and the rarest 86. The
split divides each stratum evenly between the halves. Each half contains every
intent, so every risk tier appears in both halves.

A stratum counts case records. The scored population is smaller, because the
replay and the gold report read first turns only. Thread counts follow the
same curve and range widely per half. Read a stratum count from the artifact
of the run, never from this file.

## Conversations

A case is one turn, not one thread. Most threads hold one turn. A minority hold
two or three. Turns of one thread share a `conversation_id` and number from 1.
See DEC-35 and DEC-38.

Each half holds whole threads, so no thread crosses the split. The
loader refuses a corpus where one does.

The replay and the gold report score first turns only, because a disposition
belongs to the whole thread. See DEC-39. The calibration job scores a
prediction against the intent label of the case, which every turn carries.
So it fits on every turn and records that population in its artifact.

## Claims

Each case carries a `claims` array. It is the ground truth the coverage fit
reads. A claim names the document it is tested against, and says whether that
document supports it. An unsupported claim carries a grade.

- `off_topic`. The claim belongs to another document entirely.
- `absent`. The claim is plausible here, and the document says nothing of it.
- `unstated_detail`. A specific the document gestures at and never states.

The last grade is the one that matters. A judge that cannot separate it
protects nothing on the automatic path. So the fitting job reports coverage per
grade, and it refuses a separation that the easy grades alone produce.

The two halves draw from disjoint sentence pools. Each document carries a fit
block and a report block, and the report sentence paraphrases its fit
counterpart. A judge sensitive to one wording therefore moves one half only.
The report half can disagree with the fit half instead of repeating it. The
loader refuses a corpus where one sentence reaches both halves. It names
that sentence by digest rather than printing it.

A paraphrase pair tests one fact twice. So a judge that mis-reads the fact
itself, rather than one wording of it, still moves both halves together. That
limit stands.

Both halves hold the same number of fully grounded drafts, 2050 of 4100.
Precision counts grounded drafts above a threshold against all drafts above it.
A half holding more of them is the easier one, and a precision published from
it reads high. The loader tests that gap with an equivalence test. So the
halves must show the gap is small rather than merely fail to prove it real.

Two one-sided tests at 5 percent put the whole interval for the difference
inside a margin of 5 points. The interval is Agresti-Caffo corrected, so a
half where every draft is grounded cannot pass on a collapsed interval.

## Checking these counts yourself

Every count above is a property of the committed files. Read them back:

```sh
node -e "
const fs = require('node:fs');
for (const half of ['fit', 'report']) {
  const g = JSON.parse(fs.readFileSync('fixtures/gold/' + half + '.json', 'utf8'));
  const drafts = g.tickets.filter((t) => (t.claims ?? []).length > 0);
  const sentences = new Set(drafts.flatMap((t) => t.claims.map((c) => c.text)));
  const grounded = drafts.filter((t) => t.claims.every((c) => c.supported)).length;
  console.log(half, 'cases', g.tickets.length, 'drafts', drafts.length,
    'sentences', sentences.size, 'grounded', grounded);
}
const docs = JSON.parse(fs.readFileSync('fixtures/documents.json', 'utf8')).documents;
console.log('documents', docs.length, 'kinds', new Set(docs.map((d) => d.kind)).size);
"
```

The two halves must report 156 sentences each and 2050 grounded drafts each.
The two sentence sets must not intersect. That is 312 sentences over 39
documents.

## Ticket schema

Each ticket object carries these fields.

- `ticket_id`. Synthetic id with a `SYN-` prefix.
- `source`. Always `synthetic`.
- `intent`. Label from the curated taxonomy.
- `queue`. The queue that received the ticket.
- `disposition`. Observable outcome, see below.
- `subject`, `body`. Invented ticket text.
- `conversation_id`. Synthetic thread id with a `CONV-SYN-` prefix.
- `turn_number`. Position in the thread, counting from 1.
- `agent_reply`. The invented reply that answered this turn. The last turn of a
  thread carries none, because no reply followed it. A later turn's prompt
  carries the earlier turns and their replies, per DEC-37.
- `claims`. The per-claim ground truth described above.

A disposition records an observable result of the work. The fields are
`escalated`, `macro_applied`, `refund_issued` and `first_reply_minutes`. Action
match scores these dispositions. It does not score the intent label.

Dispositions describe what happened, so they grade routing without any labels.
An intent label records only what the system predicted.
See DEC-32.

## Regeneration

The script `scripts/generate-fixtures.mjs` builds this corpus from one fixed
seed:

```sh
node scripts/generate-fixtures.mjs
```

The output is deterministic. A committed file must match the generator output
byte for byte. If you change the generator, regenerate the whole corpus and
commit both together.
