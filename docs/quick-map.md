# Quick map

One screen. Which decisions a directory answers to, and what turns red when
you change it. The last column points at the runbook.

`docs/v1-architecture.md` is the authority and holds every decision, DEC-01 to
DEC-51. This page indexes it and never restates it. A cell names the decisions a
reader most needs. It does not name every decision the directory mentions.

The key test is the file that turns red first. It is not the only test that
covers the directory, and `pnpm run verify` is still the contract.

A runbook cell reading "none" is honest. Some directories have no operational
surface. A pointer to a section that does not cover them is worse than a gap.

| Directory | Decisions | Key test | Runbook |
|---|---|---|---|
| `adapters` | DEC-06, DEC-11, DEC-24, DEC-30 | `src/adapters/freescout.test.ts` | 3. Running the processes |
| `approval` | DEC-11, DEC-12, DEC-40, DEC-42 | `src/approval/approval.db.test.ts` | 4. The approval workflow |
| `artifacts` | none | `src/artifacts/versioned.test.ts` | none |
| `bands` | DEC-18, DEC-30 | `src/bands/bands.test.ts` | 7. Observability |
| `calibration` | DEC-05, DEC-13, DEC-31, DEC-41 | `src/calibration/resolve.test.ts` | 5. Offline jobs |
| `classifier` | DEC-05, DEC-13, DEC-37 | `src/classifier/classifier.test.ts` | 7. Observability |
| `cli` | none | `src/cli/entry.test.ts` | none |
| `composer` | DEC-07, DEC-37, DEC-43 | `src/composer/composer.test.ts` | 7. Observability |
| `config` | DEC-14, DEC-17 | `src/config/env.test.ts` | 1. Local setup |
| `conversation` | DEC-35, DEC-37 | `src/conversation/conversation.db.test.ts` | 8. The operator console |
| `coordinator` | DEC-25, DEC-27, DEC-28, DEC-36 | `src/coordinator/coordinator.db.test.ts` | 3. Running the processes |
| `corpus` | DEC-18, DEC-37 | `src/corpus/corpus.test.ts` | 6. The real-corpus curation loop |
| `db` | none | `src/db/close-ledger.db.test.ts` | 1. Local setup |
| `documents` | DEC-22, DEC-23 | `src/documents/documents.db.test.ts` | 5. Offline jobs |
| `domain` | DEC-06, DEC-31, DEC-37 | `src/domain/conversation-turn.test.ts` | none |
| `e2e` | DEC-12, DEC-24, DEC-28, DEC-30 | `src/e2e/v1-flow.db.test.ts` | none |
| `escalations` | DEC-30, DEC-34, DEC-40 | `src/escalations/escalations.db.test.ts` | 4. The approval workflow |
| `fixtures` | DEC-18, DEC-31 | `src/fixtures/fixtures.test.ts` | 5. Offline jobs |
| `goldreport` | DEC-05, DEC-31, DEC-32, DEC-39 | `src/goldreport/goldreport.test.ts` | 5. Offline jobs |
| `groundedness` | DEC-05, DEC-07, DEC-31 | `src/groundedness/groundedness.test.ts` | 5. Offline jobs |
| `holds` | DEC-46 | `src/holds/holds.db.test.ts` | 8. The operator console |
| `imap` | DEC-24, DEC-27 | `src/imap/fetcher.test.ts` | 3. Running the processes |
| `ingress` | DEC-24 | `src/ingress/webhook-server.test.ts` | 3. Running the processes |
| `intake` | DEC-35, DEC-36, DEC-38 | `src/intake/adapter.test.ts` | 3. Running the processes |
| `jobs` | DEC-02, DEC-10, DEC-26 | `src/jobs/taxonomy-induction.test.ts` | 6. The real-corpus curation loop |
| `journal` | DEC-05, DEC-26, DEC-43 | `src/journal/query.db.test.ts` | 7. Observability |
| `kb` | DEC-22, DEC-23, DEC-25 | `src/kb/loader.test.ts` | 5. Offline jobs |
| `knowledge` | DEC-46, DEC-47, DEC-49, DEC-50 | `src/knowledge/publish.db.test.ts` | 8. The operator console |
| `labeller` | DEC-41 | `src/labeller/labeller.test.ts` | 6. The real-corpus curation loop |
| `latency` | DEC-17, DEC-19 | `src/latency/latency.test.ts` | 7. Observability |
| `ledger` | DEC-04, DEC-24, DEC-28, DEC-38 | `src/ledger/clock.db.test.ts` | 2. Schema migrations |
| `log` | none | `src/log/line.test.ts` | 7. Observability |
| `models` | DEC-16, DEC-17, DEC-25, DEC-26 | `src/models/models.test.ts` | 1. Local setup |
| `outcomes` | DEC-48, DEC-49 | `src/outcomes/send-back.db.test.ts` | 4. The approval workflow |
| `policy` | DEC-03, DEC-05, DEC-06, DEC-13 | `src/policy/policy.test.ts` | 7. Observability |
| `public` | DEC-05, DEC-06, DEC-12 | `src/public/surface.test.ts` | 8. The operator console |
| `relay` | DEC-04, DEC-28, DEC-29, DEC-30 | `src/relay/relay.db.test.ts` | 3. Running the processes |
| `replay` | DEC-09, DEC-20, DEC-32, DEC-39 | `src/replay/replay.test.ts` | 5. Offline jobs |
| `retriever` | DEC-21, DEC-22, DEC-23 | `src/retriever/retriever.db.test.ts` | none |
| `reviewers` | DEC-42, DEC-45 | `src/reviewers/reviewers.db.test.ts` | 8. The operator console |
| `routing` | DEC-05, DEC-13, DEC-34, DEC-41 | `src/routing/latest.db.test.ts` | 8. The operator console |
| `seed` | DEC-12, DEC-18, DEC-43 | `src/seed/plan.test.ts` | 10. Every command this repository defines |
| `team` | DEC-46, DEC-49, DEC-51 | `src/team/query.db.test.ts` | 8. The operator console |
| `test-support` | DEC-18 | `src/test-support/per-file-database.db.test.ts` | none |
| `time` | none | `src/time/day.test.ts` | none |
| `triage` | DEC-09, DEC-18 | `src/triage/triage.test.ts` | 5. Offline jobs |
| `console` | DEC-44, DEC-47, DEC-50, DEC-51 | `console/src/server.test.ts` | 8. The operator console |

## Decisions no row names

DEC-01, DEC-08, DEC-15, DEC-33.

DEC-08 and DEC-15 hold across the repository. No one directory owns them.
DEC-08 fixes the language of this system. DEC-15 states that no runtime path
removes personal data.

DEC-01 and DEC-33 do belong to directories. `adapters` cites DEC-01 in its
module headers. Several directories carry DEC-33, `adapters` and `approval`
among them. A cell here holds four decisions at most, so no row names either one.
Read the module headers for those.

`scripts/check-docs.py` proves this list is exactly the set no row names. A
decision that leaves the table, or joins it, fails `pnpm run check:docs`. The
same script proves the table has a row for every directory under `src/` and
for the console.
