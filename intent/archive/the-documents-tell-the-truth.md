# Intent: the documents tell the truth, and V2 gets a roadmap

## Problem

Eight statements in the shipped documents were false against the repository.
The register marked V2 open item 7 closed while the runbook said it stays
open. The register contradicted itself twenty-one lines later.

Section 7.1 claimed every open item had a design document, and two had
none. Two design documents rested on figures that had since moved. The
review guide retired two subagents that still exist. The README sent a
reader to an artifact version the repository does not keep.

The remaining V2 open items had no single readable answer. A reader had to
assemble one from two register sections, seven design documents named by
identifier, and the runbook.

No diagram existed anywhere. The README's numbered walk was the only picture of
the runtime path. It glosses the step most often drawn wrong.

No document stated a branch name, a commit shape, or where the code lives.

## Proposed outcome

Every claim a document makes traces to something that exists. Each of the four
open items has a named blocker with an owner and a next step. Each item
that needs a design document has one. Three diagrams show the system, and a
checker proves they stay true. A contributor finds the branch name, the
commit shape and the code map without reading the commit history.

## Affected users and systems

Adopters reading the register, the runbook or the README. Contributors opening
a first change. No runtime component changes, and no process behaves
differently.

## Constraints

No file under `src/`, `db/`, `fixtures/` or `gold-report/` changes. No
published number moves and the committed fixtures stay byte-identical. No
licence file lands, so the public-repository claim softens instead. The gold
report keeps its version, because a new one re-opens every published figure and
moves no number.

Design documents keep their original text. A dated superseded-facts note
records what changed, so the record stays as it was written.

This change invents no Phase 2 exit criteria. The roadmap reports the proposal
that already exists and names it as awaiting a person's ratification.

## Decisions affected

None. Every edit corrects a false statement or adds explanation. The register
edit traces to DEC-20, which fixes the two phases section 5 describes. It
also traces to DEC-27 and DEC-36, which fix the partition open item 7
measures. Neither changes. `scripts/check-docs.py` is an implementation
detail; it reads only and adds no behaviour.

## Open questions

Item 1's C7 adapter floor has no channel that meets it. The mail adapter's
read-back throws and the helpdesk adapter reaches no network. So an automatic
customer reply has nowhere to leave through. The roadmap names that as the
candidate next change. This change does not make it.

The repository carries no licence. Until it does, a reader has no grant to use
what they read.
