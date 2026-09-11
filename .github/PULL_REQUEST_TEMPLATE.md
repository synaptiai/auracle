<!--
CONTRIBUTING.md section 7 asks for four things. They are the four numbered
headings below. A pull request without them waits for a person to ask.
-->

## What changed, and why

<!-- One paragraph. Say what a reader gains, not which lines moved. -->

## 1. Verify

<!--
Run `pnpm run verify` and paste its output, with the exit code.
It covers the build, the types, the lint, every test project, the console,
the documentation checks, the style check, the guard self-tests and the
fixtures diff. Report the skip count from the test run, not only pass or
fail.
-->

```
$ pnpm run verify
# Test Files  N passed (N)
#      Tests  N passed (N)
# exit 0
```

## 2. The intent file

<!-- Link or paste `intent/<short-title>.md`. Reviewers read it first. -->

## 3. Decisions

<!--
One sentence per behaviour change. Name the DEC it obeys, or state that it is
an implementation detail. A change that contradicts a DEC needs a decision
first, not a pull request.
-->

## 4. Fixtures

<!--
Did you change `scripts/generate-fixtures.mjs`? If so, paste the output of:
  node scripts/generate-fixtures.mjs && git diff --exit-code fixtures/
If not, write "unchanged".
-->

## Checklist

- [ ] `pnpm run verify` ran, and its output is pasted above with the exit code.
- [ ] An intent file is committed with this change.
- [ ] Every behaviour change cites a DEC or declares itself an implementation detail.
- [ ] No real email, phone number, name or account identifier enters the repository (DEC-18).
- [ ] No API key, token or database password appears in the pasted output.
- [ ] The three-pass review in `REVIEW.md` ran: bugs, security, compliance.
