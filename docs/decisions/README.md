# Design records

Each file here records one change that cited a decision. The decision itself
lives in section 2 of `../v1-architecture.md`. That register stays the only
design authority. A record explains why a change cites what it cites. It never
defines a decision of its own.

A record opens its `## Decisions affected` section with one line:

```
Affects: DEC-07, DEC-12
```

The author declares, and `scripts/check-docs.py` reads that line and nothing
else beside it. A prose verdict cannot be parsed.
"None. DEC-05 governs this" and "DEC-05 governs this, and none changes" say
one thing in two words. This repository has written both.

The checker proves four things. Every record declares at least one DEC.
Section 2 defines each one. No record declares `Affects: none`. Records sit
directly in this directory, because the style checker reads one level.

A change that cites no decision writes no record. It states its rationale in
the pull request instead. `CONTRIBUTING.md` section 4 holds the rule.

`../../intent/archive/` holds the records written before that rule. None of
them declares anything. They are frozen.
