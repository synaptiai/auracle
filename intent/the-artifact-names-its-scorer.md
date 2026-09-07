# Intent: the artifact names its scorer

## Problem

`gold-report/v2.json` recorded `"method": "human-review"` for numbers that an
offline stub produced. No person graded that run.

Section 4.10 names method 2 "Human review". So the field names a slot in the
register and cannot say who scored. The truth sat in `model_ver`, and the
warning sat in a code comment and in `README.md`.

A consumer that parses the artifact and never reads the README sees a claim of
human review. That is the gap the audit recorded as D10.

## Proposed outcome

The artifact carries `scored_by`, with the value `stub` or `model`. The
validator refuses an artifact that omits it or names another value.

`method` keeps naming section 4.10's slot, so the register stays the authority
and no decision changes.

`README.md` points at the field.

## Affected users and systems

Anyone who reads a published number, by hand or by machine. The artifact now
states who produced it without a second document.

The numbers do not move. Version 3 carries the same rates, intervals, ticket
count and strata as version 2. Only the metadata differs.

## Constraints

The scorer comes from the model pin (DEC-26). The stub answers under its own
version, and any other version means a real provider ran. No other source is
honest, because the job cannot observe who read the output.

Version 2 cannot satisfy the new validator, so it leaves the tree. Version 3
replaces it, and `.gitignore` tracks the new file.

## Decisions affected

None. Section 4.10 keeps its method names, and DEC-31 keeps its split
discipline. The change adds a field beside `method` and edits no decision.

## Open questions

A human-graded artifact has no value in this field, because no code path
produces one. Add the value with the workflow that writes it.
