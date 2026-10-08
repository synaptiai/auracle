# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability.
Report it privately through GitHub instead:
[open a security advisory](https://github.com/synaptiai/auracle/security/advisories/new).
Only you, the maintainers and anyone they add to the advisory can read it.
If that form is unavailable, email [support@synapti.ai](mailto:support@synapti.ai)
instead.

Include the commit you tested, the steps that reproduce the fault, and what an
attacker gains. Remove every real credential and all customer data first.

The maintainers confirm the report, agree on a fix with you, and publish an
advisory with the fix. They credit you in the advisory unless you ask
otherwise.

## Supported versions

Fixes land on `main` and ship in the next release. An earlier release gets
no fix of its own.

## What the default setup does not protect

The defaults suit a local checkout on one machine. Each item below needs a
decision from you before anything reaches a network.

- **The webhook verifies nothing by default.** With `WEBHOOK_SECRET` empty, it
  accepts every request. It binds `127.0.0.1` unless `WEBHOOK_HOST` names
  another interface. Set the secret before you expose the webhook.
- **The webhook and the console refuse a blank interface.** Node binds every
  interface for an empty host, so `WEBHOOK_HOST=` or `CONSOLE_HOST=` stops the
  process instead.
- **The console authenticates nobody itself.** It trusts the header that
  `CONSOLE_IDENTITY_HEADER` names, and serves only a reviewer on the roster
  (DEC-42, DEC-45). Put it behind a proxy that sets that header and strips any
  copy a client sends. In the stack `docker-compose.dev.yml` runs, it shares
  a network with the ledger alone. No other container can send it that header.
  Every process on the host can reach the published port, though.
- **Every published port trusts every local user of the host.** A local user
  can approve replies through the console. The same user can submit tickets
  through a webhook with no secret. They can also log in to the ledger with
  the compose password, and the test mail server accepts any login. On a
  shared host, let only the proxy reach the console and set `WEBHOOK_SECRET`.
  Replace the compose passwords. The `test` profile and its mail server are
  for a single-user machine. On a shared host, stop the server once the tests
  finish: `docker compose --profile test stop mail`.
- **Every published port binds `127.0.0.1`.** The compose files keep the
  ledger, the mail server, the webhook and the console off other machines.
  Change a binding only when a proxy stands in front of the port.
- **The compose passwords are public.** The ledger's password is `auracle`.
  The password of `auracle_reader`, the read-only role, is `auracle_reader`. Set `AURACLE_DB_PASSWORD`
  and `AURACLE_READER_PASSWORD` in the host's `.env` to replace them.
  Postgres reads the ledger's password once, when it creates its data volume.
  So set it before the first `up`, or change the role's password as well.
  Use URL-safe characters only, because the stack's URLs carry both
  passwords unencoded. `openssl rand -hex 24` makes one. A process you start
  from a checkout reads `DATABASE_URL`, so put the same password there too.
- **Every daemon connects as the ledger's superuser.** The compose ledger's
  only role besides `auracle_reader` is `auracle`, a superuser. A fault that
  lets a request run SQL therefore runs it with every right. Give each daemon
  a role of its own before you expose one.
- **Every daemon in the stack `docker-compose.dev.yml` runs reads the whole
  `.env`.** So the
  webhook holds `OPENROUTER_API_KEY` and the mailbox password, though it needs
  neither. Keep that file to the values the stack needs.
- **The test mail server accepts any credentials.** It runs only under the
  compose `test` profile, so a deploy without that profile leaves it out.
- **The ledger stores customer message text.** The README section on the
  compliance position says where, and what you own as the data controller.
