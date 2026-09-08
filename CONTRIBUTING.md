# Contributing to auracle

This guide takes you from a clean checkout to a merged pull request.
Read it once before you write code.
The design authority is `docs/v1-architecture.md`.
That document holds decisions DEC-01 to DEC-42.
A statement that does not trace to a DEC is an implementation detail.

## 1. Set up and verify your checkout

You need Node 22 or later and Docker.
Follow the "Run it" section of `README.md` for the database setup.

Three commands define the contract. Each must exit 0.

| Command | Task |
|---------|------|
| `pnpm run build` | Compiles TypeScript. No errors may appear. |
| `pnpm test` | Runs every test. All tests must pass. |
| `pnpm run lint` | Runs ESLint. No findings may appear. |

A job that calls a model reads `MODEL_VER`, and the default is
`z-ai/glm-5.3-flash`. That model reasons before it answers, and the provider
bills the reasoning against the answer budget. So a call that expects a short
answer still allows room for the reasoning before it.

Run all three before you open a pull request.
Paste the output of each command into the pull request description.
State the exit code next to each output.
Report the skip count from the test run, not only the pass count.
A suite that skips itself proves nothing, and the count is how you see it.
A pull request without this evidence waits for a person to ask for it.

`pnpm run check` runs the compiler alone and is the fast inner loop.
To run one file or one case, see the "Running one test" section of `AGENTS.md`.
A `*.test.ts` file needs no database. A `*.db.test.ts` file needs Postgres.

[The runbook](docs/operations.md) tells you what each process and job does.

## 2. Where the code lives

[The architecture map](docs/architecture-map.md) draws the system in three
diagrams. This table names the directories a first change is most likely to
touch. It is not the whole tree.

| Directory | What it holds |
|---|---|
| `src/coordinator/` | The run state machine, the queue seam and the partition consumer |
| `src/ledger/` | The Postgres writes, the fencing epoch and the idempotency keys |
| `src/policy/` | The policy engine. A pure function that calls no model |
| `src/classifier/` | Gate one. It samples the label nine times |
| `src/groundedness/` | Gate two, and the jobs that fit and measure its thresholds |
| `src/retriever/` | Word search and meaning search. It fuses ranks only |
| `src/composer/` | Cite-or-abstain drafting |
| `src/relay/` | The outbox relay daemon |
| `src/adapters/` | One component per external system, and the ports they implement |
| `src/approval/` | The approval bridge, the approve command and the edit distance |
| `src/ingress/`, `src/intake/`, `src/imap/` | How a message arrives and becomes a queue row |
| `src/calibration/`, `src/goldreport/`, `src/replay/`, `src/triage/` | Offline jobs that fit or publish a number |
| `src/escalations/`, `src/latency/`, `src/bands/` | Read-only reports. Every statement is a SELECT |
| `src/models/` | The model port and the one provider behind it |
| `src/jobs/` | Taxonomy induction. It proposes the list of intents |
| `src/kb/` | The knowledge-base loader |
| `src/fixtures/` | Loaders and validators for the committed corpus |
| `db/` | The schema files. The migration runner applies them in order |
| `fixtures/` | The committed synthetic corpus |
| `scripts/` | The generator, the style checker and the documentation checker |

Four processes run without stopping: `webhook`, `imap`, `consumer` and `relay`.
Everything else runs when you ask it to.

## 3. Trace your change to a decision

Every change to behaviour cites a DEC from `docs/v1-architecture.md`, or states
that it is an implementation detail.
Implementation details can change freely.
Decisions cannot.
If your change contradicts a DEC, stop and raise the conflict before you write
code.
See `.claude/skills/decision-tracing` for the full rule set.

## 4. Write the intent file

Copy `intent/TEMPLATE.md` to `intent/<short-title>.md` and fill every section.
Record the DEC IDs your change obeys under "Decisions affected".
Write "none" there if your change is an implementation detail.
Commit the intent file with your change.
Reviewers read it first.

## 5. Fixtures stay synthetic

This repository ships synthetic fixtures only (DEC-18).
Invented values are what let this repository stay public to read.
This repository carries no licence file, so no grant to use it exists yet.
Never commit real emails, phone numbers, names or account identifiers.
Read `fixtures/README.md` before you touch anything under `fixtures/`.

A labeled half drawn from real mailbox history is not a fixture.
It lives under `corpus/`, which is gitignored, and it never enters a commit.
The offline jobs read such a half through `GOLD_FIT_PATH` and `GOLD_REPORT_PATH`.
A half declares its provenance as `synthetic` or `real`, and every artifact
records which one it consumed.
Never commit a half, an artifact or a report produced from real history.

Respect the fit/report split discipline (DEC-31).
You fit thresholds on the fit half of the gold set only.
You report published numbers from the report half only.
One case never serves both tasks.
Selecting a threshold on the same cases that you later report on inflates the result.
The split keeps the published numbers honest at the cost of a wider interval.

Each half has a job of its own, and neither does the other's work.
`pnpm run fit-groundedness` chooses the coverage pair and refuses the report half.
`pnpm run report-groundedness` measures that pair and refuses the fit half.
One job that could do both would let a single run choose and publish.

The split covers claim sentences too, not only cases.
Each document carries a fit block and a report block of claims.
The report sentence paraphrases its fit counterpart and never repeats it.
So a judge that mis-reads one wording moves one half, and you can see it.
The loader refuses a corpus where one sentence reaches both halves.

