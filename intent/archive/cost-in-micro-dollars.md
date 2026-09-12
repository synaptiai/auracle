# Intent: The ledger records what a call actually cost

## Problem

`usdToCents` computed `Math.round(usd * 100)`. A completion costing 0.000841
USD therefore recorded 0.

Almost every real call costs a fraction of a cent. So the ledger stored zero for the work it did.
The DEC-25 cost limit then compared a sum of zeros against its ceiling. The limit could not fire on spend.

Two tests asserted that behaviour and one was named for it.

`Progress.costMicros` looked like an accumulator. Nothing ever incremented
it. Every cost read went through the meter.

## Proposed outcome

Cost is an integer count of micro-dollars, which are millionths of a US
dollar. A call costing 0.000841 USD records 841.

Integer arithmetic holds end to end. The values are summed and compared with a limit.
JSON also carries no decimal type.
So a scaled integer stays exact where a float would not.

`db/007_cost_micros.sql` renames both columns and multiplies the stored
amounts by ten thousand. The column stays `integer`. Its range reaches
2 147 USD for one run, far above the DEC-25 ceiling. `bigint` would arrive as a string in node-postgres.
The ledger cannot change that parser globally.
The fencing epoch depends on the string form.

The taxonomy artifact carries the unit, so its version becomes 2.

The decoy field is gone.

## Affected users and systems

Every adopter's ledger. The cost limit. The escalations table and the
knowledge-base loader both print the unit.

## Constraints

The default ceiling is unchanged at 100 USD. Every test amount is the same
money as before, written in the new unit.

## Decisions affected

None. DEC-25 sets a limit on cost and names no unit. Section 4.3 named
cents; it now names micro-dollars and says why.

## Open questions

None.
