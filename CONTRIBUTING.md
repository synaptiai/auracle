# Contributing to auracle

This guide takes you from a clean checkout to a merged pull request.
Read it once before you write code.
The design authority is `docs/v1-architecture.md`, the register.
That document holds decisions DEC-01 to DEC-51.
A statement that does not trace to a DEC is an implementation detail.

## 1. Set up and verify your checkout

Follow the [Quickstart](README.md#quickstart) in the README first. It is the
only full setup sequence. It takes a fresh clone to passing tests and a
running console.
Its bootstrap step also installs the commit hook of section 6.

One command defines the contract. It must exit 0.

```sh
pnpm run verify
```

It runs the build and the types. It runs the lint and every test project.
It runs the console's build, check and tests. It runs the documentation
checks, the style check and the guard self-tests. It ends with the fixtures
diff.

The Tests workflow covers the same ground in parallel jobs. `fast` needs no
service. `db` runs against Postgres and a mail server. `console` builds the
core first. Each job runs targets from `package.json`, and nothing else. So a
green run here and a green run there mean the same thing.

One gap to know about. `verify` runs the evals' structural layer only.
The behavior layer spends model calls and stays opt-in behind
`EVAL_BEHAVIOUR=1`. A green `verify` is not evidence about it.

| Command | Task |
|---------|------|
| `pnpm run verify` | The contract. Everything below, in one command. |
| `pnpm run verify:fast` | The inner loop, with no Docker. Omits the database and mail projects, and the console's own tests. It still builds the solution, so it type-checks the console. |
| `pnpm run verify:db` | The database and mail suites alone. Needs both services. |
| `pnpm run verify:console` | The console's build, check and tests. |

`pnpm run check` runs the compiler alone and is faster still. Neither it nor
`verify:fast` is the contract. Each target also runs alone while you work:
`pnpm run build`, `pnpm run lint`, `pnpm test`, `pnpm run test:unit`,
`pnpm run test:db`, `pnpm run test:mail` and `pnpm run test:watch`.

`AGENTS.md` holds the rules for what test you write, in "How to test a
change". Its "Running one test" section shows how to run one file or one test.
A `*.test.ts` file needs no database. A `*.db.test.ts` file needs Postgres.

A job that calls a model reads `MODEL_VER`, and the default is
`z-ai/glm-5.3-flash`. That model reasons before it answers, and the provider
bills the reasoning against the answer budget. So a call that expects a short
answer still allows room for the reasoning before it.

Run `pnpm run verify` before you open a pull request.
Paste its output into the pull request description, with the exit code.
Report the skip count from the test run, not only the pass count.
A suite that skips itself proves nothing, and the count is how you see it.
A pull request without this evidence waits for a person to ask for it.
Section 10 gives the one exception.

[The runbook](docs/operations.md) tells you what each process and job does.

## 2. Where the code lives

[The architecture map](docs/architecture-map.md) draws the system.
[The quick map](docs/quick-map.md) gives each directory one row. The row names
the decisions it implements, its proving test and its runbook section.

These processes run without stopping: `webhook`, `imap`, `consumer`, `relay`
and the operator console.
Everything else runs when you ask it to.

## 3. Trace your change to a decision

Every change to behavior cites a DEC from `docs/v1-architecture.md`, or states
that it is an implementation detail.
Implementation details can change freely.
Decisions cannot.
If your change contradicts a DEC, stop and raise the conflict before you write
code.
See `.claude/skills/decision-tracing` for the full rule set.

## 4. Write a design record, if your change affects a decision

Step 3 asks the question that this step acts on.
If your change cites a DEC, it leaves a design record beside the register.
If it affects no decision, it leaves its rationale in the pull request alone.

Copy `intent/TEMPLATE.md` to `docs/decisions/<short-title>.md`.
Fill every section.
Open "Decisions affected" with one line: `Affects: DEC-07, DEC-12`.
Name every DEC your change cites, and section 2 of the register must define
each one.
Commit the record with your change.
Reviewers read it first.

Write no file when the answer is none.
The declaration is a line, not a sentence, because no script can parse a
sentence.
"None. DEC-05 governs this" and "DEC-05 governs this, and none changes" say
one thing and open with opposite words.

`scripts/check-docs.py` refuses each of these:

- a record with no `Decisions affected` section, or with no `Affects:` line
  in it, or with more than one;
- a record that declares `Affects: none`, or an `Affects:` line that names
  no DEC;
- a DEC that section 2 of the register does not define;
- a record in a subdirectory of `docs/decisions/`, because the style checker
  reads one level;
- a `docs/decisions/` directory that holds no record;
- any markdown file directly in `intent/` except the template;
- a record under `intent/archive/` that declares `Affects:`. The archive holds
  frozen records that declare no decision.

## 5. Fixtures stay synthetic

This repository ships synthetic fixtures only (DEC-18).
Invented values are what let this repository stay public to read.
Never commit real emails, phone numbers, names or account identifiers.
Read `fixtures/README.md` before you touch anything under `fixtures/`.

A labeled half drawn from real mailbox history is not a fixture.
It lives under `corpus/`, which git ignores, and it never enters a commit.
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

The split covers claim sentences too, and the two halves must stay equally
hard. [The fixtures guide](fixtures/README.md) states both rules and the check the loader runs.

Both coverage jobs checkpoint each draft as it lands.
A run that dies continues from the file instead of paying for the half again.
The file is keyed on the model, the prompt, the half and the claims themselves.
Change any of those and it retires, because its samples answer another question.
Both jobs report what they spent, and say when that figure is a floor.

A gate number travels as data. It is not a constant in the policy engine.

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

`pnpm run bootstrap` installs the commit hook. In a worktree, `.git` is a file
rather than a directory. Ask git where the hooks live:
`git rev-parse --git-path hooks`. The bootstrap does that itself.

The commit hook blocks a change to `docs/v1-architecture.md` that carries no
DEC citation. CI runs the same check through `.github/workflows/guardrails.yml`.
Both read the whole message, and both accept only a DEC the register defines.

### The `.claude/` directory

The `.claude/` directory holds files for Claude Code, an AI coding tool. Keep
it in your checkout even if you never use that tool.

Git tracks these parts of it. `hooks/` holds the Python guards and their
self-tests. `agents/` and `skills/` hold the instructions that section 3 and
`REVIEW.md` cite. `settings.json` connects the guards to a Claude Code session.

The guards also run outside a session. `pnpm run verify` and
`pnpm run verify:fast` run their self-tests through `pnpm run check:guards`.
The commit hook calls the DEC citation guard on every commit. CI runs the PII
guard and the citation guard on every pull request.

Do not delete, move or rename the directory. Without it, `verify` fails, and
the commit hook refuses every commit.

In a Claude Code session, these hooks run before a tool call:

- The PII guard blocks real customer data in a fixture. It covers any
  `fixtures/` directory, `evals/cases/` and any file named for fixtures
  (DEC-18).
- The citation guard blocks a commit that edits `docs/v1-architecture.md` with
  no DEC.
- The live-database guard blocks a database client or migration that can
  reach a database other than a local one. A person approves it first.

One more hook runs `scripts/bootstrap.sh --check` when a session starts. It
reports and changes nothing. `REVIEW.md` states which of these rules CI also
enforces.

A session also writes local state there, such as `worktrees/` and
`agent-memory/`. Git ignores both, so they never enter a commit.

## 7. Branch, commit and open the pull request

Name your branch for the issue it closes.

```sh
git checkout -b feature/issue-42-short-description origin/main
```

Use `feature/` for new work and `fix/` for a defect.

Write each commit subject as a sentence in the present tense that says what
is now true. End it with the issue number in parentheses, as in
`The queue takes the next free case (#42)`. Keep the subject short, and
explain the reason in the body.

Merge a pull request as one squashed commit. Its title becomes that commit's
subject, so the title follows the same rule.

The pull request template asks for these headings:

- **Problem**, **Outcome** and **Constraints**: what is wrong, what is true
  after the change, and the limits it respects.
- **1. Verify**: the pasted output of `pnpm run verify`, as section 1 says.
- **2. Decisions**: one sentence per behavior change that names the DEC it
  cites, or states that it is an implementation detail. Link your design
  record here when the change cites a DEC.
- **3. Fixtures**: the regenerated fixtures, if you changed
  `scripts/generate-fixtures.mjs`.

## 8. The three-pass review

Every change passes three reviews before merge: bugs, security and
compliance. Run them yourself before a reviewer does. `REVIEW.md` holds the
passes, the severity bar and the checklists.

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

Run the check with no arguments. It then reads the whole shipped set:

```sh
pnpm run check:ste        # or: python3 scripts/ste-check.py
```

Name files only to check a subset while you draft:

```sh
python3 scripts/ste-check.py README.md
```

The script decides rules 1 and 2. Rules 3 to 5 need a reader, so a clean exit
does not prove those three.

`ste-check.py` strips markdown structure first. Headings, list items and table
cells each count as their own unit. A non-zero exit means a sentence or a
paragraph is above its limit. Rewrite the sentence as two sentences. Do not
split it with a semicolon.

The shipped set is `SHIPPED_GLOBS` in `scripts/ste-check.py`, and it is the
only copy. `.github/workflows/guardrails.yml` runs the script with no file
list for that reason. `scripts/test_ste_check.py` holds the checker's own
cases, including one that fails an empty set rather than reporting it clean.

A second checker decides the claims a document makes about the repository:

```sh
python3 scripts/check-docs.py
```

It proves that each diagram declares and explains every box it draws an edge
to. It proves that every relative link names a file that exists. It does not
check a `#` anchor. It proves that the register's
design table accounts for every open item, and names every design document
under `docs/design/`. It refuses a document whose file name says nothing, such
as a UUID. It proves that each design record cites a decision the register
defines, and that each archived record cites none.

CI runs it and its cases on every pull request. It decides structure and
reference. It does not decide whether a document is true.

## 10. A change to markdown alone

A change to markdown alone can run `pnpm run verify:fast` instead of the full
`verify`. It needs no Docker, and it runs the documentation checks and the
unit suites. Several unit suites read shipped markdown, so a reworded sentence
can fail one. Paste its output into the pull request.

The Tests and Guardrails workflows still run every job on such a pull
request. Some database suites read the runbook, and CI runs those for you.

A change to `docs/v1-architecture.md` or to `docs/decisions/` is markdown
too, but it never takes this path alone. The Decisions section of the pull
request still names the DEC it cites. The commit hook asks for that citation
on a change to `docs/v1-architecture.md`. `scripts/check-docs.py` checks a
record under `docs/decisions/`.

## License and conduct

Synapti licenses this repository under the Apache License 2.0. See `LICENSE`.
You license your contribution under the same terms when you contribute it.
Everyone who takes part follows the code of conduct in `CODE_OF_CONDUCT.md`.
That file is the Contributor Covenant text, unchanged, so the style rules in
section 9 do not apply to it.

## Questions

Open an issue if this guide leaves a step unclear.
Say which section failed you.
We fix the guide, not only the answer.

Report a vulnerability privately, as `SECURITY.md` describes. Never report one
in a public issue.
