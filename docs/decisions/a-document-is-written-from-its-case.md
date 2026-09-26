# A document is written from its case

## Problem

A gap blocks a case when no document can answer it, or the gate refuses the
document a claim cites. The knowledge screen counts those cases, but nobody
can write the missing document from the case. A reviewer answers the one
customer, and the gap stays open for the next.

## Proposed outcome

A reviewer writes the missing document on the case page and publishes it. The
document has a title, its products, the answer, an owner and a review date.
The review date opens blank, and it must fall after today. The case's own
product is always among the products. A case whose channel maps no product
cannot publish, and the page says to map the channel first.

The console refuses a document that names the case in its title, answer or
owner. It looks for the customer address and every ticket id, message id and
draft handle of the conversation. It matches each as a whole token. It reads a
number alone as a ticket id only after a mark.

The console calls no model. It writes the document as pending, and a consumer
embeds it. Retrieval ignores it until then.

Publishing asks for a new attempt of the case. This design calls that request
a re-run. A consumer starts the attempt once the consumer embeds the
document. The re-run ends when a person approves, closes or snoozes the case
first. It also ends when a reply or an action on the turn goes out. So does
another attempt that starts first, or a new message from the customer.

A person who saves or rewrites the reply after the publish ends the re-run as
well. A failed embedding never starts the attempt. A re-run on a run the
system still walks waits for a person.

One rule decides this for the consumer and for the case page. So the page
never says a case waits when the consumer would end its re-run.

## Affected users and systems

Reviewers write documents on the case page. Every consumer settles the waiting
re-runs of its partitions on each scan. The ledger gains an author on the
document and a table of re-runs. The Design notes screen gains a card.

## Constraints

- The console issues no statement of its own. Every write lives in the core.
- The console calls no model.
- A new attempt needs no helpdesk copy a person could send.
- An escalated run keeps its state and its finish time. Latency then counts it
  as the system's work, as before.
- Bands counts a case on the day of its final attempt. So a re-run moves an
  older case to its new day, as a send-back does.
- The start of an attempt and the row the scan reads commit together. So a
  crash cannot strand a turn.

## Decisions affected

Affects: DEC-15, DEC-18, DEC-19, DEC-21, DEC-23, DEC-44, DEC-45, DEC-46, DEC-47, DEC-48, DEC-49, DEC-50

DEC-50 lets a reviewer write a document from a case with a mapped product.
This change is that write. It records an owner, a review date and at least one
product, and it refuses an identifier of the case. Retrieval ignores the
document until a consumer embeds it, because the console writes it as pending.

DEC-49 makes a new attempt its own run on the same turn, with no helpdesk copy
a person could send. A published document asks for such an attempt. A parked
case ends through the send-back's own writes, with no note. An escalated case
keeps its run, and its re-run is the row the scan reads.

DEC-47 retrieves a run's documents by its product. So the document must serve
the case's product, and the new attempt reads the same product.

DEC-23 declares an owner and a review date. The console requires both. The
date must fall after today, so retrieval still reads the document when its
attempt runs.

DEC-21 fuses two channels by rank. A pending document is in neither channel,
so it does not skew fusion while it waits.

DEC-44 decides where the reply lives. Where the ledger holds it, a parked
draft is no copy a person could send, and the attempt may start.

DEC-45 puts every write behind a reviewer on the roster. The author is that
reviewer, and a refused request reaches neither the page nor the write.

DEC-46 refuses an outcome on a case that changed since the page drew it. A
publish on a parked case carries the same guard, and so does its re-run. A
reply that a person saves or rewrites after the publish ends the re-run.

DEC-48 lets a person close or snooze a case. Either one, before the embedding,
ends the re-run, and the case says so.

DEC-15 and DEC-19 keep personal data in the runtime path, with no machine
check. The identifier check finds the case's own identifiers and nothing else.
A document's text is a new place that holds what a reviewer writes. The
runbook's customer table names it.

DEC-18 keeps the repository synthetic. The new suites seed synthetic rows and
reserved test addresses only.

## Open questions

None.
