---
name: ste-documentation
description: Applies Simplified Technical English to any markdown this repository ships. Triggers when the user asks to write documentation, update a README, draft markdown for adopters, or review docs for style.
---

# STE Documentation

This skill is advisory. The deterministic backstop is the compliance pass in
`REVIEW.md`, which runs the same sentence-length check before a review closes.

Documentation that ships to adopters follows ASD-STE100 Simplified Technical
English. Prompts, scripts and configuration do not.

## Rules

1. Maximum 20 words in a sentence.
2. Maximum 6 sentences in a paragraph.
3. Active voice.
4. Present tense.
5. One technical name has one meaning. Reuse the names in the appendix of
   `docs/v1-architecture.md`. Introduce no synonyms for them.

## Check to run

Run this from the repository root against each changed markdown file:

```sh
python3 scripts/ste-check.py FILE [FILE ...]
```

The script is the only copy of this check. `.github/workflows/guardrails.yml`
runs it on the shipped documents, and `scripts/test_ste_check.py` holds its
cases. It decides rules 1 and 2 only.

Rules 3 to 5 need a reader. A clean exit is not coverage of those three.

A non-zero exit means a sentence is above the limit. Rewrite the sentence. Do
not split it with a semicolon. Use two sentences.
