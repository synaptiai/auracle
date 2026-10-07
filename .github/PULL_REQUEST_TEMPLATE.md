<!--
CONTRIBUTING.md section 7 asks for these headings. A pull request without them
waits for a person to ask.

The first three carry what an intent file used to carry. A change that affects
no decision writes no file, so this is where its rationale lives.
-->

## Problem

<!-- What is wrong or missing. State the observable symptom. -->

## Outcome

<!-- What is true now that this is done. Say what a reader gains. -->

## Constraints

<!-- The limits this change respects. Say which ones bound the approach. -->

## 1. Verify

<!--
A change to markdown alone may paste `pnpm run verify:fast` instead. It
needs no Docker. Write "prose only" in sections 2 and 3, and CI runs the
database suites. A change to the register or to `docs/decisions/` still names
its DEC in section 2.

Every other change runs `pnpm run verify`. Paste its output with the exit
code.
It covers the build, the types, the lint, every test project and the console.
It also runs the documentation checks, the style check, the guard self-tests
and the fixtures diff. Report the skip count from the test run, not only pass or
fail.
-->

```
$ pnpm run verify
# Test Files  N passed (N)
#      Tests  N passed (N)
# exit 0
```

## 2. Decisions

<!--
Asked once, here. One sentence per behaviour change: name the DEC it cites, or
state that it is an implementation detail. A change that contradicts a DEC
needs a decision first, not a pull request.

If it cites a DEC, link the design record you committed under
`docs/decisions/`. If it cites none, this section is the whole record and no
file is needed.
-->

## 3. Fixtures

<!--
Did you change `scripts/generate-fixtures.mjs`? If so, paste the output of:
  node scripts/generate-fixtures.mjs && git diff --exit-code fixtures/
If not, write "unchanged".
-->

## Checklist

- [ ] `pnpm run verify` ran, and its output is pasted above with the exit code. For prose only, `verify:fast` ran instead.
- [ ] Every behaviour change cites a DEC or declares itself an implementation detail.
- [ ] A design record under `docs/decisions/` accompanies this change, or it cites no DEC.
- [ ] No real email, phone number, name or account identifier enters the repository (DEC-18).
- [ ] No API key, token or database password appears in the pasted output.
- [ ] The three-pass review in `REVIEW.md` ran: bugs, security, compliance.
