# Contributing to auracle

This guide takes you from a clean checkout to a merged pull request.
Read it once before you write code.
The design authority is `docs/v1-architecture.md`.
That document holds decisions DEC-01 to DEC-33.
A statement that does not trace to a DEC is an implementation detail.

## 1. Set up and verify your checkout

You need Node 22 or later and Docker.
Follow the "Run it" section of `README.md` for the database setup.

Three commands define the contract. Each must exit 0.

| Command | Task |
|---------|------|
| `npm run build` | Compiles TypeScript. No errors may appear. |
| `npm test` | Runs every test. All tests must pass. |
| `npm run lint` | Runs ESLint. No findings may appear. |

Run all three before you open a pull request.
Paste the output of each command into the pull request description.
State the exit code next to each output.
A pull request without this evidence waits for a person to ask for it.

## 2. Trace your change to a decision

Every change to behaviour cites a DEC from `docs/v1-architecture.md`, or states
that it is an implementation detail.
Implementation details can change freely.
Decisions cannot.
If your change contradicts a DEC, stop and raise the conflict before you write
code.
See `.claude/skills/decision-tracing` for the full rule set.

## 3. Write the intent file

Copy `intent/TEMPLATE.md` to `intent/<short-title>.md` and fill every section.
Record the DEC IDs your change obeys under "Decisions affected".
Write "none" there if your change is an implementation detail.
Commit the intent file with your change.
Reviewers read it first.

## 4. Fixtures stay synthetic

This repository ships synthetic fixtures only (DEC-18).
Never commit real emails, phone numbers, names or account identifiers.
Read `fixtures/README.md` before you touch anything under `fixtures/`.

Respect the fit/report split discipline (DEC-31).
You fit thresholds on the fit half of the gold set only.
You report published numbers from the report half only.
One case never serves both tasks.
`scripts/generate-fixtures.mjs` regenerates the corpus deterministically.
A committed fixture file must match the generator output byte for byte.

## 5. Install the hooks

Install the commit hook:

```sh
cp hooks/commit-msg .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg
```

The commit hook blocks a change to `docs/v1-architecture.md` that carries no DEC
citation.
CI runs the same check through `.github/workflows/guardrails.yml`.

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

## 6. Open the pull request

Include these items in the description:

1. The pasted output of build, test and lint, each with its exit code.
2. A link to or copy of your intent file.
3. One sentence per behaviour change that names the DEC it obeys, or states
   that it is an implementation detail.
4. Regenerated fixtures if you changed `scripts/generate-fixtures.mjs`.

## 7. The three-pass review

Every change passes three reviews before merge.
Run them yourself before a reviewer does.
The full procedure lives in `REVIEW.md`.

1. **Bugs.** Correctness against the claimed behaviour. Check outbox inserts,
   epochs and idempotency keys against section 3.4. Check liveness and the
   relay order: the relay sends first and sets the status second.
2. **Security.** Data exposure and injection surface. No real customer data, no
   secrets, adapter payloads inside the capability manifest (DEC-06).
3. **Compliance.** The change against `docs/v1-architecture.md`. Every
   behaviour change cites a DEC or states that it is an implementation detail.

The severity bar has three levels of "important":

- The change breaks behaviour that a test claims to prove.
- The change exposes data or writes real customer data into the repository.
- The change contradicts a DEC without a decision that changes the DEC.

Everything else is a nit.
A review reports at most five nits.

## 8. Documentation follows Simplified Technical English

Markdown that ships to adopters follows ASD-STE100 Simplified Technical
English. Prompts, scripts and configuration do not.

The rules:

1. Maximum 20 words in a sentence.
2. Maximum 6 sentences in a paragraph.
3. Active voice.
4. Present tense.
5. One technical name has one meaning. Reuse the names in the appendix of
   `docs/v1-architecture.md`. Introduce no synonyms for them.

Run the check from the repository root.
Paste the whole block into your shell.
It reads the files you pass as arguments:

```sh
python3 - "$@" <<'EOF'
import re, sys

if len(sys.argv) < 2:
    sys.exit("usage: python3 - FILE [FILE ...] <<'EOF'")
fail = False

def check(paragraph, path):
    global fail
    for s in re.split(r'(?<=[.!?])\s+', paragraph):
        n = len(re.findall(r"[A-Za-z0-9_-]+", s))
        if n > 20:
            fail = True
            print(f"{path}: {n} words: {s[:90]}")

def clean(line):
    s = line.strip()
    s = re.sub(r'^#{1,6}\s+', '', s)
    s = re.sub(r'^>\s?', '', s)
    return s

for path in sys.argv[1:]:
    text = open(path).read()
    text = re.sub(r'```.*?```', '', text, flags=re.S)
    text = re.sub(r'`[^`]*`', 'x', text)
    # A heading is its own unit, even with no blank line around it.
    text = re.sub(r'(?m)^(#{1,6}\s+.*)$', '\n\\1\n', text)
    for block in re.split(r'\n\s*\n', text):
        lines = [clean(l) for l in block.splitlines() if clean(l)]
        if not lines:
            continue
        if all(l.startswith('|') for l in lines):
            for l in lines:
                cells = [c.strip() for c in l.strip('|').split('|')]
                cells = [c for c in cells
                         if c and not set(c) <= set('-: ')]
                para = ' '.join(cells)
                if para:
                    check(para, path)
            continue
        groups, cur = [], None
        for l in lines:
            item = re.match(r'^([-*+]|\d+[.)])\s+(.*)$', l)
            if item:
                cur = [item.group(2)]
                groups.append(cur)
            else:
                if cur is None:
                    cur = []
                    groups.append(cur)
                cur.append(l)
        for g in groups:
            check(' '.join(g), path)

sys.exit(1 if fail else 0)
EOF
```

The script strips markdown structure first.
Headings and list items count as their own units.
A table row counts as one unit per row.

A non-zero exit means a sentence is above the limit.
Rewrite the sentence as two sentences.
Do not split it with a semicolon.

## Questions

Open an issue if this guide leaves a step unclear.
Say which section failed you.
We fix the guide, not only the answer.
