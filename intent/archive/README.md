# Archived intent files

This repository once asked for an intent file with every change. Most of the
files it produced record that no decision was affected. That is this
repository's own definition of an implementation detail.

The 35 files here are those. They are frozen, and no new file joins them.

Two checks still read them. `scripts/ste-check.py` holds them to the style
rules, as it did before they moved. `scripts/check-docs.py` proves that none
of them declares an `Affects:` line. A file that does is a live design record,
filed in the wrong place.

They are kept rather than deleted for one reason. Each states the problem its
change solved, in the words of the person who made it. That is worth reading
when the change itself is hard to follow.

The records that do affect a decision are in `docs/decisions/`, beside the
register they cite. `CONTRIBUTING.md` section 4 holds the rule that replaced
the old one.
