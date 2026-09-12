# Intent: the style rule gets a checker that runs

## Problem

The style convention lived in three places and ran nowhere. `CONTRIBUTING.md`
and the `ste-documentation` skill each carried an inline copy, and the two
copies had drifted apart. Neither one ran on a pull request.

So the rule went unobserved. The hardening branch introduced six violations of
it, and two more survived from before the branch. Nobody saw any of the eight.

A second class of drift appeared in the same sweep. Four document references
named artifact paths that the jobs stopped writing. `README.md` still promised
`gold-report/v1.json` and `triage/v1.json`, and both jobs mint the next version
instead. `AGENTS.md` still promised that two mail suites skip without GreenMail,
which the shared-container change had removed.

Section 7 of the register lost two list entries while its own prose kept citing
them by number. The prose states that the numbers stay.

## Proposed outcome

One checker exists, in `scripts/ste-check.py`. It decides rules 1 and 2, and it
says plainly that rules 3 to 5 need a reader. `.github/workflows/guardrails.yml`
runs it on the shipped documents, and `scripts/test_ste_check.py` holds its
cases.

`CONTRIBUTING.md` and the skill call that script. Neither one carries a copy.

Every shipped document passes rules 1 and 2. Every artifact reference names what
the job writes. Section 7 lists items 6 and 7 again, marked closed, so its prose
and its list agree.

## Affected users and systems

A contributor who edits a shipped document. The pull request now fails when a
sentence runs past 20 words or a prose paragraph past 6 sentences.

No runtime component changes. No ledger, coordinator, relay or policy code is
touched.

## Constraints

Rule 2 counts prose only. A numbered procedure and a table are not paragraphs,
and counting their entries would forbid a list of seven steps. The script states
this exclusion, because it is a decision and not an oversight.

The checked file list is pinned. A document under `docs/internal/` never gates a
pull request.

The register keeps every open-item number, because other documents cite them
(section 7).

## Decisions affected

None. The style convention is an implementation detail of the documents. The
`AGENTS.md` conventions state it, and no DEC governs it.

The reflowed paragraphs sit under DEC-25 (section 4.3 limits) and DEC-34 with
DEC-35 to DEC-39 (section 7). The edits change layout and restore two list
entries. No decision text changes.

## Open questions

Rules 3 to 5 have no checker. Active voice and present tense need a reader, and
so does one name for one meaning. The `REVIEW.md` table records this gap rather
than hiding it.
