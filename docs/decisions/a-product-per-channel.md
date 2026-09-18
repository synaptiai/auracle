# A product per channel

## Problem

Every run reads the same corpus today. One product's refund policy answers
another product's customers. Nothing keeps one product's documents away from
another's cases. The intake adapter parsed the channel the source reported.
The intake seam then dropped it, so the ledger recorded no product anywhere.

## Proposed outcome

Each run records the product of the channel its message arrived on. A run
retrieves the documents of its product and the documents that declare no
product. The console names the product, narrows the queue by it, and reads
the reviewer's own products first. DEC-47 is the row this change ships.

- `products.json` at the repository root holds the products and the channels
  that serve them. Each ingress process reads it once at startup.
- The queue row records the product at arrival, and the run copies it. A
  message on a channel the map does not name records no product.
- A document declares the products it serves. An empty list means every
  product, and that is what a document nobody scoped serves.
- The queue draws a chip per product, with the count read from every waiting
  run. A reviewer's own products read first inside each group.
- `pnpm run reviewers -- --add <identity> --products a,b` sets what a
  reviewer covers, and `--list` prints it.

## Affected users and systems

The reviewers who work the queue. Every case that arrives on a mapped
channel. The change touches the two ingress daemons, the retrieve step and
the ledger schema. It also touches the knowledge-base loader, the fixture
corpus, the console and the reviewer roster. The runtime image gains one
file.

## Constraints

- DEC-47 rejects four alternatives. They are no product, an inferred
  product, a label that retrieval ignores, and one product per conversation.
  This change infers nothing. It reads no message to choose a product.
- DEC-23 governs the approved path. The scope applies there as well, because
  an approved answer still reads one corpus.
- The console's writes stay named. `src/select-only.test.ts` holds the list,
  and the reviewer's products are a read.

## Decisions affected

Affects: DEC-12, DEC-18, DEC-23, DEC-28, DEC-45, DEC-46, DEC-47

DEC-47 is the decision this change ships. It asks for a product on each run.
It asks for a retrieval scope that keeps that product's documents and the
unscoped ones. It asks for a vocabulary for both. The catalogue, the two
columns, the document scope and the filter are that row.

DEC-23 governs which documents a run may read. A document past its review
date leaves the automatic path and stays available to an approved answer.
This change adds a second condition beside that one, and it applies to both.

DEC-46 reserves a case for one reviewer. It is unchanged. A hold still
reserves a case, and the product list only decides what reads first for the
reviewer asking. The two are separate: one is a reservation, and the other
is an order.

DEC-45 says the console serves nothing to a request with no roster reviewer.
It is unchanged. The console reads the products a reviewer covers from that
roster. The console writes none of them: the roster command does.

DEC-12 says a customer reply always waits for a person. It is unchanged. A
product decides no gate. A case waits for a person whatever product it is
for. The filter chooses only what a reviewer reads first.

DEC-18 says the repository ships synthetic fixtures only. This change adds
two invented products and a corpus scope to the fixtures. No name, address
or identifier in them is real.

DEC-28 says every write carries a fencing epoch. The run insert records the
product, and the fence is unchanged. The product is one more column on a
write the epoch already governs.

## Open questions

The corpus is scoped by product, and the gold set's ticket labels are not.
Whether a product should join the replay and calibration strata is open.

A mail message arrives on no channel. The IMAP adapter records no queue
field. Such a message records no product, and its run reads the unscoped
documents alone. A deployment that serves one product over mail has no way to
scope those runs yet. Whether the mail configuration should name a channel is
open.
