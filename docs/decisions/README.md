# Design records

Each file here records one change that cites a decision. The decision itself
lives in section 2 of `../v1-architecture.md`. That register stays the only
design authority. A record explains why a change cites what it cites. It never
defines a decision of its own.

A record opens its `## Decisions affected` section with one line:

```
Affects: DEC-07, DEC-12
```

`scripts/check-docs.py` reads that line and nothing else beside it, because
no script can parse a prose verdict. "None. DEC-05 governs this" and "DEC-05
governs this, and none changes" say one thing two ways.

A change that affects no decision writes no record. It states its rationale
in the pull request instead. `CONTRIBUTING.md` section 4 holds the rule and
every refusal the checker makes.

`../../intent/archive/` holds frozen records with no `Affects:` line. The
checker refuses an archive record that has one.
