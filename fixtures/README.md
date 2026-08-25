# Fixtures

This directory holds the synthetic fixture corpus. Every value here is invented. No real customer data enters this repository. See DEC-18.

## Contents

- `taxonomy.json`. The curated taxonomy of 25 intents. Each intent carries a risk tier per DEC-13. The `other` group stays in the list per section 4.11.
- `gold/fit.json`. The fit half of the gold set. It holds 385 synthetic tickets.
- `gold/report.json`. The report half of the gold set. It also holds 385 synthetic tickets.
- `documents.json`. Help-center documents and canonical resolutions for the retrieval index per DEC-22. Each entry declares an owner and a review date per DEC-23.

## Split discipline

The gold set holds 770 cases. You fit on the fit half only. You report each published number from the report half only. One case never serves both tasks. See DEC-31.

The strata are the intents. Each intent holds 30 or 31 cases. The split divides each stratum as evenly as possible between the halves. Each half contains every intent, so every risk tier appears in both halves. This keeps the strata usable at the half size that section 4.10 describes.

## Ticket schema

Each ticket object carries these fields.

- `ticket_id`. Synthetic id with a `SYN-` prefix.
- `source`. Always `synthetic`.
- `intent`. Label from the curated taxonomy.
- `queue`. The queue that received the ticket.
- `disposition`. Observable outcome, see below.
- `subject`, `body`. Invented ticket text.

A disposition records an observable result of the work. The fields are `escalated`, `macro_applied`, `refund_issued` and `first_reply_minutes`. Action match scores these dispositions. It does not score the intent label. See DEC-32.

## Regeneration

The script `scripts/generate-fixtures.mjs` builds this corpus from one fixed seed:

```sh
node scripts/generate-fixtures.mjs
```

The output is deterministic. A committed file must match the generator output byte for byte. If you change the generator, regenerate the whole corpus and commit both together.
