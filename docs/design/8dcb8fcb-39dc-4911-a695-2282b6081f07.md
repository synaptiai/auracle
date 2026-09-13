---
title: "Amendment proposal: an operator console beside the helpdesk draft"
author: code
tags: [v2, design, amendment, dec-11, console]
created_at: 2026-09-04T00:00:00Z
updated_at: 2026-09-04T00:00:00Z
---

# Amendment proposal: an operator console beside the helpdesk draft

Status: **ratified as DEC-40 on 2026-09-04.** The row is in section 2 of
`../../docs/v1-architecture.md`, and the register carries the wording that
governs. This document records the reasoning that produced it.

The row as ratified reads: gated actions park in the helpdesk draft state, and
a read-only operator console may also approve one. Its rejected alternatives
are a console that parks its own drafts, and a console that is the only
approval path.

## Verdict

The register must gain one row before an operator console ships. The console
reads the ledger and it approves a parked draft. DEC-11 rejects a new web
queue by name, so the console contradicts the register as it stands today.

The proposal adds DEC-40. It does not rewrite DEC-11.

## Why a new row, and not an edit

The register has never rewritten a decision. Every row in section 2 entered
once and stayed. DEC-27's row names the ticket id, and DEC-36 later replaced
the key with the conversation id. DEC-27 still reads as it was written, and
DEC-36 carries the change.

So this proposal follows that precedent. A later decision supersedes an
earlier one, and a reader can still see what the project first chose.

## What DEC-11 says now

The row reads: the helpdesk shows gated actions in its own draft state. Its
rejected alternatives are a Slack queue and a new web queue.

Two other statements carry the same claim. Section 4.2 of the register says
adopters do not install a new interface, and it names DEC-11 as the purpose.
`src/approval/bridge.ts` and `src/approval/approve.ts` each repeat it in a
header comment.

An operator console is a new web queue on the plainest reading. The proposal
therefore states the conflict rather than arguing around it.

## What the console actually changes

The console changes where a person clicks. It does not change where a draft
lives.

`parkGatedReply` still calls `adapter.createDraft`, so the draft still lands
in the helpdesk. The console reads that draft back through the adapter, and
it measures the approval-edit distance from the body the person sends. A
missing draft still refuses the approval.

One thing is genuinely new. `pnpm run approve` is already an interface
outside the helpdesk, and DEC-11 never covered it. The console gives that
command a screen. It also gives an operator the run, the two gates and the
evidence beside the draft, which no helpdesk can show.

## The proposed row

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-40 | Gated actions park in the helpdesk draft state. A read-only operator console may also approve one | A console that parks its own drafts; a console that is the only approval path |

The row keeps the parking rule and narrows nothing else. It permits a second
approval path and it forbids a second parking path. So the helpdesk stays the
place a draft lives, and DEC-11's purpose survives the amendment.

## What the amendment must also correct

Three statements go stale on the day the console ships. The amendment fixes
all three in the same change, or the register disagrees with itself again.

| File | Line | Statement |
|---|---|---|
| `../../docs/v1-architecture.md` | 471 | "Adopters do not install a new interface. This is the purpose of DEC-11." |
| `../../src/approval/bridge.ts` | 6 | "own helpdesk UI; this project adds no queue interface." |
| `../../src/approval/approve.ts` | 7 | "queue interface of its own" |

`README.md` and `../operations.md` carry no such claim. The surface is those
three lines and nothing else.

## Traceability

| Concern | Decisions |
|---|---|
| A gated action parks in the adapter | DEC-11, section 4.9 |
| A customer reply always needs approval | DEC-12 |
| The disclosure is mandatory and non-empty | DEC-14 |
| The console never invents an approval | DEC-24, DEC-28 |
| The console reads and does not guess | section 4.10 |
| Synthetic data only in this repository | DEC-18 |

## Rejected alternatives

- **Rewrite DEC-11 in place.** No row has ever changed. A reader could no
  longer see what the project first chose, and every citation of DEC-11
  would silently mean something else.
- **Ship the console and record the tension.** The repository would carry a
  documented contradiction. The last change set spent twenty-seven findings
  removing that class of defect.
- **Approve only in the helpdesk.** This keeps DEC-11 untouched. It also
  means an operator cannot see the two gates and the evidence beside the
  draft, which is the reason the console exists.

## Open items

The maintainer decides the wording of DEC-40 and the three corrections. No
code lands before that row exists.
