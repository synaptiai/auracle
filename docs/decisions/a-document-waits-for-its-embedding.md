# A document waits for its embedding

## Problem

A reviewer may write a document from a case, and the console calls no model
(DEC-50). So a document the console writes has no vector yet. Today every
document must carry one: the column refuses a row without it. Only the
markdown loader embeds, and it runs by hand.

Retrieval reads two channels and fuses their ranks (DEC-21). The lexical
channel alone can rank a document with words and no vector. That skews the
fusion, and DEC-50 says retrieval ignores the document until a consumer embeds
it.

The loader also upserts a whole row. So a reload rewrites a document that a
reviewer writes in the console.

## Proposed outcome

A document may wait for its embedding. A status says whether the vector
exists, and one constraint holds the two together. Retrieval reads embedded
documents only, in both channels.

Every consumer embeds waiting documents on each scan, after the queue. No
partition owns a document, so any consumer may claim one, for three minutes.
The consumer calls the model with no transaction open. It writes the vector
only while its claim holds and the text matches the text of the call. It
records the model pin, as the retrieval step does, so the two compare.

The queue waits for the scan. So each embedding call has a deadline of 15
seconds, and a scan makes four calls at most. A write never waits for a row
lock.

A failed attempt keeps its reason, and a later scan tries again after a delay.
Only a refusal of the input uses one of the document's three attempts. The
provider also answers 400 for a model pin that names no model. So after a
refusal the consumer embeds a short fixed text. The refusal counts only when
the model takes it.

The delay is one minute after the first refusal and five after the second. After
three refusals the document's status is `failed`, and it stays out of
retrieval.

Any other fault is not the document's fault. Such faults are an outage, a rate
limit, a key, a timeout or a model pin. A fault of this kind uses no attempt,
and the document waits five minutes. So an outage fails no document, and the
log carries the reason. The document then goes to the model alone, because one
input can cause such a fault too.

The model refuses a whole call for one input it cannot take, such as a body
longer than its limit. So after its first refusal or deferral, a document goes
to the model alone. The new documents go in a second call. A good
document then loses one attempt at most to a bad one. A new document never
waits behind the retried ones.

Of the documents that go alone, the one whose delay ends
first goes first. So one bad document never blocks the others.

Each row records its source, the loader or the console. The loader never
rewrites a console document, and it reports the collision by file.

## Affected users and systems

This touches the ledger, the retriever, the loader, the seeder and the
consumer. An operator sees the new status in the runbook. No reviewer sees a
change yet: nothing in the console writes a document in this change.

## Constraints

A reviewer may write a document, and retrieval ignores it until a consumer
embeds it (DEC-50). Retrieval fuses a lexical and a dense channel by rank
(DEC-21). Each model call carries its prompt and model pins (DEC-26).

## Decisions affected

Affects: DEC-19, DEC-21, DEC-25, DEC-26, DEC-30, DEC-50

This change serves DEC-50. A document can wait for its vector, the console
calls no model, and both channels ignore a waiting document.

This change keeps DEC-19. A failed embedding call stores the provider's own
message, which may quote the document. The runbook names that place and the
five log events that carry it.

This change keeps DEC-21. Both channels read the same documents, so the fusion
still compares ranks over one set.

This change keeps DEC-25. No run carries the embedding call, so the consumer
logs what each scan's calls cost.

This change keeps DEC-26. The consumer's embedding call carries its own prompt
pin and the model the consumer retrieves with.

This change keeps DEC-30. The provider's HTTP error now carries its status,
and the queue still retries it as before. Only the embedding step reads the
status.

## Open questions

The console does not write a document yet. The change that adds the composer
decides the document id, the author and the owner.
