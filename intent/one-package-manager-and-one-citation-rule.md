# Intent: One package manager, and one citation rule

## Problem

The repository carried two lockfiles. `node_modules` held a `.pnpm` store, so
the local tree came from pnpm. The workflow ran `npm ci`, which reads
`package-lock.json`. The two trees were never compared.

`pnpm-workspace.yaml` also existed, which pnpm reads at the root. A note in
this work called that file a leftover. The note was wrong, and `8acf000`
corrects it: each package the file names needs a lifecycle script that pnpm
blocks by default. The file stays.

The DEC-citation guard checked two different things. The commit hook read the
whole message. The pull-request mode read the subject alone, so a citation in
the body passed locally and failed in CI. A merge commit lists no files under
`git show`, so a merge that changed the register was never checked. The
pattern also accepted any two-digit number, so `DEC-99` satisfied every mode.

Two documents claimed CI ran the same check.

## Proposed outcome

pnpm is the one manager. `package.json` pins it through `packageManager`.
The workflow installs with a frozen lockfile. `package-lock.json` is gone.

Both citation modes read the whole message. Both accept only a DEC the
register defines. A merge is compared against its first parent, so its files
are listed.

`.claude/hooks/test_commit_dec_citation.py` holds the cases, and the
guardrails workflow runs them.

## Affected users and systems

Anyone who installs dependencies. Anyone who changes the register.

## Constraints

The lockfile is unchanged, so the dependency tree is unchanged.
`pnpm install --frozen-lockfile` succeeds against it.

## Decisions affected

None. Section 2 keeps the citation rule; the guard now applies it the same
way in both places.

## Open questions

None.