Keep the two halves equally hard.
They must hold the same share of fully grounded drafts.
A half with more grounded drafts is the easier one, and its precision reads high.
The loader runs an equivalence test, and not a significance test.
The halves must show the gap is small, not merely fail to prove it real.
A half too small to show that is refused rather than passed by default.

Both coverage jobs checkpoint each draft as it lands.
A run that dies continues from the file instead of paying for the half again.
The file is keyed on the model, the prompt, the half and the claims themselves.
Change any of those and it retires, because its samples answer another question.
Both jobs report what they spent, and say when that figure is a floor.

A gate number now travels as data, not as a constant in the policy engine.

Never read a threshold inside the engine. It stays a pure synchronous
function. A process resolves its numbers once at startup and passes them down.
A job that publishes a number records where that number came from. A seed and
a fit produce different results, so a reader must be able to tell them apart.

A fitting job refuses more readily than it emits. A threshold fitted on classes
that do not separate is a number any candidate satisfies. Publishing one
replaces an honest caveat with false authority, which is worse than having no
number at all.

`scripts/generate-fixtures.mjs` regenerates the corpus deterministically.
A committed fixture file must match the generator output byte for byte.

## 6. Install the hooks

Install the commit hook:

```sh
cp hooks/commit-msg .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg
```

The commit hook blocks a change to `docs/v1-architecture.md` that carries no DEC
citation.
CI runs the same check through `.github/workflows/guardrails.yml`.
Both modes read the whole message and both accept only a DEC the register defines.

If you use Claude Code, the session hooks in `.claude/settings.json` also block
three things while you work:

- Real customer data in fixtures. The PII guard inspects writes under
  `fixtures/` (DEC-18).
- Test edits during a bug fix. You prove a bug fix with a new test, not by
  weakening an old one.
- Live database commands without approval. Destructive commands against a real
  database need a person first.

The test-edit-lock and live-database rules have no CI surface.
Their context exists only inside a session.
Do not assume CI catches them.

## 7. Branch, commit and open the pull request

Name your branch for the issue it closes.

```sh
git checkout -b feature/issue-42-short-description origin/main
```

Use `feature/` for new work and `fix/` for a defect. Branches named
`creatumo/card-<id>` are historical. Do not add more.

Write each commit subject as `type: subject`, in the present tense.
The types in use are `feat`, `fix`, `docs`, `test` and `chore`.
Keep the subject under 72 characters and explain the reason in the body.

A commit that edits `docs/v1-architecture.md` must cite a DEC in its message.
The commit hook blocks it otherwise, and CI runs the same check.
A pull request merges as one squashed commit, and its subject is a sentence
that names what changed.

Include these items in the description:

1. The pasted output of build, test and lint, each with its exit code.
2. A link to or copy of your intent file.
3. One sentence per behaviour change that names the DEC it obeys, or states
   that it is an implementation detail.
4. Regenerated fixtures if you changed `scripts/generate-fixtures.mjs`.

## 8. The three-pass review

Every change passes three reviews before merge.
Run them yourself before a reviewer does.
The full procedure lives in `REVIEW.md`.

1. **Bugs.** Correctness against the claimed behaviour. Check outbox inserts,
   epochs and idempotency keys against section 3.4. The epoch makes a write from
   a stale owner fail instead of corrupt the state. The idempotency key makes a
   retry of one action land once on the target system. Check liveness and the
   relay order: the relay sends first and sets the status second. If it set the
   status first, a crash before the send would lose an action that looks sent.
2. **Security.** Data exposure and injection surface. No real customer data, no
   secrets, adapter payloads inside the capability manifest (DEC-06). Each
   adapter declares the actions and payload fields that it supports. A payload
   outside the declaration means the adapter acts beyond its promise.
3. **Compliance.** The change against `docs/v1-architecture.md`. Every
   behaviour change cites a DEC or states that it is an implementation detail.

The severity bar has three levels of "important":

- The change breaks behaviour that a test claims to prove.
- The change exposes data or writes real customer data into the repository.
- The change contradicts a DEC without a decision that changes the DEC.

Everything else is a nit.
A review reports at most five nits.

## 9. Documentation follows Simplified Technical English

Markdown that ships to adopters follows ASD-STE100 Simplified Technical
English. Prompts, scripts and configuration do not.

The rules:

1. Maximum 20 words in a sentence.
2. Maximum 6 sentences in a paragraph.
3. Active voice.
4. Present tense.
5. One technical name has one meaning. Reuse the names in the appendix of
   `docs/v1-architecture.md`. Introduce no synonyms for them.

Run the check from the repository root against each changed document:

```sh
python3 scripts/ste-check.py README.md AGENTS.md docs/v1-architecture.md
```

The script decides rules 1 and 2. Rules 3 to 5 need a reader, so a clean exit
is not coverage of those three.

`.github/workflows/guardrails.yml` runs the same script on every pull request.
`scripts/test_ste_check.py` holds the checker's own cases.

A second checker decides the claims a document makes about the repository:

```sh
python3 scripts/check-docs.py
```

It proves that each diagram declares and explains every box it draws an edge
to. It also proves that every relative link resolves. And it proves that the
register's design table accounts for every open item. CI runs it and its
cases on every pull request. It decides structure and reference. It does not
decide whether a document is true.

The script strips markdown structure first.
Headings and list items count as their own units.
A table cell counts as its own unit.

A non-zero exit means a sentence is above the limit.
Rewrite the sentence as two sentences.
Do not split it with a semicolon.

## Questions

Open an issue if this guide leaves a step unclear.
Say which section failed you.
We fix the guide, not only the answer.
