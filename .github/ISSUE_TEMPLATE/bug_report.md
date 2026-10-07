---
name: Bug report
about: Something behaves differently from what the documents say
labels: bug
---

<!--
This form asks for no DEC. Tracing a change to a decision is a contributor's
job at commit time, and not yours. Report what you saw.
-->

## What you ran

<!--
The exact command, with the environment variables you set.

Redact every secret first. Never paste `OPENROUTER_API_KEY`, `WEBHOOK_SECRET`
or a real database password. Write `***` in their place. This issue is public.

A vulnerability does not belong here. Report it privately, as SECURITY.md
describes.
-->

```sh

```

## What you expected

<!-- Quote the document that led you to expect it, if one did. -->

## What happened

<!-- Paste the output. Remove any real customer data and any credential first. -->

```

```

## Your setup

- Node version (`node --version`):
- pnpm version (`pnpm --version`):
- Docker version (`docker --version`):
- Operating system:
- Commit or release:

<!--
Paste the output of `./scripts/bootstrap.sh --check`. It changes nothing, and
it reports the tools, the dependencies, the commit hook and `.env`.
-->

```

```
